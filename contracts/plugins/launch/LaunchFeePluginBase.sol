// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArchitexFeePlugin} from "../../interfaces/IArchitexFeePlugin.sol";
import {IArchitexLaunchpadLite} from "../../interfaces/IArchitexLaunchpadLite.sol";
import {ILaunchFeePlugin} from "../../interfaces/plugins/ILaunchFeePlugin.sol";

/// @title LaunchFeePluginBase
/// @notice What every Architex reference creator-fee plugin must get identically right (V13-SPEC §2.1):
///         - who may configure a token: the launchpad, for a token whose plugin is this contract, or the token's
///           registered plugin (a Combo configuring its entries);
///         - configuration is write-once per token;
///         - fees are accepted only for configured tokens, from any caller, and are pulled from that caller in the
///           same call, so every credit is backed by USDC received;
///         - ERC-165 support for IArchitexFeePlugin.
/// @dev No owner, no admin, no pause, no upgrade and no sweep: nobody can redirect a token's fees.
///      USDC is accounted per token in each plugin's own storage, never inferred from this contract's balance.
abstract contract LaunchFeePluginBase is ILaunchFeePlugin, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IArchitexLaunchpadLite internal immutable LAUNCHPAD;
    IERC20 internal immutable USDC;

    mapping(address token => bool) private _configured;

    /// @param launchpad_ The v1.3 launchpad. USDC is read from it; the launch router is read from it when needed,
    ///        because the launchpad only learns its router in initialize().
    constructor(address launchpad_) {
        if (launchpad_ == address(0)) revert ZeroAddress();
        address usdc_ = IArchitexLaunchpadLite(launchpad_).usdc();
        if (usdc_ == address(0)) revert ZeroAddress();
        LAUNCHPAD = IArchitexLaunchpadLite(launchpad_);
        USDC = IERC20(usdc_);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc ILaunchFeePlugin
    function launchpad() external view returns (address) {
        return address(LAUNCHPAD);
    }

    /// @inheritdoc ILaunchFeePlugin
    function usdc() external view returns (address) {
        return address(USDC);
    }

    /// @inheritdoc ILaunchFeePlugin
    function isConfigured(address token) public view returns (bool) {
        return _configured[token];
    }

    /// @inheritdoc IERC165
    /// @dev True for IArchitexFeePlugin and IERC165 only, so false for 0xffffffff as ERC-165 requires.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IArchitexFeePlugin).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Authenticates an onLaunch call and marks `token` configured, once.
    ///      Launch-token addresses are predictable, so without this check anyone could configure a plugin for a
    ///      token that is about to be created. Two callers are accepted:
    ///        - the launchpad, for a token whose registered plugin is this contract (createToken registers the
    ///          curve, plugin included, before it calls onLaunch);
    ///        - the token's registered plugin itself: a Combo configuring the plugins it splits fees across.
    ///      A token that was never launched has no registered plugin (pluginOf returns zero) and is rejected.
    function _configure(address token, address creator) internal {
        if (_configured[token]) revert AlreadyConfigured(token);
        address registered = LAUNCHPAD.pluginOf(token);
        if (registered == address(0)) revert UnknownToken(token);
        if (msg.sender == address(LAUNCHPAD)) {
            if (registered != address(this)) revert NotTokenPlugin(token);
        } else if (msg.sender != registered) {
            revert Unauthorized(msg.sender);
        }
        _configured[token] = true;
        emit Configured(token, creator);
    }

    /// @dev onFees accepts any caller, because the pull backs every credit, but only for a configured token.
    function _requireConfigured(address token) internal view {
        if (!_configured[token]) revert NotConfigured(token);
    }

    /// @dev Pulls exactly `amount` USDC from the onFees caller. Reverts unless the caller approved it.
    function _pullFees(uint256 amount) internal {
        USDC.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @dev Rejects fee recipients where USDC would be stranded, would break this plugin's per-token accounting, or
    ///      could be taken by anyone: the zero address, this plugin, the launchpad, USDC itself, the token, any launch
    ///      pair (a plain transfer into one can be skimmed by anyone; the token's own pair is registered before
    ///      onLaunch runs), the launch router, the pair factory, and any launch token. Reads only the launchpad, never
    ///      the recipient.
    function _checkRecipient(address token, address recipient) internal view {
        if (
            recipient == address(0) || recipient == address(this) || recipient == address(LAUNCHPAD)
                || recipient == address(USDC) || recipient == token || LAUNCHPAD.isLaunchPair(recipient)
                || recipient == LAUNCHPAD.router() || recipient == LAUNCHPAD.pairFactory()
                || LAUNCHPAD.pluginOf(recipient) != address(0)
        ) revert InvalidRecipient(recipient);
    }

    /// @dev After approving `spender` for exactly `amount` and calling it, checks that exactly `amount` left this
    ///      contract and that the allowance is back to zero. `balanceBefore` is this contract's USDC balance taken
    ///      just before the approval.
    function _checkExactPull(address spender, uint256 amount, uint256 balanceBefore) internal view {
        uint256 balanceAfter = USDC.balanceOf(address(this));
        if (balanceAfter + amount != balanceBefore) {
            revert PullMismatch(spender, amount, balanceBefore > balanceAfter ? balanceBefore - balanceAfter : 0);
        }
        if (USDC.allowance(address(this), spender) != 0) revert AllowanceNotConsumed(spender);
    }
}
