// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "./launchpad/LaunchpadV13Base.sol";

/// @notice streamRate() and streamEnd() report the stream as it stands now: 0 and the stored end before and after a
///         stream, 0 and an end that keeps moving out while it is paused (the end the next accrual will write).
///         This contract deploys the token, so it is the launchpad: its balance is the excluded inventory.
contract LaunchTokenStreamViewsTest is Test {
    uint256 constant PERIOD = 24 hours;
    uint256 constant AMOUNT = 86_400e6; // 1 USDC a second over a day

    BlockableUSDC usdc;
    LaunchToken token;
    address pair = makeAddr("pair");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address payer = makeAddr("payer");

    function setUp() public {
        usdc = new BlockableUSDC();
        token = new LaunchToken("Dividend", "DIV", address(usdc), makeAddr("router"));
        token.initPair(pair);
        usdc.mint(payer, 1_000_000e6);
        vm.prank(payer);
        usdc.approve(address(token), type(uint256).max);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _distribute(uint256 amount) internal {
        vm.prank(payer);
        token.distribute(amount);
    }

    function test_beforeAnyDistribute_rateAndEndAreZero() public view {
        assertEq(token.streamRate(), 0);
        assertEq(token.streamEnd(), 0);
    }

    function test_running_reportsTheRateAndTheEnd() public {
        token.transfer(alice, 1_000e18);
        _distribute(AMOUNT);
        uint256 end = _now() + PERIOD;
        assertEq(token.streamRate(), 1e6, "1 USDC a second");
        assertEq(token.streamEnd(), end);

        vm.warp(_now() + 6 hours);
        assertEq(token.streamRate(), 1e6);
        assertEq(token.streamEnd(), end);
    }

    function test_ended_rateIsZeroAndEndStays() public {
        token.transfer(alice, 1_000e18);
        _distribute(AMOUNT);
        uint256 end = _now() + PERIOD;

        vm.warp(end); // the stream pays nothing from its end on
        assertEq(token.streamRate(), 0);
        assertEq(token.streamEnd(), end);

        vm.warp(end + 3 days);
        assertEq(token.streamRate(), 0);
        assertEq(token.streamEnd(), end);
        assertEq(token.undistributed(), 0);
    }

    function test_paused_rateIsZeroAndTheEndMovesOutWithTime() public {
        token.transfer(alice, 1_000e18);
        _distribute(AMOUNT);
        uint256 storedEnd = _now() + PERIOD;

        vm.warp(_now() + 6 hours);
        vm.prank(alice);
        token.transfer(address(this), 1_000e18); // everyone out: back into the excluded inventory
        assertEq(token.eligibleSupply(), 0);
        assertEq(token.streamRate(), 0, "paused pays nothing");
        assertEq(token.streamEnd(), storedEnd, "no time paused yet");

        vm.warp(_now() + 10 hours);
        uint256 predicted = token.streamEnd();
        assertEq(predicted, storedEnd + 10 hours, "the end as of now");
        assertEq(token.streamRate(), 0);

        // The next accrual (here: a holder arriving) writes exactly the end the view predicted, and the rate is back.
        token.transfer(bob, 1_000e18);
        assertEq(token.streamEnd(), predicted);
        assertEq(token.lastAccrual(), _now());
        assertEq(token.streamRate(), 1e6);
    }

    function testFuzz_pausedEndViewMatchesTheNextAccrual(uint32 runFor, uint32 pausedFor) public {
        uint256 run = bound(uint256(runFor), 1, PERIOD - 1);
        uint256 paused = bound(uint256(pausedFor), 0, 30 days);
        token.transfer(alice, 1_000e18);
        _distribute(AMOUNT);

        vm.warp(_now() + run);
        vm.prank(alice);
        token.transfer(address(this), 1_000e18);
        vm.warp(_now() + paused);

        uint256 predicted = token.streamEnd();
        token.transfer(bob, 1_000e18);
        assertEq(token.streamEnd(), predicted);
        assertGt(token.streamRate(), 0, "running again");
    }
}
