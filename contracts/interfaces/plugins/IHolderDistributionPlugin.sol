// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Distribute to holders: a token's creator fees paid to its holders as USDC dividends through the token's
///        built-in tracker (V13-SPEC §2.2, §3, [D15], [D21]).
/// @notice onLaunch data must be empty. onFees pulls exactly `amount` from its caller and passes it straight to the
///         token's distribute, which streams it to the eligible holders over the token's DRIP_PERIOD with
///         continuous accrual: each holder earns only for the time it holds, so nobody can buy, collect, claim and
///         sell in one transaction for a share. The stream, what is claimable and the claim itself all live on the
///         token (claimable / claim / claimFor, streamRate / streamEnd / undistributed); this plugin holds nothing
///         between calls (usdcHeld is always 0). onFees never reverts for anything holder-side: the token's
///         distribute accepts fees with no eligible supply and streams them once there are holders.
interface IHolderDistributionPlugin is ILaunchFeePlugin {
    /// @notice `amount` USDC was passed to `token`'s distribute.
    event Distributed(address indexed token, uint256 amount);

    /// @notice All USDC this plugin has passed to `token`'s distribute.
    function totalDistributed(address token) external view returns (uint256);
}
