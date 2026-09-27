// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../../contracts/interfaces/ILaunchTokenExtensions.sol";

/// @title ILaunchTokenV14
/// @notice The v1.4 launch token: v1.3's (burn, streamed USDC dividends, pull) with the launch pair replaced by Uniswap
///         v4. Every graduated token trades in a pool the PoolManager holds, so the PoolManager is what never earns
///         dividends and what cannot receive tokens before graduation.
interface ILaunchTokenV14 is IERC20, ILaunchTokenExtensions {
    error OnlyLaunchpad();
    error OnlyLaunchpadOrRouter();
    error InvalidPullTarget();
    error AlreadyGraduated();
    error PoolLockedUntilGraduation();

    /// @notice The v1.4 launchpad that deployed this token and holds the curve inventory.
    function launchpad() external view returns (address);
    /// @notice The Architex v4 router, which may pull a seller's tokens into the PoolManager.
    function router() external view returns (address);
    /// @notice Uniswap v4's PoolManager on this chain.
    function poolManager() external view returns (address);
    /// @notice The Architex launch hook, which holds tokens only inside the graduation transaction.
    function hook() external view returns (address);
    function graduated() external view returns (bool);
    function MIN_ELIGIBLE_SUPPLY() external view returns (uint256);
    function claimed(address holder) external view returns (uint256);
    function markGraduated() external;
    /// @notice Launchpad: `from` into the launchpad (curve sells). Router: `from` into the PoolManager (pool sells).
    function pull(address from, address to, uint256 amount) external;
}
