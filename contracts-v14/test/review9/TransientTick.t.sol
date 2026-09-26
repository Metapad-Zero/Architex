// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Review9Base, MultiFlash} from "./Review9Base.sol";

/// @notice Claude review #9 (holds): the transient pre-swap tick.
///         `_beforeSwap` writes `_tickBeforeBuy` exactly when the swap is a buy and the window's rate is not 0, and
///         `_afterSwap` reads it exactly when the swap's snipe fee is not 0, which (sells use rate 0, and the rate is a
///         function of the block alone) implies the same condition in the same block. Nothing but the PoolManager's own
///         swap math runs between the two calls, so every read is of the value this swap's own beforeSwap wrote.
///         Since review #9's L1 fix a bid starts from the cheaper of that tick and the pool's reference (the lowest price
///         any window buy has started from, graduation's to begin with), so a buy made above that reference shows nothing
///         of its own tick. The unlock below therefore makes every buy start at a new low for its pool (a sell first),
///         where the bid must come from the buy's own pre-swap tick, and alternates pools so a stale read would be a
///         crossed one.
///         Proven on the real PoolManager: one unlock that interleaves exact-in and exact-out buys, sells and a partial
///         fill stopped by a price limit, across two pools opened in the same block; and at the window's last block,
///         exact-out buys whose snipe fee rounds to 0 (no bid, no read).
abstract contract TransientTickTest is Review9Base {
    struct Seen {
        uint256 trades;
        bool pendingBid;
        address bidToken;
        int24 lower;
        int24 upper;
        bool hasLast; // a buy with a snipe fee came before (its pre-swap tick is the value a stale read would return)
        int24 lastPre;
        int24 refA; // each pool's reference, tracked the way the hook tracks it
        int24 refB;
    }

    /// @dev Walks the unlock's logs: each PoolTrade closes one swap (the hook emits it last in afterSwap). A swap that
    ///      paid a snipe fee must have exactly one BidLocked since the previous PoolTrade, for its own token, at the range
    ///      from the cheaper of ITS pre-swap tick and its pool's reference so far; any other swap none. Also counts the
    ///      bids whose reference is the buy's own tick, and those whose range a stale read would have changed.
    function _checkEveryBid(
        MultiFlash.Step[] memory steps,
        int24[] memory pre,
        Vm.Log[] memory logs,
        address[] memory tokenOf,
        address a,
        address b
    ) internal view returns (uint256 bids, uint256 ownTick, uint256 sensitive) {
        Seen memory s;
        // Both pools opened fresh: no window buy has moved their reference from the graduation tick before this unlock.
        (s.refA, s.refB) = (_gradTick(a), _gradTick(b));
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook) || logs[i].topics.length < 2) continue;
            address token = address(uint160(uint256(logs[i].topics[1])));
            if (logs[i].topics[0] == BID_LOCKED) {
                assertFalse(s.pendingBid, "at most one bid per swap");
                (,, s.lower, s.upper) = abi.decode(logs[i].data, (uint256, uint128, int24, int24));
                (s.pendingBid, s.bidToken) = (true, token);
            } else if (logs[i].topics[0] == POOL_TRADE) {
                // Skip steps that did not swap (a sellAll with nothing to sell).
                while (s.trades < steps.length && (tokenOf[s.trades] != token || pre[s.trades] == type(int24).min)) {
                    ++s.trades;
                }
                require(s.trades < steps.length, "unmatched trade");
                (,,,,, uint256 snipe) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256));
                if (snipe != 0) {
                    assertTrue(s.pendingBid, "a snipe fee places a bid");
                    assertEq(s.bidToken, token, "for the same token");
                    bool u0 = steps[s.trades].usdcIs0;
                    int24 refBefore = token == a ? s.refA : s.refB;
                    int24 ref = _cheaper(u0, pre[s.trades], refBefore);
                    (int24 lo, int24 hi) = _rangeFrom(u0, ref);
                    assertEq(s.lower, lo, "lower from this swap's own pre-swap tick (or the pool's reference)");
                    assertEq(s.upper, hi, "upper from this swap's own pre-swap tick (or the pool's reference)");
                    ++bids;
                    if (ref == pre[s.trades] && ref != refBefore) ++ownTick;
                    if (s.hasLast) {
                        (int24 staleLo,) = _rangeFrom(u0, _cheaper(u0, s.lastPre, refBefore));
                        if (staleLo != lo) ++sensitive;
                    }
                    if (token == a) s.refA = ref;
                    else s.refB = ref;
                    (s.hasLast, s.lastPre) = (true, pre[s.trades]);
                } else {
                    assertFalse(s.pendingBid, "no snipe fee, no bid");
                }
                s.pendingBid = false;
                ++s.trades;
            }
        }
    }

    function test_everyBidInOneUnlockUsesItsOwnSwapsPreSwapTick() public {
        (address a, address b) = _twoPoolsOpenTogether(0, 300); // the opening block of both pools: 90%
        usdc.mint(address(mflash), 10_000_000e6);
        vm.startPrank(bob);
        IERC20(a).transfer(address(mflash), 150_000_000e18);
        IERC20(b).transfer(address(mflash), 250_000_000e18);
        vm.stopPrank();
        bool ub = _usdcIs0(b);
        // A price limit for B's partial fill: 4,000 ticks cheaper than its graduation price.
        int24 limitB = ub ? _gradTick(b) + 4_000 : _gradTick(b) - 4_000;

        // Every buy starts at a new low for its pool (a sell before it), and the pools alternate.
        MultiFlash.Step[] memory steps = new MultiFlash.Step[](12);
        address[] memory tokenOf = new address[](12);
        steps[0] = _mstep(a, _sellIn(a, 30_000_000e18));
        steps[1] = _mstep(a, _buyIn(a, 10_000e6)); // exact-in buy from A's own new low
        steps[2] = _mstep(b, _sellIn(b, 45_000_000e18));
        steps[3] = _mstep(b, _buyExactOut(b, 5_000_000e18)); // exact-out buy, the other pool
        steps[4] = _mstep(a, _sellIn(a, 60_000_000e18));
        steps[5] = _mstep(a, _buyIn(a, 1_000e6));
        steps[6] = _mstep(b, _sellIn(b, 70_000_000e18));
        // exact-out buy of 80M stopped by a price limit: a partial fill from B's own new low
        steps[7] = _mstep(b, SwapParams(ub, int256(80_000_000e18), TickMath.getSqrtPriceAtTick(limitB)));
        steps[8] = _mstep(b, _sellIn(b, 110_000_000e18));
        steps[9] = _mstep(b, _buyIn(b, 1_000e6));
        steps[10] = _mstep(a, _sellIn(a, 40_000_000e18));
        steps[11] = _mstep(a, _buyExactOut(a, 1e18)); // a one-token exact-out buy
        for (uint256 i; i < 12; ++i) {
            tokenOf[i] = (i >= 2 && i <= 3) || (i >= 6 && i <= 9) ? b : a;
        }
        Currency[] memory cs = new Currency[](3);
        cs[0] = Currency.wrap(address(usdc));
        cs[1] = Currency.wrap(a);
        cs[2] = Currency.wrap(b);

        vm.recordLogs();
        int24[] memory pre = mflash.run(steps, cs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 bids, uint256 ownTick, uint256 sensitive) = _checkEveryBid(steps, pre, logs, tokenOf, a, b);
        assertEq(bids, 6, "every buy placed its own bid (6 buys, 6 sells)");
        assertEq(ownTick, 6, "each from the buy's own tick, a new low for its pool");
        // And the test can tell: for the five buys after the first, the previous buy's pre-swap tick (from the other
        // pool: a crossed or stale read) would have given a different range.
        assertEq(sensitive, 5, "a stale or crossed read would have shown");
        // Step 7 (B's fourth trade) really was a partial fill: fewer than the 80M tokens asked for.
        uint256 bTrades;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook) || !_is(logs[i], POOL_TRADE, b)) continue;
            if (++bTrades == 4) {
                (,, uint256 tokensOut,,, uint256 snipe) =
                    abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256));
                assertLt(tokensOut, 80_000_000e18, "stopped by its price limit");
                assertGt(snipe, 0, "and still paid (and placed) a snipe fee on what it filled");
            }
        }
        assertEq(_refOf(a), _cheaper(_usdcIs0(a), pre[11], pre[5]), "A's reference: its lowest buy");
        assertEq(_refOf(b), _cheaper(ub, pre[9], pre[7]), "B's reference: its lowest buy");
        assertLe(hook.lockHeld(a), 2);
        assertLe(hook.lockHeld(b), 2);
        _assertHookClean(a);
        _assertSolvent();
    }

    /// @dev Block 19 of 20 (4.5%): an exact-out buy needing at most 19 units of USDC pays total fees of 1 unit, all of it
    ///      platform fee, so its snipe fee is 0 and it places nothing; with a creator fee, a total of 2 does the same. The
    ///      next ordinary buy in the same unlock places its bid as usual (here from the graduation price: the pools have
    ///      not traded, so the pre-swap tick is the graduation tick).
    function test_aSnipeFeeRoundedToZeroPlacesNothingAndTheNextBuyIsUnaffected() public {
        (address a, address b) = _twoPoolsOpenTogether(0, 1000);
        _step(19);
        assertEq(hook.snipeBpsOf(a), 450);
        usdc.mint(address(mflash), 1_000_000e6);
        MultiFlash.Step[] memory steps = new MultiFlash.Step[](4);
        address[] memory tokenOf = new address[](4);
        steps[0] = _mstep(a, _buyExactOut(a, 1e14)); // 0.0001 token: a few units of USDC
        steps[1] = _mstep(b, _buyExactOut(b, 1e14));
        steps[2] = _mstep(a, _buyIn(a, 500e6));
        steps[3] = _mstep(b, _buyIn(b, 500e6));
        (tokenOf[0], tokenOf[1], tokenOf[2], tokenOf[3]) = (a, b, a, b);
        Currency[] memory cs = new Currency[](3);
        cs[0] = Currency.wrap(address(usdc));
        cs[1] = Currency.wrap(a);
        cs[2] = Currency.wrap(b);
        uint256 bidsA = hook.bidCount(a);
        uint256 bidsB = hook.bidCount(b);

        vm.recordLogs();
        int24[] memory pre = mflash.run(steps, cs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // The two dust buys paid no snipe fee (read from their PoolTrade events).
        uint256 zeroSnipes;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook) || logs[i].topics[0] != POOL_TRADE) continue;
            (, uint256 gross,,,, uint256 snipe) =
                abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256));
            if (gross < 100 && snipe == 0) ++zeroSnipes;
        }
        assertEq(zeroSnipes, 2, "both dust exact-out buys rounded their snipe fee to 0");
        (uint256 placed,,) = _checkEveryBid(steps, pre, logs, tokenOf, a, b);
        assertEq(placed, 2, "only the two ordinary buys placed bids");
        assertEq(hook.bidCount(a), bidsA + 1);
        assertEq(hook.bidCount(b), bidsB + 1);
    }
}

contract TransientTickUsdcLowTest is TransientTickTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract TransientTickUsdcHighTest is TransientTickTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
