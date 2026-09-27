// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IArchitexLaunchHook} from "../../src/interfaces/IArchitexLaunchHook.sol";
import {ReviewBase} from "../review7/ReviewBase.sol";

/// @dev Claude review #8 (2026-09-25): helpers on top of review #7's harness, kept with its tests as regression tests.
abstract contract Review8Base is ReviewBase {
    /// @dev The range of a bid placed from `token`'s graduation price (the graduation bid, and an opening-block buy's,
    ///      which starts from the same price), recomputed from the hook's constants (no clamping: the graduation tick
    ///      of every curve is about +-366,200, far from both ends).
    function _bid(address token) internal view returns (int24 lower, int24 upper) {
        (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        int24 d = hook.BID_DISCOUNT_TICKS();
        int24 span = hook.BID_SPAN_TICKS();
        if (l.usdcIs0) {
            lower = _ceil200(int256(l.graduationTick) + d + 1);
            upper = lower + span;
        } else {
            upper = _floor200(int256(l.graduationTick) - d);
            lower = upper - span;
        }
        assertGe(lower, TickMath.minUsableTick(200));
        assertLe(upper, TickMath.maxUsableTick(200));
    }

    /// @dev The bid's edge nearest the market (its top): lower when USDC is currency0, upper when currency1.
    function _bidTop(address token) internal view returns (int24) {
        (int24 lower, int24 upper) = _bid(token);
        return _usdcIs0(token) ? lower : upper;
    }

    function _ceil200(int256 t) internal pure returns (int24) {
        int256 c = t / 200;
        if (t > 0 && t % 200 != 0) c++;
        return int24(c * 200);
    }

    function _floor200(int256 t) internal pure returns (int24) {
        int256 c = t / 200;
        if (t < 0 && t % 200 != 0) c--;
        return int24(c * 200);
    }

    function _usdcId() internal view returns (uint256) {
        return uint256(uint160(address(usdc)));
    }

    /// @dev An exact-in sell by the raw swapper, stopped by a price limit exactly at `tick` (partial fills are allowed
    ///      for exact-in sells: the hook's fees are on the pool's own USDC out).
    function _sellTo(address token, int24 tick) internal {
        raw.swap(
            _key(token),
            SwapParams({
                zeroForOne: !_usdcIs0(token),
                amountSpecified: -int256(500_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(tick)
            })
        );
    }

    /// @dev An exact-out buy by the raw swapper, stopped by a price limit exactly at `tick`.
    function _buyTo(address token, int24 tick) internal {
        raw.swap(
            _key(token),
            SwapParams({
                zeroForOne: _usdcIs0(token),
                amountSpecified: int256(500_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(tick)
            })
        );
    }
}

/// @dev Pays USDC into the PoolManager and mints the claims to whoever it is told: a third party adding ERC-6909 USDC
///      claims to the hook's balance, or trying to burn the hook's.
contract ClaimsActor is IUnlockCallback {
    IPoolManager internal immutable manager;
    IERC20 internal immutable usdc;

    constructor(IPoolManager manager_, IERC20 usdc_) {
        manager = manager_;
        usdc = usdc_;
    }

    function mintTo(address to, uint256 amount) external {
        manager.unlock(abi.encode(uint8(0), to, amount));
    }

    function burnFrom(address from, uint256 amount) external {
        manager.unlock(abi.encode(uint8(1), from, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (uint8 op, address who, uint256 amount) = abi.decode(data, (uint8, address, uint256));
        Currency c = Currency.wrap(address(usdc));
        uint256 id = uint256(uint160(address(usdc)));
        if (op == 0) {
            manager.sync(c);
            usdc.transfer(address(manager), amount);
            manager.settle();
            manager.mint(who, id, amount);
        } else {
            manager.burn(who, id, amount); // credit to this contract, if it were allowed
            manager.take(c, address(this), amount);
        }
        return "";
    }
}
