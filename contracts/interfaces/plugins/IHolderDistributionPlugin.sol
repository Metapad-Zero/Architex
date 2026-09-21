// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Distribute to holders: a token's creator fees paid to its holders pro-rata as USDC dividends through
///        the token's built-in tracker (V13-SPEC §2.2, §3, [D15]).
/// @notice onLaunch data must be empty. On onFees the plugin pulls the USDC and, if the token has eligible supply,
///         immediately calls the token's distribute with everything it holds for that token. With no eligible
///         supply (distribute would revert) it holds the USDC for the token; anyone may flush(token) once there
///         is eligible supply. Holders then claim on the token itself (claimable / claim / claimFor).
interface IHolderDistributionPlugin is ILaunchFeePlugin {
    /// @notice No eligible supply yet: `heldTotal` USDC now waits for `token`.
    event FeesHeld(address indexed token, uint256 heldTotal);
    /// @notice `amount` USDC was distributed to `token`'s holders.
    event Distributed(address indexed token, uint256 amount);

    error NothingToFlush(address token);
    error NoEligibleSupply(address token);

    /// @notice All USDC this plugin has distributed to `token`'s holders.
    function totalDistributed(address token) external view returns (uint256);

    /// @notice Distributes everything held for `token` to its holders. Callable by anyone. Reverts NothingToFlush
    ///         if nothing is held and NoEligibleSupply if the token still has no eligible supply.
    function flush(address token) external returns (uint256 amount);
}
