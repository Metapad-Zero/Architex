// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {DeepenReviewBase} from "./DeepenReviewBase.sol";
import {Settler, Book} from "./CapInflationSettle.t.sol";

/// @notice The fix for H1: in the pool, Deepen pool's cap is 0.25% of the LOCKED part of the pool's USDC reserve,
///         reserve * LP at 0x…dEaD / LP supply. These pin what that base is and is not moved by, and hold the attack to
///         a loss in the cases CapInflationSettle.t.sol does not reach: a pool that has shrunk well below its size at
///         graduation (a base capped at the graduation seed could still be parked back up to that seed there; the
///         locked base cannot be parked up at all), and any mix of push, park and creator fee.
contract DeepenCapBaseTest is DeepenReviewBase {
    address internal token;
    address internal pair;

    function _setUpToken(uint16 creatorFeeBps) internal {
        token = _graduatedToken(creatorFeeBps, 5_000, 0);
        pair = pad.pairOf(token);
    }

    /// @dev What the fixed plugin should offer after a full interval: 0.25% of the locked part, capped by the pot.
    function _lockedCap() internal view returns (uint256) {
        (, uint256 rU) = _reserves(token);
        uint256 locked = Math.mulDiv(rU, IERC20(pair).balanceOf(DEAD), IERC20(pair).totalSupply());
        return locked * 25 / 10_000;
    }

    function _offer() internal view returns (uint256 offer) {
        (offer,,,) = deepen.previewRun(token);
    }

    // ─── What the base is ─────────────────────────────────────────────────────

    /// @dev A pool nobody else has added to is all locked, so the cap is exactly the old one: 0.25% of the reserve.
    function test_anUntouchedPoolKeepsTheWholeReserveAsItsBase() public {
        _setUpToken(100);
        _topUp(token, 1_000_000e6);
        (, uint256 rU) = _reserves(token);
        assertEq(IERC20(pair).balanceOf(DEAD), IERC20(pair).totalSupply(), "graduation locked every LP");
        assertEq(_offer(), rU * 25 / 10_000, "the offer is 0.25% of the whole reserve, as before the fix");
    }

    /// @dev Honest liquidity from someone else, held for days, still counts for nothing: it can leave at any time.
    function test_outsideLiquidityDoesNotRaiseTheCap() public {
        _setUpToken(100);
        _topUp(token, 1_000_000e6);
        uint256 before = _offer();
        vm.prank(bob); // bob bought the curve out, so he holds tokens
        IERC20(token).transfer(lp, 400_000_000e18);
        (, uint256 rU) = _reserves(token);
        _addLiquidity(token, lp, rU * 2); // twice the pool
        _step(3 days);
        assertGt(IERC20(pair).balanceOf(lp), 0, "lp holds LP");
        assertApproxEqAbs(_offer(), before, 1, "the offer is unchanged");
        assertEq(_offer(), _lockedCap(), "and is 0.25% of the locked part");
    }

    /// @dev LP given to 0x…dEaD is locked for good, so it counts, in proportion.
    function test_lpSentToDeadCountsInProportion() public {
        _setUpToken(100);
        _topUp(token, 1_000_000e6);
        vm.prank(bob);
        IERC20(token).transfer(lp, 400_000_000e18);
        (, uint256 rU) = _reserves(token);
        uint256 minted = _addLiquidity(token, lp, rU);
        uint256 withLp = _offer();
        vm.prank(lp);
        IERC20(pair).transfer(DEAD, minted / 2);
        uint256 after_ = _offer();
        assertGt(after_, withLp, "a gift to 0x...dEaD raises the cap");
        assertEq(after_, _lockedCap(), "by exactly the locked share it adds");
    }

    // ─── A shrunk pool ────────────────────────────────────────────────────────

    /// @dev Holders sell most of the float back into the pool, so its USDC side falls to a quarter of what graduation
    ///      left. A base taken from the live reserve, capped at the graduation seed, could then be inflated back up to
    ///      the seed by parking; the locked base cannot. Push, park and run, at every creator fee, from that pool.
    function test_aShrunkPoolCannotBeInflatedBackUp() public {
        uint16[4] memory fees = [uint16(0), 50, 100, 1_000];
        for (uint256 f; f < fees.length; ++f) {
            uint256 snap = vm.snapshotState();
            _setUpToken(fees[f]);
            (, uint256 seed) = _reserves(token);
            // bob holds the 800M tokens the curve sold; 600M of them come back.
            vm.prank(bob);
            router.sell(token, 600_000_000e18, 0, bob, block.timestamp);
            (, uint256 shrunk) = _reserves(token);
            assertLt(shrunk * 3, seed, "the pool's USDC side is well below the graduation seed");
            _topUp(token, 200_000e6);
            _step(HOUR);
            uint256 honest = _offer();

            Settler atk = new Settler(address(deepen), address(pad), address(router), pair, token, address(usdc));
            usdc.mint(address(atk), 10_000_000_000e6);
            int256 best = type(int256).min;
            // Up to 1M USDC, 160 times the shrunk pool: parking a bigger push needs more than the attacker's 10 billion.
            uint256[6] memory pushes = [uint256(500e6), 2_000e6, 10_000e6, 50_000e6, 250_000e6, 1_000_000e6];
            for (uint256 i; i < pushes.length; ++i) {
                uint256 s2 = vm.snapshotState();
                int256 pnl = atk.attack(pushes[i], true, true, false);
                Book memory b = atk.book();
                vm.revertToState(s2);
                // A push of b lifts the pool's USDC side, and so the locked part, from R to at most R + b (the
                // square root of the price move); the park adds nothing. So one run spends at most honest * (R + b) / R.
                assertLe(b.potSpent, honest * (pushes[i] + shrunk) / shrunk + 1, "bounded by the push alone");
                if (pnl > best) best = pnl;
            }
            emit log_named_uint("creator fee bps", fees[f]);
            emit log_named_uint("  pool USDC side, graduation", seed);
            emit log_named_uint("  pool USDC side, shrunk    ", shrunk);
            emit log_named_uint("  honest offer              ", honest);
            emit log_named_int("  best attack P&L           ", best);
            assertLt(best, 0, "no push pays in a shrunk pool");
            vm.revertToState(snap);
        }
    }

    // ─── Any mix ──────────────────────────────────────────────────────────────

    /// @dev An attacker who starts with USDC only: push by `pushUsdc`, park all or none of the bag, run, unpark, sell
    ///      everything. Whatever the push, the park and the creator fee, it never comes out ahead.
    function testFuzz_pushParkRunNeverPays(uint64 pushUsdc, bool park, uint16 creatorFeeBps, uint32 potUsdc) public {
        creatorFeeBps = uint16(bound(creatorFeeBps, 0, 1_000));
        // Up to 5M USDC: with the bag parked, a bigger push needs more than the attacker's 10 billion.
        uint256 push = bound(pushUsdc, 1e6, 5_000_000e6);
        uint256 pot = bound(potUsdc, 3, 5_000_000) * 1e6;
        _setUpToken(creatorFeeBps);
        _topUp(token, pot);
        _step(HOUR);
        Settler atk = new Settler(address(deepen), address(pad), address(router), pair, token, address(usdc));
        usdc.mint(address(atk), 10_000_000_000e6);
        int256 pnl = atk.attack(push, park, true, false);
        assertLt(pnl, 0, "USDC in, less USDC out");
    }
}
