// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {Review8Base} from "./Review8Base.sol";

/// @notice Claude review #8 (holds), open pools around the bid.
///         - Filling either of the bid's ticks to v4's per-tick liquidity cap (what review #7 did to the far tick when
///           bids reached it) now takes a USDC-only position one spacing wide that costs about 3e16 USDC at the far
///           end and 3e18 at the top: hundreds of thousands of times all USDC in existence.
///         - An outside LP sitting on exactly a bid's ticks, or adding and removing around the buy that places it (JIT),
///           changes nothing about the bid: the buy places it, the hook's positions keep their liquidity, the books
///           hold.
abstract contract OpenPoolBidTicksTest is Review8Base {
    using PoolIdLibrary for PoolKey;

    /// @dev USDC (6dp units) a one-spacing, USDC-only position touching `tick` needs to fill the tick's liquidity cap,
    ///      on the side of `tick` where USDC-only positions are cheapest.
    function _costToFill(address token, int24 tick) internal view returns (uint256) {
        uint128 room = Pool.tickSpacingToMaxLiquidityPerTick(200);
        return _usdcIs0(token)
            ? SqrtPriceMath.getAmount0Delta(
                TickMath.getSqrtPriceAtTick(tick), TickMath.getSqrtPriceAtTick(tick + 200), room, true
            )
            : SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtPriceAtTick(tick - 200), TickMath.getSqrtPriceAtTick(tick), room, true
            );
    }

    function test_fillingABidTickCostsMoreThanAllUsdc() public {
        address token = _graduated(0, true);
        (int24 lower, int24 upper) = _bid(token);
        uint256 top = _costToFill(token, _bidTop(token));
        uint256 far = _costToFill(token, _usdcIs0(token) ? upper : lower);
        console2.log("USDC to fill the bid's top tick (whole USDC)", top / 1e6);
        console2.log("USDC to fill the bid's far tick (whole USDC)", far / 1e6);
        uint256 allUsdc = 1e11 * 1e6; // 100 billion USDC, above the whole supply
        assertGt(top, 1_000 * allUsdc);
        assertGt(far, 1_000 * allUsdc);
    }

    function test_outsideLiquidityOnTheBidTicksChangesNothing() public {
        address t2 = _graduateWithCurveSnipe(0, true, dave, 0); // open pool, returns in its opening block
        PoolKey memory key = _key(t2);
        // The price has not moved since graduation, so an opening-block buy's bid starts from the graduation price.
        (int24 lower, int24 upper) = _bid(t2);

        // An outside LP parks USDC exactly on the bid's range and one spacing either side of both ends.
        usdc.mint(address(raw), 500_000_000e6);
        int24[3] memory los = [lower, lower - 200, upper];
        int24[3] memory his = [upper, lower, upper + 200];
        for (uint256 i; i < 3; ++i) {
            raw.addLiquidity(key, ModifyLiquidityParams(los[i], his[i], 1e21, bytes32(uint256(100 + i))));
        }
        // and a JIT position around the price itself
        (, int24 tick) = _slot0(t2);
        int24 at = _floor200(tick);
        vm.prank(bob);
        IERC20(t2).transfer(address(raw), 10_000_000e18);
        raw.addLiquidity(key, ModifyLiquidityParams(at - 200, at + 400, 1e18, bytes32(uint256(200))));

        // Adding liquidity never moves the price, so the buy still starts from the graduation price.
        uint256 salt = hook.bidCount(t2) + 1;
        vm.prank(carol);
        router.buy(t2, 5_000e6, 0, carol, MAX); // the opening-window surcharge becomes a bid inside the buy
        assertEq(hook.bidCount(t2), salt, "the bid goes in");
        assertLe(hook.lockHeld(t2), 2);
        bytes32 bidPos = keccak256(abi.encodePacked(address(hook), lower, upper, bytes32(salt)));
        uint128 liquidity = StateLibrary.getPositionLiquidity(manager, key.toId(), bidPos);
        assertGt(liquidity, 0, "the hook's bid, its own");

        // The LP leaves (JIT first); the hook's positions do not move.
        raw.addLiquidity(key, ModifyLiquidityParams(at - 200, at + 400, -1e18, bytes32(uint256(200))));
        for (uint256 i; i < 3; ++i) {
            raw.addLiquidity(key, ModifyLiquidityParams(los[i], his[i], -1e21, bytes32(uint256(100 + i))));
        }
        assertEq(StateLibrary.getPositionLiquidity(manager, key.toId(), bidPos), liquidity);
        _assertHookClean(t2);
        _assertSolvent();
    }
}

contract OpenPoolBidTicksUsdcLowTest is OpenPoolBidTicksTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract OpenPoolBidTicksUsdcHighTest is OpenPoolBidTicksTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
