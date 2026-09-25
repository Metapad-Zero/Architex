// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IArchitexV4Router} from "./interfaces/IArchitexV4Router.sol";
import {IArchitexLaunchHook} from "./interfaces/IArchitexLaunchHook.sol";
import {IArchitexLaunchpadV14} from "./interfaces/IArchitexLaunchpadV14.sol";
import {ILaunchTokenV14} from "./interfaces/ILaunchTokenV14.sol";

/// @title ArchitexV4Router
/// @notice See IArchitexV4Router. Stateless: every swap is one PoolManager unlock that swaps, pays what the router owes
///         (USDC by transferFrom from the buyer, tokens by the token's pull from the seller) and takes the output
///         straight to the recipient. Slippage is bounded by the minimum out, not a price limit, so the hook never sees a
///         partial fill.
contract ArchitexV4Router is IArchitexV4Router, IUnlockCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint8 private constant _BUY = 1;
    uint8 private constant _SELL = 2;

    /// @inheritdoc IArchitexV4Router
    address public immutable launchpad;
    /// @inheritdoc IArchitexV4Router
    address public immutable usdc;
    /// @inheritdoc IArchitexV4Router
    address public immutable poolManager;

    struct Swap {
        uint8 side;
        bool quote; // simulate, then revert with the output
        address payer;
        address token;
        uint256 amountIn;
        uint256 minOut;
        address to;
    }

    constructor(address launchpad_, address usdc_, address poolManager_) {
        launchpad = launchpad_;
        usdc = usdc_;
        poolManager = poolManager_;
    }

    /// @inheritdoc IArchitexV4Router
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        tokensOut = _run(Swap(_BUY, false, msg.sender, token, usdcIn, minTokensOut, to));
    }

    /// @inheritdoc IArchitexV4Router
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline)
        external
        returns (uint256 usdcOut)
    {
        if (block.timestamp > deadline) revert Expired();
        usdcOut = _run(Swap(_SELL, false, msg.sender, token, tokensIn, minUsdcOut, to));
    }

    /// @inheritdoc IArchitexV4Router
    function quoteBuy(address token, uint256 usdcIn) external returns (uint256 tokensOut) {
        return _quote(Swap(_BUY, true, msg.sender, token, usdcIn, 0, msg.sender));
    }

    /// @inheritdoc IArchitexV4Router
    function quoteSell(address token, uint256 tokensIn) external returns (uint256 usdcOut) {
        return _quote(Swap(_SELL, true, msg.sender, token, tokensIn, 0, msg.sender));
    }

    /// @notice The PoolManager's callback: swap, pay, take.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != poolManager) revert OnlyPoolManager();
        Swap memory s = abi.decode(data, (Swap));
        PoolKey memory key = IArchitexLaunchHook(IArchitexLaunchpadV14(launchpad).hook()).poolKeyOf(s.token);
        bool usdcIs0 = Currency.unwrap(key.currency0) == usdc;
        // A buy swaps USDC for the token; zeroForOne when USDC is currency0.
        bool zeroForOne = (s.side == _BUY) == usdcIs0;
        BalanceDelta delta = IPoolManager(poolManager).swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -(s.amountIn.toInt256()),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        // Pay what the swap actually consumed (all of amountIn, unless the price limit stopped it) and take what it
        // gave: a swap that stops early then settles instead of reverting, and the trader keeps the rest.
        uint256 amountIn = uint256(uint128(-(zeroForOne ? delta.amount0() : delta.amount1())));
        uint256 amountOut = uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
        if (s.quote) revert Quote(amountOut);
        if (amountOut < s.minOut) revert SlippageExceeded();

        (address payToken, address outToken) = s.side == _BUY ? (usdc, s.token) : (s.token, usdc);
        if (amountIn != 0) {
            IPoolManager(poolManager).sync(Currency.wrap(payToken));
            if (s.side == _BUY) {
                IERC20(usdc).safeTransferFrom(s.payer, poolManager, amountIn);
            } else {
                ILaunchTokenV14(s.token).pull(s.payer, poolManager, amountIn);
            }
            IPoolManager(poolManager).settle();
        }
        if (amountOut != 0) IPoolManager(poolManager).take(Currency.wrap(outToken), s.to, amountOut);
        return abi.encode(amountOut);
    }

    function _run(Swap memory s) private returns (uint256 amountOut) {
        if (!IArchitexLaunchpadV14(launchpad).isGraduated(s.token)) revert NotGraduated();
        amountOut = abi.decode(IPoolManager(poolManager).unlock(abi.encode(s)), (uint256));
    }

    /// @dev Runs the swap inside an unlock that reverts with the output, so nothing is kept (the v4 Quoter's pattern).
    function _quote(Swap memory s) private returns (uint256 amountOut) {
        if (!IArchitexLaunchpadV14(launchpad).isGraduated(s.token)) revert NotGraduated();
        try IPoolManager(poolManager).unlock(abi.encode(s)) {
            // unreachable: a quote always reverts
        } catch (bytes memory reason) {
            if (reason.length == 36 && bytes4(reason) == Quote.selector) {
                assembly ("memory-safe") {
                    amountOut := mload(add(reason, 36))
                }
                return amountOut;
            }
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}
