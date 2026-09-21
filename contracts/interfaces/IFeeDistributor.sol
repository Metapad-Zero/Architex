// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title The Architex fee-distribution plugin interface.
/// @dev A plugin is anything usable as `feeTo` on `ArchitexFactory` or `ArchitexLaunchpad`. Both
///      only ever pay a plugin with a plain ERC-20 `transfer`/`_mint` — no hook is called on the
///      recipient, so a plugin can never block or revert a fee accrual no matter what it does
///      internally. The one rule that matters is on the way out: distribution must be pull-based
///      (a payee, or anyone on their behalf, calls `release`) so one payee can never block
///      another's withdrawal. See `docs/plugins/CONTRIBUTING.md`.
///      This interface is how the marketplace UI and other contracts read a plugin's state; a
///      plugin does not have to implement it to work as `feeTo` (a plain multisig works fine),
///      but it must to be listed in the registry.
interface IFeeDistributor {
    event Released(address indexed token, address indexed payee, uint256 amount);

    /// @notice The fixed set of addresses this plugin ever pays out to.
    function payees() external view returns (address[] memory);

    /// @notice `token` amount `payee` could withdraw right now via `release`.
    function releasable(address token, address payee) external view returns (uint256);

    /// @notice Pull `payee`'s owed share of this plugin's `token` balance to them.
    ///         Callable by anyone, for any payee — payment is a fact about the plugin's
    ///         accounting, not a permission `payee` needs to hold.
    function release(address token, address payee) external;
}
