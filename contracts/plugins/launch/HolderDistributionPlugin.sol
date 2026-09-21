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
/// @notice Pays each launch token's creator fees to that token's holders, pro-rata, through the token's built-in
///         USDC dividend tracker (V13-SPEC §2.2, §3, [D15]). Holders claim on the token.
/// @dev The token's distribute reverts when it has no eligible supply, so fees that arrive then are held for the
///      token and go out with the next delivery, or with flush(token), once there is eligible supply.
contract HolderDistributionPlugin is IHolderDistributionPlugin, LaunchFeePluginBase {
    using SafeERC20 for IERC20;

    mapping(address token => uint256) private _held;
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
    /// @dev Pulls exactly `amount` from the caller. With eligible supply, distributes it together with anything
    ///      held for the token; without, holds it. Zero is a no-op.
    function onFees(address token, uint256 amount) external nonReentrant {
        _requireConfigured(token);
        if (amount == 0) return;
        emit FeesReceived(token, msg.sender, amount);

        uint256 total = _held[token] + amount;
        if (ILaunchTokenExtensions(token).eligibleSupply() == 0) {
            _held[token] = total;
            emit FeesHeld(token, total);
            _pullFees(amount);
        } else {
            _held[token] = 0;
            _distributed[token] += total;
            emit Distributed(token, total);
            _pullFees(amount);
            _pushToHolders(token, total);
        }
    }

    // ─── Flush ────────────────────────────────────────────────────────────────

    /// @inheritdoc IHolderDistributionPlugin
    function flush(address token) external nonReentrant returns (uint256 amount) {
        _requireConfigured(token);
        amount = _held[token];
        if (amount == 0) revert NothingToFlush(token);
        if (ILaunchTokenExtensions(token).eligibleSupply() == 0) revert NoEligibleSupply(token);
        _held[token] = 0;
        _distributed[token] += amount;
        emit Distributed(token, amount);
        _pushToHolders(token, amount);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IHolderDistributionPlugin
    function totalDistributed(address token) external view returns (uint256) {
        return _distributed[token];
    }

    /// @inheritdoc ILaunchFeePlugin
    function usdcHeld(address token) external view returns (uint256) {
        return _held[token];
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
