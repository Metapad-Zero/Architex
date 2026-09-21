// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Split: a token's creator fees shared among fixed payees by fixed shares (V13-SPEC §2.2, [D16]).
/// @notice onLaunch data: `abi.encode(address[] payees, uint256[] shares)`, canonically encoded (viem's
///         encodeAbiParameters produces this). 1 to 20 payees, each distinct, none of them the zero address,
///         this plugin, the launchpad, USDC or the token; every share above zero.
///         Pull-based per token: `releasable(token, payee) = totalReceived(token) * share / totalShares(token)
///         - released(token, payee)`. Anyone may call release for any payee; the USDC always goes to the payee.
///         Rounding dust (at most one unit per payee per token) stays in the plugin.
interface ISplitPlugin is ILaunchFeePlugin {
    event SplitConfigured(address indexed token, address[] payees, uint256[] shares);
    event Released(address indexed token, address indexed payee, uint256 amount);

    error InvalidPayeeCount(uint256 count);
    error ZeroShare(address payee);
    error DuplicatePayee(address payee);
    error NothingToRelease(address token, address payee);

    /// @notice 20.
    function MAX_PAYEES() external view returns (uint256);

    /// @notice The token's payees and their shares, in configuration order. Empty for an unconfigured token.
    function payeesOf(address token) external view returns (address[] memory payees, uint256[] memory shares);
    /// @notice `payee`'s share of `token`'s fees (0 if not a payee).
    function sharesOf(address token, address payee) external view returns (uint256);
    function totalShares(address token) external view returns (uint256);
    /// @notice All USDC ever credited to `token`.
    function totalReceived(address token) external view returns (uint256);
    /// @notice All USDC ever paid out for `token`.
    function totalReleased(address token) external view returns (uint256);
    /// @notice USDC paid out to `payee` for `token` so far.
    function released(address token, address payee) external view returns (uint256);
    /// @notice USDC `payee` can be paid for `token` right now.
    function releasable(address token, address payee) external view returns (uint256);

    /// @notice Pays `payee` everything releasable for `token`. Callable by anyone. Reverts NothingToRelease if 0.
    function release(address token, address payee) external returns (uint256 amount);
}
