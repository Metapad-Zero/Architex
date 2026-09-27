// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Integration9Base, VmGas5} from "./Integration9Base.sol";

/// @notice Integration review #9, check 4 (regression tests since 39a78b4): what a window buy's in-swap bid costs in
///         gas through Uniswap's V4Router, against a buy after the window and a plain unhooked v4 hop, and what the
///         V4Quoter reports as its gasEstimate for the same swap.
///
///         Since 39a78b4 every window bid starts from the pool's reference (`bidRefTick`, the lowest price any window
///         buy has started from), so a buy that lifts the price, or starts anywhere above the reference, reuses the
///         ticks an earlier bid opened: the usual case. New ticks appear only when a buy starts at a new low at least
///         one tick spacing below the reference, and a new tick-bitmap word only for a pool's very first bid (every
///         curve graduates at the same tick, and the nearest empty word is a price drop of more than 30x below it).
///         `lockHeld` is no longer written and refunded in every window buy, so the gas limit a window buy needs is now
///         close to its receipt.
///
///         Measured per transaction: forge 1.8.1 runs tests with `isolate = true` by default, so every top-level call
///         here is its own transaction (fresh access lists, clean original values, intrinsic gas and refunds applied).
///         Under isolation `receipt` is the transaction's gasUsed after refunds (what the trader pays) and `limit` is
///         the smallest transaction gas limit that succeeds (what eth_estimateGas searches for; the search's
///         `call{gas: g}` runs a transaction whose limit is g + 21,000). With --no-isolate the tests still pass (they
///         only assert orderings and bounds) but the logged numbers undercount stores to slots written earlier in the
///         test.
abstract contract GasProfileTest is Integration9Base {
    using PoolIdLibrary for PoolKey;

    struct Row {
        uint256 receipt;
        uint256 refund;
        uint256 limit;
        uint256 quoterEst;
    }

    function _measure(string memory name, address trader, address token, bytes memory data, uint256 quoterEst)
        internal
        returns (Row memory r)
    {
        r.quoterEst = quoterEst;
        r.limit = _txLimit(trader, token, data);
        _cool(token);
        vm.prank(trader, trader);
        v4r.executeActions(data);
        VmGas5.Gas5 memory g = VmGas5(address(vm)).lastCallGas();
        r.receipt = g.gasTotalUsed;
        r.refund = g.gasRefunded < 0 ? 0 : uint256(int256(g.gasRefunded));
        console2.log(name);
        console2.log("  receipt gasUsed", r.receipt);
        console2.log("  refund applied", r.refund);
        console2.log("  gas limit needed", r.limit);
        console2.log("  V4Quoter gasEstimate", r.quoterEst);
    }

    function _buyPlan(address token, uint256 usdcIn) internal view returns (bytes memory) {
        return _exactInSinglePlan(_key(token), _usdcIs0(token), usdcIn, 0);
    }

    /// @dev The range the next window buy's bid would get from the current price (from the cheaper of it and the
    ///      pool's reference).
    function _nextRange(address token) internal view returns (int24 lo, int24 hi) {
        (, int24 tick) = _slot0(token);
        bool u0 = _usdcIs0(token);
        (lo, hi) = _expectedBid(u0, _cheaperTick(u0, tick, _refTick(token)));
    }

    /// @dev Whether the next window buy's bid would land on ticks that exist, and in bitmap words that hold ticks.
    function _nextBid(address token) internal view returns (bool ticksExist, bool wordsExist) {
        (int24 lo, int24 hi) = _nextRange(token);
        PoolId id = _key(token).toId();
        (uint128 gLo,) = StateLibrary.getTickLiquidity(manager, id, lo);
        (uint128 gHi,) = StateLibrary.getTickLiquidity(manager, id, hi);
        ticksExist = gLo != 0 && gHi != 0;
        uint256 wLo = StateLibrary.getTickBitmap(manager, id, int16((lo / 200) >> 8));
        uint256 wHi = StateLibrary.getTickBitmap(manager, id, int16((hi / 200) >> 8));
        wordsExist = wLo != 0 && wHi != 0;
    }

    /// @dev How far (in ticks) the reference would have to fall below where it is before either tick of a bid placed
    ///      from it leaves the bitmap word it is in: the smallest new low that could open a new word.
    function _ticksToANewWord(address token) internal view returns (uint256) {
        (int24 lo, int24 hi) = _nextRange(token);
        bool u0 = _usdcIs0(token);
        return _min(_toWordEdge(lo, u0), _toWordEdge(hi, u0));
    }

    /// @dev Ticks from `t` (a multiple of 200) to the first tick outside its bitmap word, moving to cheaper prices
    ///      (up with USDC as currency0, down with it as currency1).
    function _toWordEdge(int24 t, bool u0) internal pure returns (uint256) {
        int256 word = int256((t / 200) >> 8);
        if (u0) return uint256((word + 1) * 256 * 200 - int256(t));
        return uint256(int256(t) - word * 256 * 200 + 200);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ─── Baseline ─────────────────────────────────────────────────────────────

    /// @dev A plain v4 hop for comparison: 1,000 USDC into the unhooked OTHER/USDC pool (0.3%, spacing 60), same
    ///      router, same plan, a trader who already holds OTHER.
    function test_gas_plainUnhookedV4Hop() public {
        bool u0 = address(usdc) < address(other);
        vm.prank(bob);
        v4r.executeActions(_exactInSinglePlan(otherKey, u0, 5_000e6, 0)); // an earlier trade in the pool
        (uint256 q, uint256 est) = quoter.quoteExactInputSingle(_single(otherKey, u0, 1_000e6));
        assertGt(q, 0);
        Row memory r = _measure(
            "plain unhooked v4 hop, 1,000 USDC in",
            carol,
            address(other),
            _exactInSinglePlan(otherKey, u0, 1_000e6, 0),
            est
        );
        assertLt(r.receipt, 200_000);
    }

    // ─── Buys after the window ────────────────────────────────────────────────

    function test_gas_buyAfterTheWindow() public {
        address token = _graduatedAfterWindow(100, false);
        _fund(token, carol, 1e18);
        vm.prank(bob);
        router.buy(token, 5_000e6, 0, bob, MAX); // an earlier trade, so the fee slots are not new
        (, uint256 est) = _quoteBuyIn(token, 1_000e6);
        Row memory r = _measure("buy 1,000 USDC after the window (no bid)", carol, token, _buyPlan(token, 1_000e6), est);
        assertLt(r.receipt, 250_000);
    }

    function test_gas_exactOutBuyAfterTheWindow() public {
        address token = _graduatedAfterWindow(100, false);
        _fund(token, carol, 1e18);
        vm.prank(bob);
        router.buy(token, 30_000e6, 0, bob, MAX);
        (, uint256 est) = _quoteBuyOut(token, 1_000_000e18);
        Row memory r = _measure(
            "exact-out buy 1M tokens after the window",
            carol,
            token,
            _exactOutSinglePlan(_key(token), _usdcIs0(token), 1_000_000e18, type(uint128).max),
            est
        );
        assertLt(r.receipt, 250_000);
    }

    // ─── Window buys, by where their bid lands ────────────────────────────────

    /// @dev One pool, window buys by the same trader (who already holds the token, so every case pays the same for the
    ///      token transfer), against the same buy in a twin pool past its window:
    ///      (a) the pool's first buy starts at the graduation tick, the reference: its bid reuses the graduation bid's
    ///          ticks;
    ///      (b) after a 30,000 USDC buy lifted the price well above the reference: the bid still reuses those ticks
    ///          (the usual case since 39a78b4; before it, this buy opened two new ticks and here a new bitmap word);
    ///      (c) after sells took the price to a new low at least one spacing below the reference: two new ticks, in
    ///          words that already hold ticks.
    ///      A new word would need a new low tens of thousands of ticks down (logged and bounded here).
    function test_gas_windowBuysByTickState() public {
        address twin = _graduatedAfterWindow(100, false);
        _fund(twin, carol, 1e18);
        vm.prank(bob);
        router.sell(twin, 1_000e18, 0, bob, MAX); // an earlier trade (no bid), so the fee slots are not new
        (, uint256 e0) = _quoteBuyIn(twin, 1_000e6);
        Row memory none = _measure("(ref) buy 1,000 USDC, no window", carol, twin, _buyPlan(twin, 1_000e6), e0);

        address token = _graduatedInWindow(100, false, 2_000e6);
        _fund(token, carol, 1e18);
        vm.prank(bob);
        router.sell(token, 1_000e18, 0, bob, MAX);

        (bool ticks, bool words) = _nextBid(token);
        assertTrue(ticks && words, "(a) lands on existing ticks");
        (, uint256 ea) = _quoteBuyIn(token, 1_000e6);
        Row memory a = _measure(
            "(a) window buy 1,000 USDC from the reference, existing ticks", carol, token, _buyPlan(token, 1_000e6), ea
        );

        vm.prank(bob);
        router.buy(token, 30_000e6, 0, bob, MAX);
        (ticks, words) = _nextBid(token);
        assertTrue(ticks && words, "(b) a lift does not move the bid: existing ticks");
        (, uint256 eb) = _quoteBuyIn(token, 1_000e6);
        Row memory b = _measure(
            "(b) window buy after a 30,000 USDC lift, existing ticks", carol, token, _buyPlan(token, 1_000e6), eb
        );

        uint256 pushes;
        while (ticks && pushes < 40) {
            vm.prank(bob);
            router.sell(token, 5_000_000e18, 0, bob, MAX);
            (ticks, words) = _nextBid(token);
            pushes++;
        }
        assertFalse(ticks, "(c) a new low opens new ticks");
        assertTrue(words, "(c) in words that already hold ticks");
        (, uint256 ec) = _quoteBuyIn(token, 1_000e6);
        Row memory c = _measure(
            "(c) window buy at a new low, new ticks in existing words", carol, token, _buyPlan(token, 1_000e6), ec
        );
        console2.log("  (sells of 5M tokens to reach a new tick spacing below the reference)", pushes);
        uint256 toWord = _ticksToANewWord(token);
        console2.log("  ticks the reference must still fall before a bid opens a new bitmap word", toWord);

        assertLt(none.receipt, a.receipt, "a bid costs gas");
        assertApproxEqAbs(a.receipt, b.receipt, 2_000, "a lift leaves the bid on the same ticks");
        assertLt(b.receipt, c.receipt, "new ticks cost more than existing ones");
        assertGt(toWord, 30_000, "a new word is a price drop of more than 20x away");
        if (_isolated()) {
            // Per transaction: no refund left, so the limit is the receipt plus the 63/64 reserve of the nested calls.
            assertEq(a.refund, 0, "no refund in a window buy");
            assertLt(a.limit - a.receipt, 10_000, "the limit is within 10k of the receipt");
        }
        console2.log("extra receipt gas over no window: (a), (b), (c)");
        console2.log("  ", a.receipt - none.receipt, b.receipt - none.receipt, c.receipt - none.receipt);
        console2.log("extra gas limit over no window: (a), (b), (c)");
        console2.log("  ", a.limit - none.limit, b.limit - none.limit, c.limit - none.limit);
    }

    /// @dev No graduation bid (the curve had no snipe fee and rounding left nothing), so the pool's first window buy
    ///      also pays for bidCount's first write and for both of its ticks' bitmap words: the most a bid costs.
    function test_gas_firstWindowBuyOfAPoolWithNoGraduationBid() public {
        address token = _graduatedInWindow(0, false, 0);
        assertEq(hook.bidCount(token), 0, "no graduation bid");
        _fund(token, carol, 1e18);
        vm.prank(bob);
        router.sell(token, 1_000e18, 0, bob, MAX);
        (bool ticks, bool words) = _nextBid(token);
        assertFalse(ticks || words, "nothing below the price yet");
        (, uint256 est) = _quoteBuyIn(token, 1_000e6);
        Row memory r =
            _measure("window buy 1,000 USDC, the pool's first bid", carol, token, _buyPlan(token, 1_000e6), est);
        assertLt(r.receipt, 500_000);
    }

    /// @dev An exact-out window buy after a lift: its bid lands on the reference's ticks.
    function test_gas_windowExactOutBuyOnTheReferencesTicks() public {
        address token = _graduatedInWindow(100, false, 2_000e6);
        _fund(token, carol, 1e18);
        vm.prank(bob);
        router.buy(token, 30_000e6, 0, bob, MAX);
        (bool ticks,) = _nextBid(token);
        assertTrue(ticks, "existing ticks");
        (, uint256 est) = _quoteBuyOut(token, 1_000_000e18);
        Row memory r = _measure(
            "window exact-out buy 1M tokens after a lift, existing ticks",
            carol,
            token,
            _exactOutSinglePlan(_key(token), _usdcIs0(token), 1_000_000e18, type(uint128).max),
            est
        );
        assertLt(r.receipt, 400_000);
    }

    // ─── A dump after a busy window ───────────────────────────────────────────

    /// @dev The same ten exact-out buys (so the pool's own price path is identical) inside the window in one pool and
    ///      after it in another, then the same dump through half the starting price. The ten window buys each lift the
    ///      price, so since 39a78b4 all their bids share the reference's range: the dump crosses one bid top, where
    ///      before it crossed ten (bids spread over distinct ticks by buys at new lows are Claude review #9's BidGas).
    function test_gas_aDumpAfterABusyWindow() public {
        address w = _graduatedInWindow(0, false, 0);
        for (uint256 i; i < 10; ++i) {
            _buyOut(carol, w, 8_000_000e18, type(uint128).max);
            _step(1);
        }
        uint256 bidsW = hook.bidCount(w);
        _step(hook.SNIPE_BLOCKS());
        address n = _graduatedAfterWindow(0, false);
        for (uint256 i; i < 10; ++i) {
            _buyOut(carol, n, 8_000_000e18, type(uint128).max);
        }
        assertEq(hook.bidCount(n), 0, "no bids after the window (and no graduation bid here)");
        _fund(w, erin, 300_000_000e18);
        _fund(n, erin, 300_000_000e18);
        uint256 dump = 250_000_000e18;
        (, uint256 estW) = _quoteSellIn(w, dump);
        Row memory rw = _measure(
            "dump 250M tokens after ten window buys (one shared bid range)",
            erin,
            w,
            _exactInSinglePlan(_key(w), !_usdcIs0(w), dump, 0),
            estW
        );
        (, uint256 estN) = _quoteSellIn(n, dump);
        Row memory rn =
            _measure("same dump, no bids", erin, n, _exactInSinglePlan(_key(n), !_usdcIs0(n), dump, 0), estN);
        console2.log("  window bids placed", bidsW);
        assertEq(bidsW, 10, "ten bids");
        assertGt(rw.receipt, rn.receipt, "crossing the shared bid top costs a little");
        assertLt(rw.receipt - rn.receipt, 40_000, "one bid top, not ten");
    }
}

contract GasProfileUsdcLowTest is GasProfileTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract GasProfileUsdcHighTest is GasProfileTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
