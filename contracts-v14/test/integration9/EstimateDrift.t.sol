// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Integration9Base, VmGas5} from "./Integration9Base.sol";

/// @notice Integration review #9, check 4 continued (regression tests since 39a78b4): can a gas limit taken from
///         eth_estimateGas in one state fail in the state the transaction actually lands in? The window's surcharge
///         only falls block by block, and a buy after the window places no bid, so time alone only ever lowers a buy's
///         gas. What raises it is state: whether the bid's ticks exist. Since 39a78b4 every window bid starts from the
///         pool's reference (the lowest price any window buy has started from), so another buy landing first changes
///         nothing; only a sell that takes the price to a new low, at least one tick spacing under the reference, makes
///         the next bid open new ticks. Measured as transaction gas limits (forge 1.8.1 isolates each top-level call by
///         default; see GasProfile.t.sol). Under --no-isolate the tests still pass; the receipt comparison is then
///         skipped, since a frame's gas without isolation has no intrinsic gas in it.
abstract contract EstimateDriftTest is Integration9Base {
    uint256[6] internal BUFFERS_PCT = [uint256(10), 15, 20, 25, 30, 50];

    function _buyPlan(address token, uint256 usdcIn) internal view returns (bytes memory) {
        return _exactInSinglePlan(_key(token), _usdcIs0(token), usdcIn, 0);
    }

    /// @dev Tries the transaction with the estimate plus each buffer; returns the smallest buffer (in %) that works,
    ///      or 999 if none of them does.
    function _smallestBufferThatWorks(address trader, address token, bytes memory data, uint256 estimate)
        internal
        returns (uint256)
    {
        for (uint256 i; i < BUFFERS_PCT.length; ++i) {
            bool ok = _succeedsWithin(trader, token, data, estimate * (100 + BUFFERS_PCT[i]) / 100);
            console2.log("    estimate +", BUFFERS_PCT[i], ok ? "% succeeds" : "% runs out of gas");
            if (ok) return BUFFERS_PCT[i];
        }
        return 999;
    }

    /// @dev Whether the next window buy's bid would land on ticks that already exist (from the cheaper of the current
    ///      price and the pool's reference).
    function _nextBidOnExistingTicks(address token) internal view returns (bool) {
        (, int24 tick) = _slot0(token);
        bool u0 = _usdcIs0(token);
        (int24 lo, int24 hi) = _expectedBid(u0, _cheaperTick(u0, tick, _refTick(token)));
        return _tickExists(token, lo) && _tickExists(token, hi);
    }

    function _tickExists(address token, int24 t) internal view returns (bool) {
        return _tickGross(token, t) != 0;
    }

    /// @dev Carol estimates a window buy whose bid would reuse the reference's ticks. Bob's 30,000 USDC buy lands first
    ///      in the same block and lifts the price; carol's bid still starts from the reference, on the same ticks, so
    ///      her estimate still holds. (Before 39a78b4 this needed 16% to 18% more gas: the bid followed the lifted
    ///      price onto new ticks.)
    function test_anotherBuyLandingFirstNoLongerChangesTheGas() public {
        address token = _graduatedInWindow(100, false, 2_000e6);
        _fund(token, carol, 1e18);
        vm.prank(bob);
        router.sell(token, 1_000e18, 0, bob, MAX);
        bytes memory data = _buyPlan(token, 1_000e6);
        assertTrue(_nextBidOnExistingTicks(token));
        uint256 estimate = _txLimit(carol, token, data);

        vm.prank(bob);
        router.buy(token, 30_000e6, 0, bob, MAX);
        assertTrue(_nextBidOnExistingTicks(token), "the lift leaves the bid on the same ticks");
        uint256 needed = _txLimit(carol, token, data);
        console2.log("estimate (bid on the reference's ticks)", estimate);
        console2.log("needed after bob's buy lands first", needed);
        assertLe(needed, estimate + 2_000, "the estimate still holds");
        assertTrue(_succeedsWithin(carol, token, data, estimate + 2_000));
    }

    /// @dev Carol estimates a window buy whose bid would reuse the reference's ticks. A seller lands first and takes
    ///      the price to a new low, one tick spacing or more under the reference; carol's buy now starts there, so its
    ///      bid opens two new ticks. This is the drift that remains (and the cheap griefing variant: sells pay no
    ///      surcharge).
    function test_aSellToANewLowLandingFirstRaisesTheGasABidNeeds() public {
        address token = _graduatedInWindow(100, false, 2_000e6);
        _fund(token, carol, 1e18);
        vm.prank(bob);
        router.sell(token, 1_000e18, 0, bob, MAX);
        bytes memory data = _buyPlan(token, 1_000e6);
        uint256 estimate = _txLimit(carol, token, data);

        uint256 sells;
        while (_nextBidOnExistingTicks(token) && sells < 40) {
            vm.prank(bob);
            router.sell(token, 5_000_000e18, 0, bob, MAX);
            sells++;
        }
        assertFalse(_nextBidOnExistingTicks(token), "a new low: new ticks");
        uint256 needed = _txLimit(carol, token, data);
        console2.log("estimate (bid on the reference's ticks)", estimate);
        console2.log("needed after sells to a new low land first (new ticks)", needed);
        console2.log("  increase, bps", (needed - estimate) * 1e4 / estimate);
        uint256 smallest = _smallestBufferThatWorks(carol, token, data, estimate);
        assertGt(needed, estimate * 115 / 100, "more than a 15% buffer covers");
        assertGt(smallest, 15);
        assertLe(smallest, 30, "30% headroom covers it");
    }

    /// @dev Time alone: an estimate in the window's last block, landing in the first block after it, needs less (no
    ///      bid), and the fill is at least the quote.
    function test_theWindowClosingOnlyLowersTheGas() public {
        address token = _graduatedInWindow(100, false, 2_000e6);
        _fund(token, carol, 1e18);
        _step(hook.SNIPE_BLOCKS() - 1);
        assertGt(hook.snipeBpsOf(token), 0, "last window block");
        bytes memory data = _buyPlan(token, 1_000e6);
        uint256 estimate = _txLimit(carol, token, data);
        (uint256 q,) = _quoteBuyIn(token, 1_000e6);
        _step(1);
        assertEq(hook.snipeBpsOf(token), 0, "window closed");
        uint256 needed = _txLimit(carol, token, data);
        console2.log("estimate in the last window block", estimate);
        console2.log("needed one block later", needed);
        assertLt(needed, estimate, "less gas once the window has closed");
        assertTrue(_succeedsWithin(carol, token, data, estimate));
        assertGe(_buyIn(carol, token, 1_000e6, q), q, "and at least the quoted tokens");
    }

    /// @dev A window buy's receipt is now close to the limit it needed: no refund (lockHeld is no longer written and
    ///      reset inside the buy), only the 63/64 reserve of the nested calls. A limit copied from a receipt still
    ///      fails as it stands, but a few percent on top covers it. (Before 39a78b4 the limit was 10.8% over the
    ///      receipt, because of a 19,900 refund.)
    function test_aWindowBuysReceiptIsNowCloseToTheLimitItNeeded() public {
        address token = _graduatedInWindow(100, false, 2_000e6);
        _fund(token, carol, 1e18);
        _fund(token, dave, 1e18);
        vm.prank(bob);
        router.sell(token, 1_000e18, 0, bob, MAX);
        bytes memory data = _buyPlan(token, 1_000e6);
        bool isolated = _isolated();
        // Dave's buy and its receipt.
        uint256 snap = vm.snapshotState();
        vm.prank(dave, dave);
        v4r.executeActions(data);
        VmGas5.Gas5 memory g = VmGas5(address(vm)).lastCallGas();
        vm.revertToStateAndDelete(snap);
        uint256 needed = _txLimit(carol, token, data);
        console2.log("receipt gasUsed of an identical window buy", g.gasTotalUsed);
        console2.log("refund in it", uint256(int256(g.gasRefunded < 0 ? int64(0) : g.gasRefunded)));
        console2.log("gas limit the same buy needs", needed);
        console2.log("isolated transactions", isolated);
        if (!isolated) return; // without isolation the frame's gas has no intrinsic gas: nothing to compare
        assertEq(g.gasRefunded, 0, "no refund left in a window buy");
        assertFalse(_succeedsWithin(carol, token, data, g.gasTotalUsed), "the receipt alone is not enough");
        assertLe(needed, uint256(g.gasTotalUsed) * 105 / 100, "the receipt plus 5% is");
    }
}

contract EstimateDriftUsdcLowTest is EstimateDriftTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract EstimateDriftUsdcHighTest is EstimateDriftTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
