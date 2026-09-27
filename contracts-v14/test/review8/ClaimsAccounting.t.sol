// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Review8Base, ClaimsActor} from "./Review8Base.sol";

/// @notice Claude review #8, the hook's ERC-6909 USDC claims.
///         Holds: nobody else can burn or move them (the hook never sets an operator or an allowance), and every mint and
///         burn the hook makes is matched to a per-token book, so release and bids only ever spend what they track.
///         Informational: anyone can ADD claims to the hook's balance (mint to it inside their own unlock, or an
///         ERC-6909 transfer). Those claims are owed to nobody, no code path can spend them, and "the hook's claims are
///         exactly what it owes" (V14-SPEC §11, the invariant tests) becomes "at least".
abstract contract ClaimsAccountingTest is Review8Base {
    ClaimsActor internal actor;

    function setUp() public override {
        super.setUp();
        actor = new ClaimsActor(manager, IERC20(address(usdc)));
        usdc.mint(address(actor), 10_000e6);
    }

    function test_nobodyElseCanBurnOrMoveTheHooksClaims() public {
        address token = _graduated(300, false);
        vm.prank(carol);
        router.buy(token, 1_000e6, 0, carol, MAX);
        uint256 claims = _hookClaims();
        assertGt(claims, 0);

        vm.expectRevert(); // allowance underflow: the hook never approved anyone
        actor.burnFrom(address(hook), 1);
        vm.prank(carol);
        vm.expectRevert();
        manager.transferFrom(address(hook), carol, _usdcId(), 1);
        assertFalse(manager.isOperator(address(hook), address(pad)));
        assertEq(manager.allowance(address(hook), address(pad), _usdcId()), 0);
        assertEq(_hookClaims(), claims);
        _assertHookClean(token);
    }

    /// @dev Two tokens share one claims balance; each exit spends only its own token's books.
    function test_noLeakAcrossTokens() public {
        address a = _graduateWithCurveSnipe(300, false, dave, 0);
        vm.prank(carol);
        router.buy(a, 4_000e6, 0, carol, MAX); // a's opening window
        address b = _graduateWithCurveSnipe(100, true, dave, 0);
        vm.prank(carol);
        router.buy(b, 6_000e6, 0, carol, MAX); // b's opening window
        _step(hook.SNIPE_BLOCKS());

        uint256 aP = hook.pendingPlatform(a);
        uint256 aC = hook.pendingCreator(a);
        uint256 aL = hook.lockHeld(a);
        uint256 claims = _hookClaims();

        // Both windows' surcharges became bids inside their buys; b's release moves only b's books, and exactly that
        // many claims.
        assertLe(aL, 2, "a's surcharge is a bid");
        uint256 bLeft = hook.lockHeld(b);
        assertLe(bLeft, 2, "b's surcharge is a bid");
        (uint256 bp, uint256 bc) = pad.syncPoolFees(b);
        assertEq(claims - _hookClaims(), bp + bc);
        assertEq(hook.pendingPlatform(a), aP);
        assertEq(hook.pendingCreator(a), aC);
        assertEq(hook.lockHeld(a), aL);
        assertEq(_hookClaims(), aP + aC + aL + bLeft);
        _assertHookClean(a);
        _assertSolvent();
    }

    function test_claimsSentToTheHookAreOwedToNobodyAndStuck() public {
        address token = _graduated(300, false);
        vm.prank(carol);
        router.buy(token, 1_000e6, 0, carol, MAX);
        _assertHookClean(token);

        actor.mintTo(address(hook), 1_000e6); // 1,000 USDC of claims, from a third party
        uint256 owed = hook.pendingPlatform(token) + hook.pendingCreator(token) + hook.lockHeld(token);
        assertEq(_hookClaims(), owed + 1_000e6, "claims exceed what the hook owes");

        // Every exit spends only what is booked: after a sync nothing is owed, and the extra claims stay put for good.
        pad.syncPoolFees(token);
        assertEq(hook.pendingPlatform(token) + hook.pendingCreator(token) + hook.lockHeld(token), 0);
        assertEq(_hookClaims(), 1_000e6, "stuck: no function spends unbooked claims");
        _assertSolvent();
    }
}

contract ClaimsAccountingUsdcLowTest is ClaimsAccountingTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract ClaimsAccountingUsdcHighTest is ClaimsAccountingTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
