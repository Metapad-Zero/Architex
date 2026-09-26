// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {IV4Router} from "@uniswap/v4-periphery/src/interfaces/IV4Router.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {Integration9Base} from "./Integration9Base.sol";

/// @notice Integration review #9, check 2 (regression tests since 39a78b4): routes through more than one pool, and more
///         than one swap in one of our pools inside a single unlock, through Uniswap's V4Router and priced by its
///         V4Quoter. The hook keeps the tick before a window buy in one transient slot (not keyed by pool) between
///         beforeSwap and afterSwap, and places the bid from the cheaper of that tick and the pool's `bidRefTick`.
///         Every bid here is replayed from the PoolManager's Swap events against that rule, and the stored reference
///         checked. The transient tick only shows in a bid when its buy starts at a new low, so the multi-swap tests
///         make buys do exactly that.
abstract contract MultiHopTest is Integration9Base {
    // ─── Exact in ─────────────────────────────────────────────────────────────

    function _otherIntoOurs(address token, bool window) internal {
        PathKey[] memory path = _path2(_hopOtherTo(address(usdc)), _hopOurs(token));
        uint256 amountIn = 2e18; // about 4,000 USDC
        (uint256 q,) = quoter.quoteExactInput(
            IV4Quoter.QuoteExactParams({exactCurrency: _c(address(other)), path: path, exactAmount: uint128(amountIn)})
        );
        (, int24 t0) = _slot0(token);
        int24 r0 = _refTick(token);
        vm.recordLogs();
        (uint256 paid, uint256 got) = _exec(
            carol, _exactInPathPlan(_c(address(other)), path, amountIn, q, _c(token)), _c(address(other)), _c(token)
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(paid, amountIn);
        assertEq(got, q, "OTHER -> USDC -> TOKEN: fill == quote");
        (uint256 checked,) = _checkBidsFollowReference(logs, token, t0, r0);
        assertEq(checked, window ? 1 : 0);
    }

    function test_exactInFromAnotherV4PoolIntoOurs() public {
        address token = _graduatedInWindow(200, false, 1_000e6);
        _otherIntoOurs(token, true);
        _step(hook.SNIPE_BLOCKS());
        _otherIntoOurs(token, false);
        _assertHookClean(token);
        _assertSolvent();
    }

    function test_exactInOursFirstThenAnotherV4Pool() public {
        address token = _graduatedInWindow(200, false, 1_000e6);
        _fund(token, carol, 20_000_000e18);
        PathKey[] memory path = _path2(_hopOurs(address(usdc)), _hopOtherTo(address(other)));
        (uint256 q,) = quoter.quoteExactInput(
            IV4Quoter.QuoteExactParams({exactCurrency: _c(token), path: path, exactAmount: 20_000_000e18})
        );
        (uint256 paid, uint256 got) = _exec(
            carol,
            _exactInPathPlan(_c(token), path, 20_000_000e18, q, _c(address(other))),
            _c(token),
            _c(address(other))
        );
        assertEq(paid, 20_000_000e18);
        assertEq(got, q, "TOKEN -> USDC -> OTHER: fill == quote");
        _assertHookClean(token);
    }

    function test_exactInFromOurPoolIntoOurPoolBothInTheirWindows() public {
        (address a, address b) = _twoInWindow(100, 300);
        _fund(a, carol, 20_000_000e18);
        PathKey[] memory path = _path2(_hopOurs(address(usdc)), _hopOurs(b));
        (uint256 q,) = quoter.quoteExactInput(
            IV4Quoter.QuoteExactParams({exactCurrency: _c(a), path: path, exactAmount: 20_000_000e18})
        );
        (, int24 tb) = _slot0(b);
        int24 rb = _refTick(b);
        vm.recordLogs();
        (, uint256 got) = _exec(carol, _exactInPathPlan(_c(a), path, 20_000_000e18, q, _c(b)), _c(a), _c(b));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(got, q, "A -> USDC -> B: fill == quote");
        (uint256 checked,) = _checkBidsFollowReference(logs, b, tb, rb);
        assertEq(checked, 1, "B's buy placed its bid from B's own reference");
        assertEq(_bids(logs, a).length, 0, "A's sell placed none");
        _assertHookClean(a);
        _assertSolvent();
    }

    // ─── Exact out ────────────────────────────────────────────────────────────

    function test_exactOutMultiHopEveryShape() public {
        (address a, address b) = _twoInWindow(100, 300);
        _fund(a, carol, 100_000_000e18);

        // OTHER -> USDC -> A, exact A out (our pool is the last hop, priced first).
        {
            PathKey[] memory path = _path2(_hopOtherTo(address(other)), _hopOurs(address(usdc)));
            (uint256 q,) = quoter.quoteExactOutput(
                IV4Quoter.QuoteExactParams({exactCurrency: _c(a), path: path, exactAmount: 1_000_000e18})
            );
            (, int24 t0) = _slot0(a);
            int24 r0 = _refTick(a);
            vm.recordLogs();
            (uint256 paid, uint256 got) = _exec(
                carol, _exactOutPathPlan(_c(a), path, 1_000_000e18, q, _c(address(other))), _c(address(other)), _c(a)
            );
            assertEq(got, 1_000_000e18);
            assertEq(paid, q, "OTHER -> USDC -> A exact out: fill == quote");
            (uint256 checked,) = _checkBidsFollowReference(vm.getRecordedLogs(), a, t0, r0);
            assertEq(checked, 1);
        }
        // A -> USDC -> OTHER, exact OTHER out (our pool is the first hop, an exact-out sell).
        {
            PathKey[] memory path = _path2(_hopOurs(a), _hopOtherTo(address(usdc)));
            (uint256 q,) = quoter.quoteExactOutput(
                IV4Quoter.QuoteExactParams({exactCurrency: _c(address(other)), path: path, exactAmount: 1e17})
            );
            (uint256 paid, uint256 got) =
                _exec(carol, _exactOutPathPlan(_c(address(other)), path, 1e17, q, _c(a)), _c(a), _c(address(other)));
            assertEq(got, 1e17);
            assertEq(paid, q, "A -> USDC -> OTHER exact out: fill == quote");
        }
        // A -> USDC -> B, exact B out: both hops are ours, a sell then a window buy.
        {
            PathKey[] memory path = _path2(_hopOurs(a), _hopOurs(address(usdc)));
            (uint256 q,) = quoter.quoteExactOutput(
                IV4Quoter.QuoteExactParams({exactCurrency: _c(b), path: path, exactAmount: 500_000e18})
            );
            (, int24 tb) = _slot0(b);
            int24 rb = _refTick(b);
            vm.recordLogs();
            (uint256 paid, uint256 got) =
                _exec(carol, _exactOutPathPlan(_c(b), path, 500_000e18, q, _c(a)), _c(a), _c(b));
            assertEq(got, 500_000e18);
            assertEq(paid, q, "A -> USDC -> B exact out: fill == quote");
            (uint256 checked,) = _checkBidsFollowReference(vm.getRecordedLogs(), b, tb, rb);
            assertEq(checked, 1);
        }
        _assertHookClean(a);
        _assertSolvent();
    }

    // ─── Several swaps in our pool in one unlock ──────────────────────────────

    function _outSingle(address token, uint256 tokensOut)
        internal
        view
        returns (IV4Router.ExactOutputSingleParams memory)
    {
        return IV4Router.ExactOutputSingleParams({
            poolKey: _key(token),
            zeroForOne: _usdcIs0(token),
            amountOut: uint128(tokensOut),
            amountInMaximum: type(uint128).max,
            hookData: ""
        });
    }

    /// @dev One V4Router call, all in one pool inside the window: sell, buy, a bigger sell, an exact-out buy, a bigger
    ///      sell again, a buy; then SETTLE_ALL the tokens and TAKE_ALL the USDC. Each buy starts at a new low for the
    ///      pool, so each bid starts from that buy's own starting tick (the transient value) and the reference follows
    ///      it down three times: three distinct ranges, so a bid placed from any other tick fails the replay.
    function test_windowBuysAtNewLowsInOneUnlockBidFromTheirOwnStart() public {
        address token = _graduatedInWindow(150, false, 1_000e6);
        _fund(token, carol, 150_000_000e18);
        bool u0 = _usdcIs0(token);
        uint256[] memory actions = new uint256[](8);
        bytes[] memory params = new bytes[](8);
        (actions[0], params[0]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, !u0, 20_000_000e18)));
        (actions[1], params[1]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, u0, 1_000e6)));
        (actions[2], params[2]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, !u0, 40_000_000e18)));
        (actions[3], params[3]) = (Actions.SWAP_EXACT_OUT_SINGLE, abi.encode(_outSingle(token, 1_000_000e18)));
        (actions[4], params[4]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, !u0, 60_000_000e18)));
        (actions[5], params[5]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, u0, 2_000e6)));
        (actions[6], params[6]) = (Actions.SETTLE_ALL, abi.encode(_c(token), type(uint256).max));
        (actions[7], params[7]) = (Actions.TAKE_ALL, abi.encode(_c(address(usdc)), 0));

        (, int24 t0) = _slot0(token);
        int24 r0 = _refTick(token);
        uint256 bids0 = hook.bidCount(token);
        vm.recordLogs();
        vm.prank(carol);
        v4r.executeActions(_plan(actions, params));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_swaps(logs, _pid(token)).length, 6, "six swaps");
        (uint256 checked, uint256 newLows) = _checkBidsFollowReference(logs, token, t0, r0);
        assertEq(checked, 3, "three buys, three bids");
        assertEq(newLows, 3, "each buy started at a new low, so each bid is from its own starting tick");
        Bid[] memory bids = _bids(logs, token);
        assertTrue(bids[0].lower != bids[1].lower && bids[1].lower != bids[2].lower, "distinct ranges");
        assertTrue(bids[0].lower != bids[2].lower, "distinct ranges");
        assertEq(hook.bidCount(token), bids0 + 3);
        assertEq(_trades(logs, token).length, 6, "one PoolTrade per swap");
        _assertHookClean(token);
        _assertSolvent();
    }

    /// @dev One V4Router call: an exact-in buy, an exact-out buy and another exact-in buy, each lifting the price. None
    ///      starts at a new low, so all three bids share the reference's range (the graduation price's here): the rule
    ///      since 39a78b4 (Claude review #9, L1), and the reason most window bids now land on ticks that already exist.
    function test_windowBuysThatLiftThePriceShareTheReferenceInOneUnlock() public {
        address token = _graduatedInWindow(150, false, 1_000e6);
        bool u0 = _usdcIs0(token);
        uint256[] memory actions = new uint256[](5);
        bytes[] memory params = new bytes[](5);
        (actions[0], params[0]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, u0, 20_000e6)));
        (actions[1], params[1]) = (Actions.SWAP_EXACT_OUT_SINGLE, abi.encode(_outSingle(token, 20_000_000e18)));
        (actions[2], params[2]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, u0, 30_000e6)));
        (actions[3], params[3]) = (Actions.SETTLE_ALL, abi.encode(_c(address(usdc)), type(uint256).max));
        (actions[4], params[4]) = (Actions.TAKE_ALL, abi.encode(_c(token), 0));

        (, int24 t0) = _slot0(token);
        int24 r0 = _refTick(token);
        assertEq(t0, r0, "nothing has traded since graduation");
        vm.recordLogs();
        vm.prank(carol);
        v4r.executeActions(_plan(actions, params));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 checked, uint256 newLows) = _checkBidsFollowReference(logs, token, t0, r0);
        assertEq(checked, 3, "three buys, three bids");
        assertEq(newLows, 0, "no buy started below the reference");
        Bid[] memory bids = _bids(logs, token);
        assertTrue(bids[0].lower == bids[1].lower && bids[1].lower == bids[2].lower, "one shared range");
        (int24 lo, int24 hi) = _expectedBid(u0, _gradTick(token));
        assertEq(bids[2].lower, lo, "from half the graduation price");
        assertEq(bids[2].upper, hi, "from half the graduation price");
        _assertHookClean(token);
        _assertSolvent();
    }

    /// @dev Buy, sell everything back (OPEN_DELTA), buy again: the second buy starts about where the first did; one bid
    ///      per buy, each from the rule's reference.
    function test_buySellAllBuyInOneUnlock() public {
        address token = _graduatedInWindow(150, false, 1_000e6);
        bool u0 = _usdcIs0(token);
        uint256[] memory actions = new uint256[](5);
        bytes[] memory params = new bytes[](5);
        (actions[0], params[0]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, u0, 20_000e6)));
        (actions[1], params[1]) =
        (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, !u0, ActionConstants.OPEN_DELTA)));
        (actions[2], params[2]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(token, u0, 3_000e6)));
        (actions[3], params[3]) = (Actions.SETTLE_ALL, abi.encode(_c(address(usdc)), type(uint256).max));
        (actions[4], params[4]) = (Actions.TAKE_ALL, abi.encode(_c(token), 0));
        (, int24 t0) = _slot0(token);
        int24 r0 = _refTick(token);
        vm.recordLogs();
        vm.prank(carol);
        v4r.executeActions(_plan(actions, params));
        (uint256 checked,) = _checkBidsFollowReference(vm.getRecordedLogs(), token, t0, r0);
        assertEq(checked, 2);
        _assertHookClean(token);
    }

    /// @dev One unlock, two of our pools interleaved: A sells to a new low, A buys, B buys, A sells to a lower low, A
    ///      buys. The transient tick is written by each buy's own beforeSwap and read by its own afterSwap, and each
    ///      pool keeps its own reference: A's bids follow A's new lows, B's stays at B's graduation price.
    function test_windowBuysInTwoOfOurPoolsInOneUnlock() public {
        (address a, address b) = _twoInWindow(0, 500);
        _fund(a, carol, 100_000_000e18);
        bool ua = _usdcIs0(a);
        uint256[] memory actions = new uint256[](8);
        bytes[] memory params = new bytes[](8);
        (actions[0], params[0]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(a, !ua, 30_000_000e18)));
        (actions[1], params[1]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(a, ua, 10_000e6)));
        (actions[2], params[2]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(b, _usdcIs0(b), 7_000e6)));
        (actions[3], params[3]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(a, !ua, 40_000_000e18)));
        (actions[4], params[4]) = (Actions.SWAP_EXACT_IN_SINGLE, abi.encode(_inSingle(a, ua, 4_000e6)));
        (actions[5], params[5]) = (Actions.SETTLE_ALL, abi.encode(_c(address(usdc)), type(uint256).max));
        (actions[6], params[6]) = (Actions.SETTLE_ALL, abi.encode(_c(a), type(uint256).max));
        (actions[7], params[7]) = (Actions.TAKE_ALL, abi.encode(_c(b), 0));

        (, int24 ta) = _slot0(a);
        (, int24 tb) = _slot0(b);
        int24 ra = _refTick(a);
        int24 rb = _refTick(b);
        vm.recordLogs();
        vm.prank(carol);
        v4r.executeActions(_plan(actions, params));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 checkedA, uint256 lowsA) = _checkBidsFollowReference(logs, a, ta, ra);
        (uint256 checkedB, uint256 lowsB) = _checkBidsFollowReference(logs, b, tb, rb);
        assertEq(checkedA, 2, "A: two bids");
        assertEq(lowsA, 2, "A: both from A's own new lows");
        assertEq(checkedB, 1, "B: one bid");
        assertEq(lowsB, 0, "B: from B's own reference, untouched by A");
        assertTrue(_bids(logs, a)[0].lower != _bids(logs, a)[1].lower, "A's two bids differ");
        _assertHookClean(a);
        _assertSolvent();
    }

    function _inSingle(address token, bool zeroForOne, uint256 amountIn)
        internal
        view
        returns (IV4Router.ExactInputSingleParams memory)
    {
        return IV4Router.ExactInputSingleParams({
            poolKey: _key(token), zeroForOne: zeroForOne, amountIn: uint128(amountIn), amountOutMinimum: 0, hookData: ""
        });
    }
}

contract MultiHopUsdcLowTest is MultiHopTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract MultiHopUsdcHighTest is MultiHopTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
