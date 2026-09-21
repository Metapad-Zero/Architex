// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title A graduated launch token's pool: constant product token × USDC, no built-in fee (V13-SPEC §4).
/// @notice `swap` is callable only by the launch router, which charges the platform and creator fees.
///         `mint`/`burn` are open like any pool; graduation liquidity is minted to the burn address.
///         The contract is the pool's LP token (ERC-20). No flash swaps.
interface ILaunchPair is IERC20 {
    event Mint(address indexed sender, uint256 amountToken, uint256 amountUsdc);
    event Burn(address indexed sender, uint256 amountToken, uint256 amountUsdc, address indexed to);
    event Swap(address indexed sender, uint256 tokenIn, uint256 usdcIn, uint256 tokenOut, uint256 usdcOut, address indexed to);
    event Sync(uint112 reserveToken, uint112 reserveUsdc);

    error OnlyRouter();
    error Locked();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientInputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error K();
    error Overflow();

    function MINIMUM_LIQUIDITY() external pure returns (uint256);
    function factory() external view returns (address);
    function router() external view returns (address);
    function token() external view returns (address);
    function usdc() external view returns (address);
    function getReserves() external view returns (uint112 reserveToken, uint112 reserveUsdc, uint32 blockTimestampLast);

    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amountToken, uint256 amountUsdc);
    /// @notice Router only. Optimistic transfer out, then the constant-product check against balances.
    function swap(uint256 tokenOut, uint256 usdcOut, address to) external;
    function skim(address to) external;
    function sync() external;
}
