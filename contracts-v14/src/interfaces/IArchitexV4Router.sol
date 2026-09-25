// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IArchitexV4Router
/// @notice Exact-in buys and sells of graduated v1.4 launch tokens in their Uniswap v4 pools, for architex.fun and for
///         plugins. The hook charges every fee, so this router adds none: any other v4 router (the Universal Router, an
///         aggregator's) pays exactly the same. What this one adds is that a sell needs no approval (the token lets it
///         pull the seller's tokens into the PoolManager, always from its own caller) and quotes that include the fees.
interface IArchitexV4Router {
    error Expired();
    error SlippageExceeded();
    error NotGraduated();
    error OnlyPoolManager();
    /// @dev Carries a quote out of a simulated swap.
    error Quote(uint256 amountOut);

    function launchpad() external view returns (address);
    function usdc() external view returns (address);
    function poolManager() external view returns (address);

    /// @notice Spends exactly `usdcIn` USDC (fees included) on `token`, sending at least `minTokensOut` to `to`.
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        returns (uint256 tokensOut);

    /// @notice Sells exactly `tokensIn` of `token` from the caller, sending at least `minUsdcOut` USDC (after fees) to
    ///         `to`. No approval needed.
    function sell(address token, uint256 tokensIn, uint256 minUsdcOut, address to, uint256 deadline)
        external
        returns (uint256 usdcOut);

    /// @notice What `buy` would give now. Not a view (it simulates the swap and reverts): call it with eth_call.
    function quoteBuy(address token, uint256 usdcIn) external returns (uint256 tokensOut);

    /// @notice What `sell` would pay now, after fees. Not a view: call it with eth_call.
    function quoteSell(address token, uint256 tokensIn) external returns (uint256 usdcOut);
}
