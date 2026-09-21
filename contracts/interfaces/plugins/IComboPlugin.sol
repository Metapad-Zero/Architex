// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Combo: a token's creator fees split across up to 5 destinations by basis points (V13-SPEC §2, [D6]).
/// @notice onLaunch data: `abi.encode(address[] targets, uint16[] bps, bytes[] datas)`, canonically encoded
///         (viem's encodeAbiParameters produces this). 1 to 5 entries, each distinct, none of them the zero
///         address, this plugin, the launchpad, USDC, the token, any launch pair, the launch router, the pair factory
///         or any launch token; every bps above zero, summing to exactly 10,000.
///         A target that declares IArchitexFeePlugin through ERC-165 (checked once, at onLaunch, and remembered)
///         is configured with its `datas[i]` and paid through its onFees hook, which must pull exactly its slice.
///         Any other target (a wallet, a Safe) is paid by plain transfer and must have empty `datas[i]`.
///         Slices are `amount * bps / 10,000`, the last entry taking the rounding remainder, so they sum to
///         exactly `amount`; zero slices are skipped. The Combo keeps nothing between calls.
interface IComboPlugin is ILaunchFeePlugin {
    event ComboConfigured(address indexed token, address[] targets, uint16[] bps, bool[] isPlugin);
    /// @notice `amount` of `token`'s fees went to `target`, through its onFees hook if `viaHook`.
    event FeesForwarded(address indexed token, address indexed target, uint256 amount, bool viaHook);

    error InvalidEntryCount(uint256 count);
    error ZeroBps(address target);
    error BpsSumNot10000(uint256 sum);
    error DuplicateEntry(address target);
    /// @notice `target` does not declare IArchitexFeePlugin, so it takes no configuration data.
    error DataForNonPlugin(address target);

    /// @notice 5.
    function MAX_ENTRIES() external view returns (uint256);
    /// @notice 10,000: an allocation's bps must sum to exactly this.
    function TOTAL_BPS() external view returns (uint256);

    /// @notice The token's allocation, in configuration order. Empty for an unconfigured token.
    function allocationOf(address token)
        external
        view
        returns (address[] memory targets, uint16[] memory bps, bool[] memory isPlugin);

    /// @notice How onFees would split `amount` for `token`, entry by entry. Empty for an unconfigured token.
    function previewSplit(address token, uint256 amount) external view returns (uint256[] memory slices);
}
