// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IArchitexFeePlugin} from "../IArchitexFeePlugin.sol";

/// @title What every Architex reference creator-fee plugin exposes (docs/launchpad/V13-SPEC.md §2.1, §2.2).
/// @notice The reference plugins are singletons: one deployment serves every launch token that picks it, and
///         configuration and USDC are accounted per token. A token is configured once, by the launchpad inside
///         createToken or by the token's registered plugin (a Combo), and the configuration never changes.
///         Fees arrive through onFees, which pulls exactly the amount it credits from its caller.
interface ILaunchFeePlugin is IArchitexFeePlugin {
    /// @notice `token` was configured for this plugin. `creator` is as passed by the configuring caller.
    event Configured(address indexed token, address indexed creator);
    /// @notice `amount` USDC was pulled from `from` and credited to `token`.
    event FeesReceived(address indexed token, address indexed from, uint256 amount);

    error ZeroAddress();
    /// @notice `token` was never launched on the launchpad (it has no registered plugin).
    error UnknownToken(address token);
    /// @notice The launchpad called onLaunch for a token whose registered plugin is not this contract.
    error NotTokenPlugin(address token);
    /// @notice The onLaunch caller is neither the launchpad nor the token's registered plugin.
    error Unauthorized(address caller);
    error AlreadyConfigured(address token);
    error NotConfigured(address token);
    /// @notice This plugin takes no configuration, so its onLaunch data must be empty.
    error DataNotEmpty();
    /// @notice The onLaunch data is not the canonical ABI encoding of the plugin's configuration types.
    error NonCanonicalData();
    error LengthMismatch();
    /// @notice The address cannot receive fees: zero, this plugin, the launchpad, USDC, the token itself, any launch
    ///         pair, the launch router, the pair factory, or any launch token.
    error InvalidRecipient(address recipient);
    /// @notice A contract this plugin paid through an allowance did not pull exactly `expected` USDC.
    error PullMismatch(address puller, uint256 expected, uint256 actual);
    /// @notice A contract this plugin paid through an allowance left part of the allowance unused.
    error AllowanceNotConsumed(address spender);

    /// @notice The launchpad this plugin serves (fixed at deployment).
    function launchpad() external view returns (address);
    /// @notice The fee asset, read from the launchpad at deployment.
    function usdc() external view returns (address);
    /// @notice True once `token` has been configured for this plugin; only configured tokens accept fees.
    function isConfigured(address token) external view returns (bool);
    /// @notice USDC this plugin currently holds for `token`: credited and not yet paid out, spent or distributed.
    ///         The plugin's USDC balance equals the sum of this over all tokens, plus anything sent to it directly
    ///         (a direct transfer is not credited to any token and stays in the plugin).
    function usdcHeld(address token) external view returns (uint256);
}
