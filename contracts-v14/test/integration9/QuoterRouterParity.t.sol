// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {Integration9Base} from "./Integration9Base.sol";

/// @notice Integration review #9, check 1 (regression tests since 39a78b4): Uniswap's V4Quoter against fills through
///         Uniswap's V4Router, for all four swap kinds (exact in and out, buy and sell), USDC as currency0 and as
///         currency1, inside the pool's snipe window and after it. A window buy adds a liquidity position inside its
///         own afterSwap and may lower the pool's bid reference; the quoter runs that same code and reverts, so the
///         question is whether its revert-and-decode flow survives the add, leaves nothing behind (the reference
///         included), and returns exactly what the fill then gives, fees and bid included.
abstract contract QuoterRouterParityTest is Integration9Base {
    struct Before {
        uint256 platform;
        uint256 creator;
        uint256 lockHeld;
        uint256 bids;
        int24 tick;
        int24 ref;
    }

    function _before(address token) internal view returns (Before memory b) {
        b.platform = hook.pendingPlatform(token);
        b.creator = hook.pendingCreator(token);
        b.lockHeld = hook.lockHeld(token);
        b.bids = hook.bidCount(token);
        (, b.tick) = _slot0(token);
        b.ref = _refTick(token);
    }

    /// @dev After one swap: the fees the hook booked equal the PoolTrade event's; a buy inside the window placed
    ///      exactly one bid holding the whole snipe fee (plus or minus the rounding carried in lockHeld), from half of
    ///      the cheaper of the tick before it and the pool's reference, which moved there; anything else placed none
    ///      and left the reference where it was.
    function _checkFeesAndBid(address token, Before memory b, Vm.Log[] memory logs, bool expectBid)
        internal
        view
        returns (Trade memory t)
    {
        Trade[] memory trades = _trades(logs, token);
        assertEq(trades.length, 1, "one PoolTrade");
        t = trades[0];
        assertEq(hook.pendingPlatform(token) - b.platform, t.platformFee, "platform fee booked = event");
        assertEq(hook.pendingCreator(token) - b.creator, t.creatorFee, "creator fee booked = event");
        Bid[] memory bids = _bids(logs, token);
        if (!expectBid) {
            assertEq(bids.length, 0, "no bid");
            assertEq(t.snipeFee, 0, "no snipe fee");
            assertEq(hook.bidCount(token), b.bids, "no new position");
            assertEq(_refTick(token), b.ref, "the reference does not move");
            return t;
        }
        assertEq(bids.length, 1, "one bid");
        assertGt(t.snipeFee, 0, "a snipe fee");
        assertEq(hook.bidCount(token), b.bids + 1, "fresh salt");
        assertEq(bids[0].usdc, b.lockHeld + t.snipeFee - hook.lockHeld(token), "the whole snipe fee became the bid");
        assertLe(hook.lockHeld(token), 2, "nothing waits");
        int24 ref = _cheaperTick(_usdcIs0(token), b.tick, b.ref);
        (int24 lo, int24 hi) = _expectedBid(_usdcIs0(token), ref);
        assertEq(bids[0].lower, lo, "bid from the cheaper of the tick before this swap and the reference (lower)");
        assertEq(bids[0].upper, hi, "bid from the cheaper of the tick before this swap and the reference (upper)");
        assertEq(_refTick(token), ref, "the reference moved to it (or stayed)");
    }

    function _feesOnGross(uint256 gross, uint256 bps) internal pure returns (uint256) {
        return _ceil(gross * bps, 1e4);
    }

    /// @dev All four kinds, each quoted then filled in the same block, checking the quote left no trace.
    function _checkAllFour(address token, uint16 creatorBps) internal {
        uint256 snipeBps = hook.snipeBpsOf(token);
        bool window = snipeBps != 0;

        // Exact-in buy.
        {
            uint256 usdcIn = 1_000e6;
            bytes32 s0 = _hookState(token);
            (uint256 q,) = _quoteBuyIn(token, usdcIn);
            assertEq(_hookState(token), s0, "a quote leaves no trace (exact-in buy)");
            Before memory b = _before(token);
            vm.recordLogs();
            uint256 got = _buyIn(carol, token, usdcIn, q);
            assertEq(got, q, "exact-in buy: fill == quote");
            Trade memory t = _checkFeesAndBid(token, b, vm.getRecordedLogs(), window);
            assertEq(t.usdcAmount, usdcIn, "gross = what the trader paid");
            assertEq(t.platformFee, _feesOnGross(usdcIn, 50), "platform fee on the gross");
            assertEq(t.creatorFee, _feesOnGross(usdcIn, creatorBps), "creator fee on the gross");
            assertEq(t.snipeFee, _feesOnGross(usdcIn, snipeBps), "snipe fee on the gross");
        }
        // Exact-in sell.
        {
            uint256 tokensIn = 2_000_000e18;
            bytes32 s0 = _hookState(token);
            (uint256 q,) = _quoteSellIn(token, tokensIn);
            assertEq(_hookState(token), s0, "a quote leaves no trace (exact-in sell)");
            Before memory b = _before(token);
            vm.recordLogs();
            uint256 got = _sellIn(carol, token, tokensIn, q);
            assertEq(got, q, "exact-in sell: fill == quote");
            Trade memory t = _checkFeesAndBid(token, b, vm.getRecordedLogs(), false);
            assertEq(t.usdcAmount - t.platformFee - t.creatorFee, got, "trader got the gross less the fees");
            assertEq(t.platformFee, _feesOnGross(t.usdcAmount, 50), "platform fee on the gross");
            assertEq(t.creatorFee, _feesOnGross(t.usdcAmount, creatorBps), "creator fee on the gross");
        }
        // Exact-out buy.
        {
            uint256 tokensOut = 3_000_000e18;
            bytes32 s0 = _hookState(token);
            (uint256 q,) = _quoteBuyOut(token, tokensOut);
            assertEq(_hookState(token), s0, "a quote leaves no trace (exact-out buy)");
            Before memory b = _before(token);
            vm.recordLogs();
            uint256 paid = _buyOut(carol, token, tokensOut, q);
            assertEq(paid, q, "exact-out buy: fill == quote");
            Trade memory t = _checkFeesAndBid(token, b, vm.getRecordedLogs(), window);
            assertEq(t.usdcAmount, paid, "gross = what the trader paid");
            uint256 net = paid - t.platformFee - t.creatorFee - t.snipeFee;
            uint256 r = 50 + creatorBps + snipeBps;
            assertEq(paid - net, _ceil(net * r, 1e4 - r), "fees on top of the pool's net (v1.3 exact-fill rule)");
        }
        // Exact-out sell.
        {
            uint256 usdcOut = 500e6;
            bytes32 s0 = _hookState(token);
            (uint256 q,) = _quoteSellOut(token, usdcOut);
            assertEq(_hookState(token), s0, "a quote leaves no trace (exact-out sell)");
            Before memory b = _before(token);
            vm.recordLogs();
            uint256 paid = _sellOut(carol, token, usdcOut, q);
            assertEq(paid, q, "exact-out sell: fill == quote");
            Trade memory t = _checkFeesAndBid(token, b, vm.getRecordedLogs(), false);
            uint256 r = 50 + creatorBps;
            assertEq(t.usdcAmount - usdcOut, _ceil(usdcOut * r, 1e4 - r), "fees on top of the net out");
        }
        _assertHookClean(token);
    }

    function test_afterTheWindowEveryKindFillsExactlyAsQuoted() public {
        address token = _graduatedAfterWindow(250, false);
        _fund(token, carol, 50_000_000e18);
        _checkAllFour(token, 250);
        _assertSolvent();
    }

    function test_insideTheWindowEveryKindFillsExactlyAsQuotedBidIncluded() public {
        address token = _graduatedInWindow(250, false, 2_000e6); // a graduation bid exists
        _fund(token, carol, 50_000_000e18);
        _checkAllFour(token, 250); // graduation block, 90%
        // The first buy started at the graduation tick (the reference); the sell after it took the price to a new low,
        // so the exact-out buy's bid came from its own starting tick and moved the reference: both paths ran.
        assertTrue(_refTick(token) != _gradTick(token), "the reference moved down");
        _step(7);
        _checkAllFour(token, 250); // mid-window
        _step(12);
        assertEq(hook.snipeBpsOf(token), 450, "last window block");
        _checkAllFour(token, 250);
        _step(1);
        _checkAllFour(token, 250); // closed
        _assertSolvent();
    }

    function test_insideTheWindowWithNoGraduationBidAndAnOpenPool() public {
        address token = _graduatedInWindow(0, true, 0);
        _fund(token, carol, 50_000_000e18);
        _checkAllFour(token, 0);
        _assertSolvent();
    }

    /// @dev At the largest creator fee (10%) the opening surcharge is capped so all three take 99%: 8,850 bps.
    function test_insideTheWindowAtTheTotalFeeCap() public {
        address token = _graduatedInWindow(1000, false, 1_000e6);
        assertEq(hook.snipeBpsOf(token), 8850, "capped");
        _fund(token, carol, 50_000_000e18);
        _checkAllFour(token, 1000);
        _assertSolvent();
    }

    /// @dev The smallest exact-in amounts the V4Quoter can price: below them the hook's rounded-up fees would take the
    ///      whole amount and it reverts FeesExceedAmount (dust probes by an aggregator or a price feed revert).
    function test_dustQuotesRevertBelowAFewUnits() public {
        address token = _graduatedInWindow(100, false, 1_000e6);
        uint256 minBuyWindow = _minQuotable(token, true);
        uint256 minSellWindow = _minQuotable(token, false);
        _step(hook.SNIPE_BLOCKS());
        uint256 minBuyAfter = _minQuotable(token, true);
        console2.log("smallest quotable buy in the opening block (raw USDC units)", minBuyWindow);
        console2.log("smallest quotable buy after the window (raw USDC units)", minBuyAfter);
        console2.log("smallest quotable sell (token wei)", minSellWindow);
        assertGt(minBuyWindow, minBuyAfter);
        assertLe(minBuyWindow, 100, "a ten-thousandth of a USDC always quotes");
    }

    function _minQuotable(address token, bool buy) internal returns (uint256) {
        uint256 amount = 1;
        IV4Quoter.QuoteExactSingleParams memory p = _single(_key(token), buy == _usdcIs0(token), 0);
        for (uint256 i; i < 200; ++i) {
            p.exactAmount = uint128(amount);
            try quoter.quoteExactInputSingle(p) returns (uint256, uint256) {
                return amount;
            } catch {}
            amount = buy ? amount + 1 : amount * 2;
        }
        return type(uint256).max;
    }

    /// @dev The quote is the same whoever asks: the hook never looks at the swapper (allowlist reviewers ask).
    function test_theQuoteDoesNotDependOnWhoAsks() public {
        address token = _graduatedInWindow(100, false, 1_000e6);
        IV4Quoter.QuoteExactSingleParams memory p = _single(_key(token), _usdcIs0(token), 777e6);
        vm.prank(alice, alice);
        (uint256 a,) = quoter.quoteExactInputSingle(p);
        vm.prank(bob, bob);
        (uint256 b,) = quoter.quoteExactInputSingle(p);
        (uint256 c,) = quoter.quoteExactInputSingle(p);
        assertEq(a, b);
        assertEq(b, c);
        // and the fill through a different router, by a third account, is the same number
        assertEq(_buyIn(dave, token, 777e6, 0), a);
    }

    /// @dev Uniswap's V4Quoter and the Architex router's own quote (the same revert-with-result pattern) agree, inside
    ///      the window and after it, both ways.
    function test_uniswapsQuoterAgreesWithTheArchitexRouter() public {
        address token = _graduatedInWindow(250, false, 1_000e6);
        for (uint256 round; round < 2; ++round) {
            (uint256 u,) = _quoteBuyIn(token, 4_321e6);
            assertEq(router.quoteBuy(token, 4_321e6), u, "buy");
            (uint256 v,) = _quoteSellIn(token, 7_654_321e18);
            assertEq(router.quoteSell(token, 7_654_321e18), v, "sell");
            _step(hook.SNIPE_BLOCKS());
        }
    }

    /// @dev A wallet quotes in one block and its transaction lands in a later one. Inside the window the surcharge only
    ///      falls, so a stale quote used as the minimum out (or maximum in) never fails on the hook's account; the
    ///      trader is only ever better off. Checked for every block of the window, including the last block into the
    ///      first one after it. (Price moves by other traders are ordinary slippage and are not modelled here.)
    function test_aQuoteFromAnEarlierWindowBlockNeverFailsItsFill() public {
        address token = _graduatedInWindow(100, false, 1_000e6);
        uint256 start = vm.getBlockNumber();
        uint256 worstGainBps = type(uint256).max;
        for (uint256 k; k <= hook.SNIPE_BLOCKS(); ++k) {
            vm.roll(start + k);
            (uint256 qIn,) = _quoteBuyIn(token, 1_000e6);
            (uint256 qOut,) = _quoteBuyOut(token, 1_000_000e18);
            uint256 snap = vm.snapshotState();
            vm.roll(start + k + 1);
            uint256 got = _buyIn(carol, token, 1_000e6, qIn); // minOut = the stale quote
            assertGe(got, qIn, "exact-in: never less than quoted");
            if (k < hook.SNIPE_BLOCKS()) worstGainBps = Math.min(worstGainBps, (got - qIn) * 1e4 / qIn);
            vm.revertToState(snap);
            vm.roll(start + k + 1);
            uint256 paid = _buyOut(carol, token, 1_000_000e18, qOut); // maxIn = the stale quote
            assertLe(paid, qOut, "exact-out: never more than quoted");
            vm.revertToState(snap);
        }
        console2.log("smallest gain from landing one block later inside the window, bps", worstGainBps);
    }
}

contract QuoterRouterParityUsdcLowTest is QuoterRouterParityTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract QuoterRouterParityUsdcHighTest is QuoterRouterParityTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
