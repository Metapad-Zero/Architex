// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Trades graduated launch tokens against USDC in their launch pools (V13-SPEC §4).
/// @notice Exact-in only. Both fees come from the USDC side, rounded up: on a buy from the USDC in, on a sell
///         from the USDC out. Fees are transferred to the launchpad and recorded with accrueTradeFees.
///         Sells pull the seller's tokens straight into the pool with the token's `pull` (no approval).
interface ILaunchRouter {
    error Expired();
    error UnknownToken();
    error NotGraduated();
    error SlippageExceeded();
    error ZeroAmount();

    function launchpad() external view returns (address);
    function factory() external view returns (address);
    function usdc() external view returns (address);

    function quoteBuy(address token, uint256 usdcIn) external view returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee);
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 usdcOut, uint256 platformFee, uint256 creatorFee);

    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline) external returns (uint256 tokensOut);
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline) external returns (uint256 usdcOut);
}
