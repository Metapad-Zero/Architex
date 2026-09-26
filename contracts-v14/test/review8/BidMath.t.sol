// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

/// @notice Claude review #8 (holds), the hook's range and amount math on its own, fuzzed with the same library calls,
///         on the bids placed inside the buy that pays them:
///         - `_bidRange` (copied verbatim) for every reference tick: a non-empty range is on the tick spacing, inside
///           the usable ticks, at least BID_DISCOUNT_TICKS past the reference on the cheap side, at most BID_SPAN_TICKS
///           wide, and, for every tick a buy can leave the pool at (the reference or past it in the buy's direction),
///           on the USDC side in v4's own branch terms, so `BidNotOneSided` cannot fire;
///         - a bid never uses more than lockHeld (v4 rounds the amount up from liquidity the hook rounded down), and at
///           any price a pool can reach, any amount of a unit or more is placed, leaving at most 2 units;
///         - graduation's full-range add never uses more USDC or tokens than it was given, so `_openPool`'s leftover
///           subtraction cannot underflow and `_pay` never sends more than the hook holds.
contract BidMathTest is Test {
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant BID_DISCOUNT_TICKS = 6932;
    int24 internal constant BID_SPAN_TICKS = 92_200;

    // ─── Verbatim copies of the hook's private helpers ────────────────────────

    function _bidRange(bool usdcIs0, int24 refTick) internal pure returns (int24 lower, int24 upper) {
        if (usdcIs0) {
            int24 maxTick = TickMath.maxUsableTick(TICK_SPACING);
            lower = _ceilTick(int256(refTick) + BID_DISCOUNT_TICKS + 1);
            upper = lower + BID_SPAN_TICKS > maxTick ? maxTick : lower + BID_SPAN_TICKS;
        } else {
            int24 minTick = TickMath.minUsableTick(TICK_SPACING);
            upper = _floorTick(int256(refTick) - BID_DISCOUNT_TICKS);
            lower = upper - BID_SPAN_TICKS < minTick ? minTick : upper - BID_SPAN_TICKS;
        }
    }

    function _floorTick(int256 tick) internal pure returns (int24) {
        int256 spacing = TICK_SPACING;
        int256 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        return int24(compressed * spacing);
    }

    function _ceilTick(int256 tick) internal pure returns (int24) {
        int256 spacing = TICK_SPACING;
        int256 compressed = tick / spacing;
        if (tick > 0 && tick % spacing != 0) compressed++;
        return int24(compressed * spacing);
    }

    // ─── Range ────────────────────────────────────────────────────────────────

    /// @dev `ref` is the tick before the buy (or graduation); `after_` any tick the buy can leave the pool at: the same or
    ///      past it in the buy's direction (a buy of tokens lowers the tick when USDC is currency0, raises it otherwise).
    function testFuzz_aRangeIsValidAndOneSidedAfterTheBuy(bool usdcIs0, int24 ref, uint24 moved) public pure {
        ref = int24(bound(ref, TickMath.MIN_TICK, TickMath.MAX_TICK));
        (int24 lower, int24 upper) = _bidRange(usdcIs0, ref);
        if (lower >= upper) {
            // Only for a reference within about a discount of the extreme tick, which no curve's pool reaches.
            assertTrue(usdcIs0 ? ref > 880_000 : ref < -880_000);
            return;
        }
        assertEq(lower % 200, 0);
        assertEq(upper % 200, 0);
        assertGe(lower, TickMath.minUsableTick(200));
        assertLe(upper, TickMath.maxUsableTick(200));
        assertLe(upper - lower, BID_SPAN_TICKS);
        int256 after_ = usdcIs0
            ? int256(ref) - int256(uint256(bound(moved, 0, uint256(int256(ref) - TickMath.MIN_TICK))))
            : int256(ref) + int256(uint256(bound(moved, 0, uint256(TickMath.MAX_TICK - int256(ref)))));
        if (usdcIs0) {
            assertGt(int256(lower) - ref, int256(BID_DISCOUNT_TICKS), "top past half the reference price");
            assertLt(after_, lower, "v4 branch: tick < tickLower, currency0 (USDC) only");
        } else {
            assertGe(int256(ref) - upper, int256(BID_DISCOUNT_TICKS), "top past half the reference price");
            assertGe(after_, upper, "v4 branch: tick >= tickUpper, currency1 (USDC) only");
        }
        // Clamping to the extreme usable tick only happens for references past about +-787,900; every curve graduates
        // at about +-366,200, and a pool would have to move about 10^18 times in price to get there.
        if (ref > -780_000 && ref < 780_000) {
            assertEq(upper - lower, BID_SPAN_TICKS, "full span, never the far tick");
        }
    }

    // ─── Amounts ──────────────────────────────────────────────────────────────

    /// @dev What _placeBid's modifyLiquidity asks for, given lockHeld = `amount`, at any reference a pool can reach.
    function testFuzz_aBidNeverUsesMoreThanItHolds(bool usdcIs0, int24 ref, uint256 amount) public pure {
        ref = int24(bound(ref, -780_000, 780_000));
        amount = bound(amount, 1, 1e17); // 100 billion USDC: above all USDC in existence
        (uint256 used, uint128 liquidity) = _used(usdcIs0, ref, amount);
        if (liquidity == 0) return;
        assertLe(used, amount, "used <= lockHeld");
        assertGe(used, 1);
    }

    /// @dev From any price within 200,000 ticks (about 5e8 times) of a real graduation, any amount of a unit or more is
    ///      placed, leaving at most 2 units: snipe fees never wait.
    function testFuzz_anyAmountIsPlacedAtAnyRealisticPrice(bool usdcIs0, int24 offset, uint256 amount) public pure {
        int24 grad = usdcIs0 ? int24(366_200) : int24(-366_201);
        int24 ref = grad + int24(bound(offset, -200_000, 200_000));
        amount = bound(amount, 1, 1e17);
        (uint256 used, uint128 liquidity) = _used(usdcIs0, ref, amount);
        assertGt(liquidity, 0, "no amount is too small");
        assertLe(used, amount);
        assertLe(amount - used, 2, "leaves at most 2 units");
    }

    /// @dev The same at the real graduation price, for every curve raise the launchpad can seed.
    function testFuzz_realGraduationBidLocksAnyAmount(bool usdcIs0, uint256 usdcSeeded, uint256 amount) public pure {
        usdcSeeded = bound(usdcSeeded, 24_999_999_968, 30_000e6);
        amount = bound(amount, 1, 1e17);
        uint256 pool = 200_000_000e18;
        (uint256 a0, uint256 a1) = usdcIs0 ? (usdcSeeded, pool) : (pool, usdcSeeded);
        int24 grad = TickMath.getTickAtSqrtPrice(_sqrtPriceX96(a0, a1));
        (uint256 used, uint128 liquidity) = _used(usdcIs0, grad, amount);
        assertGt(liquidity, 0, "no amount is too small");
        assertLe(used, amount);
        assertLe(amount - used, 2, "leaves at most 2 units");
    }

    /// @dev _openPool: price from the amounts, full-range liquidity for them, and what v4 then charges (rounded up).
    function testFuzz_graduationNeverUsesMoreThanItWasGiven(bool usdcIs0, uint256 usdcAmount, uint256 tokenAmount)
        public
        pure
    {
        // Every curve seeds about 25,000 USDC against 200M tokens; this covers 1,000 USDC to 1B USDC against 10M to 1B.
        usdcAmount = bound(usdcAmount, 1e9, 1e15);
        tokenAmount = bound(tokenAmount, 1e25, 1e27);
        (uint256 a0, uint256 a1) = usdcIs0 ? (usdcAmount, tokenAmount) : (tokenAmount, usdcAmount);
        uint160 sqrtP = _sqrtPriceX96(a0, a1);
        uint160 sqrtLo = TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(200));
        uint160 sqrtHi = TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(200));
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(sqrtP, sqrtLo, sqrtHi, a0, a1);
        uint256 used0 = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtHi, liquidity, true);
        uint256 used1 = SqrtPriceMath.getAmount1Delta(sqrtLo, sqrtP, liquidity, true);
        assertLe(used0, a0, "currency0 used <= given");
        assertLe(used1, a1, "currency1 used <= given");
    }

    function _used(bool usdcIs0, int24 ref, uint256 amount) internal pure returns (uint256 used, uint128 liquidity) {
        (int24 lower, int24 upper) = _bidRange(usdcIs0, ref);
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(lower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(upper);
        liquidity = usdcIs0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtA, sqrtB, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, amount);
        if (liquidity == 0) return (0, 0);
        used = usdcIs0
            ? SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, true)
            : SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, true);
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        return uint160(Math.sqrt(FullMath.mulDiv(amount1, 1 << 192, amount0)));
    }
}
