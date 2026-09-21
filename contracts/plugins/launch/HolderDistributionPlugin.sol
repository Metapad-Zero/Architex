// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArchitexFeePlugin} from "../../interfaces/IArchitexFeePlugin.sol";
import {ILaunchTokenExtensions} from "../../interfaces/ILaunchTokenExtensions.sol";
import {ILaunchFeePlugin} from "../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IHolderDistributionPlugin} from "../../interfaces/plugins/IHolderDistributionPlugin.sol";
import {LaunchFeePluginBase} from "./LaunchFeePluginBase.sol";

/// @title HolderDistributionPlugin
/// @notice Pays each launch token's creator fees to that token's holders through the token's built-in USDC dividends
///         (V13-SPEC §2.2, §3, [D15], [D21]). Each delivery goes straight to the token's distribute, which streams it
///         to the eligible holders over 24 hours with continuous accrual, so a holder earns only for the time it
///         holds. Holders claim on the token.
/// @dev A forwarder: onFees pulls exactly `amount`, approves exactly `amount` to the token, calls its distribute and
///      checks exactly `amount` left, all in one call, so this plugin holds nothing between calls. The token's
///      distribute never reverts for lack of eligible supply, so nothing holder-side can make onFees revert (behind
///      a Combo, that would block the token's collections, [D10]).
contract HolderDistributionPlugin is IHolderDistributionPlugin, LaunchFeePluginBase {
    using SafeERC20 for IERC20;

    mapping(address token => uint256) private _distributed;

    constructor(address launchpad_) LaunchFeePluginBase(launchpad_) {}

    // ─── Hooks ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexFeePlugin
    /// @dev Takes no configuration: `data` must be empty.
    function onLaunch(address token, address creator, bytes calldata data) external nonReentrant {
        if (data.length != 0) revert DataNotEmpty();
        _configure(token, creator);
    }

    /// @inheritdoc IArchitexFeePlugin
    /// @dev Pulls exactly `amount` from the caller and passes all of it to the token's distribute. Zero is a no-op.
    function onFees(address token, uint256 amount) external nonReentrant {
        _requireConfigured(token);
        if (amount == 0) return;
        emit FeesReceived(token, msg.sender, amount);
        _distributed[token] += amount;
        emit Distributed(token, amount);
        _pullFees(amount);
        _pushToHolders(token, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IHolderDistributionPlugin
    function totalDistributed(address token) external view returns (uint256) {
        return _distributed[token];
    }

    /// @inheritdoc ILaunchFeePlugin
    /// @dev Always zero: onFees passes everything it pulls to the token in the same call.
    function usdcHeld(address) external pure returns (uint256) {
        return 0;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev The token's distribute pulls from its caller: approve exactly `amount`, then check it all went.
    function _pushToHolders(address token, uint256 amount) private {
        uint256 balanceBefore = USDC.balanceOf(address(this));
        USDC.forceApprove(token, amount);
        ILaunchTokenExtensions(token).distribute(amount);
        _checkExactPull(token, amount, balanceBefore);
    }
}
