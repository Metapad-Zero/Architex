// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IArchitexLaunchHook} from "../../src/interfaces/IArchitexLaunchHook.sol";
import {V14Base} from "../V14Base.sol";

/// @dev Claude review #7's harness (2026-09-25), kept as the base of its regression tests.
///      Runs any sequence of swaps, donations and liquidity changes inside ONE PoolManager unlock (flash accounting:
///      nothing has to be paid until the end), then squares the net deltas from its own balances.
contract Flash is IUnlockCallback {
    IPoolManager public immutable manager;

    enum Kind {
        Swap,
        Donate,
        Modify
    }

    struct Op {
        Kind kind;
        SwapParams swap;
        uint256 amount0;
        uint256 amount1;
        ModifyLiquidityParams modify;
    }

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function run(PoolKey memory key, Op[] memory ops) external returns (int256 net0, int256 net1) {
        (net0, net1) = abi.decode(manager.unlock(abi.encode(key, ops)), (int256, int256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "only manager");
        (PoolKey memory key, Op[] memory ops) = abi.decode(data, (PoolKey, Op[]));
        int256 n0;
        int256 n1;
        for (uint256 i; i < ops.length; ++i) {
            BalanceDelta d;
            if (ops[i].kind == Kind.Swap) d = manager.swap(key, ops[i].swap, "");
            else if (ops[i].kind == Kind.Donate) d = manager.donate(key, ops[i].amount0, ops[i].amount1, "");
            else (d,) = manager.modifyLiquidity(key, ops[i].modify, "");
            n0 += d.amount0();
            n1 += d.amount1();
        }
        _square(key.currency0, n0);
        _square(key.currency1, n1);
        return abi.encode(n0, n1);
    }

    function _square(Currency currency, int256 amount) private {
        if (amount < 0) {
            manager.sync(currency);
            IERC20(Currency.unwrap(currency)).transfer(address(manager), uint256(-amount));
            manager.settle();
        } else if (amount > 0) {
            manager.take(currency, address(this), uint256(amount));
        }
    }
}

/// @dev Pays before it swaps (sync, transfer, settle, then swap, then take), as some v4 integrators do.
contract PrePaySwapper is IUnlockCallback {
    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function buyExactIn(PoolKey memory key, bool usdcIs0, uint256 usdcIn) external returns (uint256 tokensOut) {
        tokensOut = abi.decode(manager.unlock(abi.encode(key, usdcIs0, usdcIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool usdcIs0, uint256 usdcIn) = abi.decode(data, (PoolKey, bool, uint256));
        Currency usdcC = usdcIs0 ? key.currency0 : key.currency1;
        Currency tokenC = usdcIs0 ? key.currency1 : key.currency0;
        manager.sync(usdcC);
        IERC20(Currency.unwrap(usdcC)).transfer(address(manager), usdcIn);
        manager.settle();
        BalanceDelta d = manager.swap(
            key,
            SwapParams({
                zeroForOne: usdcIs0,
                amountSpecified: -int256(usdcIn),
                sqrtPriceLimitX96: usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        uint256 out = uint256(int256(usdcIs0 ? d.amount1() : d.amount0()));
        manager.take(tokenC, address(this), out);
        return abi.encode(out);
    }
}

abstract contract ReviewBase is V14Base {
    using PoolIdLibrary for PoolKey;

    Flash internal flash;

    function setUp() public virtual override {
        super.setUp();
        flash = new Flash(manager);
    }

    // ─── Pool reads ───────────────────────────────────────────────────────────

    function _slot0(address token) internal view returns (uint160 sqrtP, int24 tick) {
        bytes32 data =
            manager.extsload(keccak256(abi.encodePacked(PoolId.unwrap(_key(token).toId()), bytes32(uint256(6)))));
        assembly ("memory-safe") {
            sqrtP := and(data, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
            tick := signextend(2, shr(160, data))
        }
    }

    function _gradTick(address token) internal view returns (int24) {
        (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        return l.graduationTick;
    }

    // ─── Swap params ──────────────────────────────────────────────────────────

    function _sellExactIn(address token, uint256 tokensIn) internal view returns (SwapParams memory) {
        bool zeroForOne = !_usdcIs0(token);
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -int256(tokensIn),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _buyExactOut(address token, uint256 tokensOut) internal view returns (SwapParams memory) {
        bool zeroForOne = _usdcIs0(token);
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: int256(tokensOut),
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _opSwap(SwapParams memory p) internal pure returns (Flash.Op memory op) {
        op.kind = Flash.Kind.Swap;
        op.swap = p;
    }

    function _opDonateToken(address token, uint256 amount) internal view returns (Flash.Op memory op) {
        op.kind = Flash.Kind.Donate;
        if (_usdcIs0(token)) op.amount1 = amount;
        else op.amount0 = amount;
    }

    /// @dev Launch, have `sniper` buy `snipeUsdc` on the curve in the creation block (paying the curve surcharge), then
    ///      have bob sell the curve out after the curve's window. Returns in the graduation block.
    function _graduateWithCurveSnipe(uint16 creatorFeeBps, bool openPool, address sniper, uint256 snipeUsdc)
        internal
        returns (address token)
    {
        token = _launch(creatorFeeBps, creatorWallet, "", openPool, 0);
        if (snipeUsdc != 0) {
            vm.prank(sniper);
            pad.buy(token, snipeUsdc, 0, sniper, MAX);
        }
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        assertTrue(pad.isGraduated(token), "graduated");
    }
}
