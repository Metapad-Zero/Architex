// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV3Callback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

contract MintableToken is ERC20 {
    uint8 private immutable digits;
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) { digits = decimals_; }
    function decimals() public view override returns (uint8) { return digits; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// Constant-product pair with the Architex/Uniswap v2 balance-delta swap and 0.30% fee, so the
/// keeper's bound checks are exercised against the same accounting the real pair uses. Real pool
/// behaviour is proven on forks; this mock exists to drive the guard paths deterministically.
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;

    constructor(address tokenA, address tokenB) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
    function getReserves() external view returns (uint112, uint112, uint32) { return (reserve0, reserve1, 0); }
    function sync() public {
        reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
    }
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out < reserve0 && amount1Out < reserve1, "Insufficient liquidity");
        if (amount0Out > 0) require(IERC20(token0).transfer(to, amount0Out), "t0");
        if (amount1Out > 0) require(IERC20(token1).transfer(to, amount1Out), "t1");
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 in0 = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0;
        uint256 in1 = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0;
        require(in0 > 0 || in1 > 0, "No input");
        require(
            (balance0 * 1000 - in0 * 3) * (balance1 * 1000 - in1 * 3) >= uint256(reserve0) * uint256(reserve1) * 1_000_000,
            "K"
        );
        sync();
    }
}

/// Uniswap v3 swap surface over constant-product reserves: exact input when `amountSpecified` is
/// positive, exact output when negative, deltas signed as the real pool signs them, and the callback
/// invoked before the input is checked.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint256 public reserve0;
    uint256 public reserve1;
    /// Fills only this fraction of a requested exact output, in basis points, to model a short fill.
    uint256 public fillBps = 10_000;

    constructor(address tokenA, address tokenB) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
    function sync() public {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
    }
    function setFillBps(uint256 bps) external { fillBps = bps; }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external returns (int256 amount0, int256 amount1)
    {
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        uint256 amountIn;
        uint256 amountOut;
        if (amountSpecified > 0) {
            amountIn = uint256(amountSpecified);
            uint256 withFee = amountIn * 997;
            amountOut = (withFee * reserveOut) / (reserveIn * 1000 + withFee);
        } else {
            amountOut = (uint256(-amountSpecified) * fillBps) / 10_000;
            require(amountOut < reserveOut, "Insufficient liquidity");
            amountIn = (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
        }
        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;
        require(IERC20(tokenOut).transfer(recipient, amountOut), "out");
        (amount0, amount1) = zeroForOne ? (int256(amountIn), -int256(amountOut)) : (-int256(amountOut), int256(amountIn));
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        IV3Callback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(tokenIn).balanceOf(address(this)) >= before + amountIn, "Input not paid");
        sync();
    }
}
