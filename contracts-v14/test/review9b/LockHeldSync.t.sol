// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {RawSwapper} from "../V14Base.sol";
import {Review9bBase} from "./Review9bBase.sol";

/// @notice Claude review #9b, attack 3 (holds): the lockHeld change (`_collect` no longer books the snipe fee;
///         `_placeBid(.., extra)` books whatever the bid does not take, writing lockHeld only when that changes) keeps
///         the hook's claims equal to pendingPlatform + pendingCreator + lockHeld on every path:
///         - the ordinary path, fuzzed over sequences of window buys of every kind and size, so the rounding a bid
///           leaves is carried into the next (lockHeld moves by exactly the snipe fee minus what BidLocked took);
///         - both early returns, which no trading can reach (they need a reference within a discount of the cheap
///           extreme tick, or a reference so expensive that a fee rounds to no liquidity, and the reference only moves
///           to cheaper prices from graduation's), forced here by writing the pool's price and the reference into
///           storage: the snipe fee is booked to lockHeld and the books stay square. Once forced there, every later
///           window bid waits too (the reference never moves back), which is the only way a fee could ever wait.
abstract contract LockHeldSyncTest is Review9bBase {
    // ─── The ordinary path ────────────────────────────────────────────────────

    /// @dev Up to 8 window buys (exact in, exact out, dust exact out) at random sizes and blocks. After each: the books
    ///      are square, lockHeld is at most 2, and it moved by exactly the snipe fee minus the bid's USDC.
    function testFuzz_lockHeldMovesByTheSnipeFeeMinusTheBid(uint16 cfee, uint256 seed, uint8 n) public {
        address t = _graduateWithCurveSnipe(uint16(bound(cfee, 0, 1000)), false, dave, 0);
        uint256 openBlk = block.number;
        RawSwapper w = new RawSwapper(manager);
        usdc.mint(address(w), 1e9 * 1e6);
        n = uint8(bound(n, 1, 8));
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            if (r % 3 == 0 && block.number + 3 <= openBlk + 19) _step(1 + (r >> 8) % 3);
            uint256 held = hook.lockHeld(t);
            vm.recordLogs();
            uint256 kind = (r >> 16) % 3;
            SwapParams memory p = kind == 0
                ? _buyIn(t, bound(r >> 24, 1_000, 100_000e6))
                : kind == 1 ? _buyExactOut(t, bound(r >> 24, 1e12, 20_000_000e18)) : _buyExactOut(t, 1e14);
            try w.swap(_key(t), p) {}
            catch {
                continue;
            }
            (uint256 snipe, uint256 bid) = _snipeAndBid(vm.getRecordedLogs(), t);
            assertEq(hook.lockHeld(t), held + snipe - bid, "lockHeld moves by the snipe fee minus the bid");
            assertLe(hook.lockHeld(t), 2, "nothing but rounding is held");
            _assertHookClean(t);
        }
        _assertSolvent();
    }

    function _snipeAndBid(Vm.Log[] memory logs, address t) internal view returns (uint256 snipe, uint256 bid) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(hook) || !_is(logs[i], POOL_TRADE, t) && !_is(logs[i], BID_LOCKED, t)) {
                continue;
            }
            if (logs[i].topics[0] == POOL_TRADE) {
                (,,,,, snipe) = abi.decode(logs[i].data, (bool, uint256, uint256, uint256, uint256, uint256));
            } else {
                (bid,,,) = abi.decode(logs[i].data, (uint256, uint128, int24, int24));
            }
        }
    }

    // ─── The early returns, forced ────────────────────────────────────────────

    /// @dev One opening-block exact-out buy of one token from where the test put the pool; returns its snipe fee and
    ///      whether it placed a bid.
    function _oneTokenBuy(address t) internal returns (uint256 snipe, bool placed) {
        RawSwapper w = new RawSwapper(manager);
        usdc.mint(address(w), 1_000e6);
        vm.recordLogs();
        w.swap(_key(t), _buyExactOut(t, 1e18));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 bid;
        (snipe, bid) = _snipeAndBid(logs, t);
        placed = _bidsIn(logs, t).length != 0;
        bid;
    }

    /// @dev An empty range: the pool's price forced to within a discount of the cheap extreme tick (the reference then
    ///      follows it there, since it is the cheaper price).
    function test_anEmptyRangeBooksTheFeeAndTheBooksStaySquare() public {
        address t = _graduateWithCurveSnipe(0, false, dave, 0); // the opening block: 90%
        bool u0 = _usdcIs0(t);
        _forcePrice(t, u0 ? int24(885_000) : int24(-885_000));
        uint256 held = hook.lockHeld(t);
        uint256 bids = hook.bidCount(t);
        (uint256 snipe, bool placed) = _oneTokenBuy(t);
        assertGt(snipe, 0, "the buy paid a snipe fee");
        assertFalse(placed, "no bid: the range is empty");
        assertEq(hook.bidCount(t), bids);
        assertEq(hook.lockHeld(t), held + snipe, "the fee is booked to lockHeld");
        _assertHookClean(t);
        // The reference stays at the extreme (it only moves down), so every later window bid waits too.
        (uint256 snipe2, bool placed2) = _oneTokenBuy(t);
        assertFalse(placed2);
        assertEq(hook.lockHeld(t), held + snipe + snipe2, "and waits for good");
        _assertHookClean(t);
    }

    /// @dev liquidity == 0: the price and the reference both forced to an expensive tick (the reference can never get
    ///      there by trading: it starts at graduation and only moves to cheaper prices), where a small fee buys no
    ///      liquidity over a non-empty range.
    function test_noLiquidityBooksTheFeeAndTheBooksStaySquare() public {
        address t = _graduateWithCurveSnipe(0, false, dave, 0);
        bool u0 = _usdcIs0(t);
        int24 dear = u0 ? int24(-150_000) : int24(300_000);
        _forcePrice(t, dear);
        _forceBidRef(t, dear);
        (int24 lo, int24 hi) = _rangeFrom(u0, dear);
        assertLt(lo, hi, "the range is not empty");
        uint256 held = hook.lockHeld(t);
        uint256 bids = hook.bidCount(t);
        RawSwapper w = new RawSwapper(manager);
        usdc.mint(address(w), 1_000e6);
        vm.recordLogs();
        w.swap(_key(t), _buyIn(t, 1_000)); // 0.001 USDC: a 900-unit snipe fee
        (uint256 snipe,) = _snipeAndBid(vm.getRecordedLogs(), t);
        assertEq(snipe, 900);
        assertEq(hook.bidCount(t), bids, "no bid: no liquidity");
        assertEq(hook.lockHeld(t), held + snipe, "the fee is booked to lockHeld");
        _assertHookClean(t);
    }
}

contract LockHeldSyncUsdcLowTest is LockHeldSyncTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract LockHeldSyncUsdcHighTest is LockHeldSyncTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
