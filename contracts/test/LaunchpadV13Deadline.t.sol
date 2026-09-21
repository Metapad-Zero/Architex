// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./launchpad/LaunchpadV13Base.sol";

/// @notice The curve's buy and sell take a deadline and revert Expired when block.timestamp > deadline, the launch
///         router's rule (V13-SPEC §5). v1.2's curve ABI had none. createToken's first buy takes none: it runs in the
///         launch transaction itself.
contract LaunchpadDeadlineTest is LaunchpadV13Base {
    uint256 internal constant NOW = 1_700_000_000;

    address internal token;
    uint256 internal held;

    function setUp() public override {
        super.setUp();
        vm.warp(NOW);
        token = _create(300, creatorWallet);
        vm.prank(alice);
        (held,) = pad.buy(token, 1_000e6, 0, alice, NOW);
    }

    function test_buy_revertsAfterTheDeadline() public {
        vm.prank(bob);
        vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        pad.buy(token, 100e6, 0, bob, NOW - 1);
        assertEq(IERC20(token).balanceOf(bob), 0);
    }

    function test_sell_revertsAfterTheDeadline() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        pad.sell(token, held, 0, alice, NOW - 1);
        assertEq(IERC20(token).balanceOf(alice), held);
    }

    function test_deadlineEqualToNowPasses() public {
        vm.prank(bob);
        (uint256 got,) = pad.buy(token, 100e6, 0, bob, NOW);
        assertGt(got, 0);
        vm.prank(bob);
        assertGt(pad.sell(token, got, 0, bob, NOW), 0);
        _assertSolvent();
    }

    /// @dev A transaction signed with a deadline that is mined late: fine up to the deadline, Expired a second after.
    function test_aDelayedTradeExpires() public {
        uint256 deadline = NOW + 20 minutes;
        vm.warp(deadline);
        vm.prank(bob);
        pad.buy(token, 100e6, 0, bob, deadline);
        vm.warp(deadline + 1);
        vm.prank(bob);
        vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        pad.buy(token, 100e6, 0, bob, deadline);
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        pad.sell(token, held, 0, alice, deadline);
    }

    /// @dev The deadline is checked first, as in the router: an expired trade reverts Expired whatever else is wrong.
    function test_expiredIsCheckedFirst() public {
        vm.startPrank(bob);
        vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        pad.buy(address(0xBEEF), 0, 0, bob, NOW - 1);
        vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        pad.sell(address(0xBEEF), 0, 0, bob, NOW - 1);
        vm.stopPrank();
    }

    function testFuzz_deadline(uint256 deadline, bool isBuy) public {
        vm.prank(isBuy ? bob : alice);
        if (deadline < NOW) vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        if (isBuy) pad.buy(token, 100e6, 0, bob, deadline);
        else pad.sell(token, held, 0, alice, deadline);
    }

    /// @dev createToken's first buy has no deadline of its own: the launch transaction is the trade.
    function test_createTokensFirstBuyTakesNoDeadline() public {
        vm.warp(NOW + 365 days);
        vm.prank(alice);
        address t = pad.createToken("Later", "LATE", "", 100, creatorWallet, "", 50e6, 1, type(uint256).max);
        assertGt(IERC20(t).balanceOf(alice), 0);
    }

    /// @dev Quotes take no deadline: they are views.
    function test_quotesAreUnaffected() public view {
        (uint256 tokensOut,,,,) = pad.quoteBuy(token, 100e6);
        assertGt(tokensOut, 0);
        (uint256 usdcOut,,) = pad.quoteSell(token, held);
        assertGt(usdcOut, 0);
    }
}
