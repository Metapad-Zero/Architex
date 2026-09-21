// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The part of the v1.3 launchpad that plugins and the launch router rely on.
/// @notice The v1.3 `IArchitexLaunchpad` extends this. Per-token views return zero values for an address that
///         was never launched (they do not revert), so plugins can use them in authorization checks.
interface IArchitexLaunchpadLite {
    function usdc() external view returns (address);
    /// @notice The launch router, set once by initialize().
    function router() external view returns (address);
    /// @notice The launch-pair factory, set once by initialize(). It creates pairs for the launchpad only.
    function pairFactory() external view returns (address);
    /// @notice True for every launch pair, live or graduated: the launchpad records each one as createToken creates
    ///         it, and no launch pair is created anywhere else. False for any other address. A plain transfer into a
    ///         launch pair can be taken by anyone with skim(), so neither the launchpad nor a plugin sends fees to one.
    function isLaunchPair(address account) external view returns (bool);
    /// @notice Platform fee in basis points (50 = 0.5%), charged on every curve and launch-pool trade.
    function FEE_BPS() external view returns (uint256);

    function pluginOf(address token) external view returns (address);
    function creatorOf(address token) external view returns (address);
    function creatorFeeBpsOf(address token) external view returns (uint16);
    /// @notice The token's launch pair (from the launch-pair factory), created at launch.
    function pairOf(address token) external view returns (address);
    function isGraduated(address token) external view returns (bool);
    /// @notice The curve's virtual USDC reserve (6 decimals); 0 for an unknown token.
    function virtualUsdcOf(address token) external view returns (uint256);

    /// @notice Curve buy (see IArchitexLaunchpad). Pulls up to `usdcIn` USDC from msg.sender. Reverts Expired if
    ///         block.timestamp > deadline (the launch router's rule).
    function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        returns (uint256 tokensOut, uint256 usdcSpent);

    /// @notice Router only: records launch-pool fees the router has already transferred to the launchpad.
    function accrueTradeFees(address token, uint256 platformFee, uint256 creatorFee) external;
}
