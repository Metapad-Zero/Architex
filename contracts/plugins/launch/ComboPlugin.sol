// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IArchitexFeePlugin} from "../../interfaces/IArchitexFeePlugin.sol";
import {ILaunchFeePlugin} from "../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IComboPlugin} from "../../interfaces/plugins/IComboPlugin.sol";
import {LaunchFeePluginBase} from "./LaunchFeePluginBase.sol";

/// @title ComboPlugin
/// @notice Splits each launch token's creator fees across up to 5 destinations by basis points, set once at launch
///         (V13-SPEC §2, [D6]). A destination that declares IArchitexFeePlugin is configured through its onLaunch
///         (it accepts because this Combo is the token's registered plugin) and paid through its onFees hook, which
///         must pull exactly its slice. Any other destination is paid by plain transfer.
/// @dev The Combo holds nothing between calls: onFees pulls `amount` and forwards all of it before returning.
///      Whether a destination is a plugin is decided once, at onLaunch, and stored, so a destination can never
///      switch between being configured and being paid by transfer.
contract ComboPlugin is IComboPlugin, LaunchFeePluginBase {
    using SafeERC20 for IERC20;

    /// @inheritdoc IComboPlugin
    uint256 public constant MAX_ENTRIES = 5;
    /// @inheritdoc IComboPlugin
    uint256 public constant TOTAL_BPS = 10_000;

    struct Entry {
        address target;
        uint16 bps;
        bool isPlugin;
    }

    mapping(address token => Entry[]) private _entries;

    constructor(address launchpad_) LaunchFeePluginBase(launchpad_) {}

    // ─── Hooks ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexFeePlugin
    /// @dev `data` = abi.encode(address[] targets, uint16[] bps, bytes[] datas), canonically encoded. Stores the
    ///      allocation, then configures each plugin entry with its data. Any entry's revert reverts the launch.
    function onLaunch(address token, address creator, bytes calldata data) external nonReentrant {
        _configure(token, creator);

        (address[] memory targets, uint16[] memory bps, bytes[] memory datas) =
            abi.decode(data, (address[], uint16[], bytes[]));
        if (keccak256(abi.encode(targets, bps, datas)) != keccak256(data)) revert NonCanonicalData();
        bool[] memory isPlugin = _checkAllocation(token, targets, bps, datas);

        Entry[] storage entries = _entries[token];
        uint256 count = targets.length;
        for (uint256 i; i < count; ++i) {
            entries.push(Entry({target: targets[i], bps: bps[i], isPlugin: isPlugin[i]}));
        }
        emit ComboConfigured(token, targets, bps, isPlugin);

        for (uint256 i; i < count; ++i) {
            if (isPlugin[i]) IArchitexFeePlugin(targets[i]).onLaunch(token, creator, datas[i]);
        }
    }

    /// @inheritdoc IArchitexFeePlugin
    /// @dev Pulls exactly `amount` from the caller and forwards all of it. A plugin entry is approved for exactly
    ///      its slice and must pull exactly that, leaving no allowance, or the whole call reverts. Zero is a no-op.
    function onFees(address token, uint256 amount) external nonReentrant {
        _requireConfigured(token);
        if (amount == 0) return;
        emit FeesReceived(token, msg.sender, amount);
        _pullFees(amount);

        Entry[] storage entries = _entries[token];
        uint256[] memory slices = _split(entries, amount);
        uint256 count = slices.length;
        for (uint256 i; i < count; ++i) {
            uint256 slice = slices[i];
            if (slice == 0) continue;
            Entry memory entry = entries[i];
            emit FeesForwarded(token, entry.target, slice, entry.isPlugin);
            if (entry.isPlugin) {
                uint256 balanceBefore = USDC.balanceOf(address(this));
                USDC.forceApprove(entry.target, slice);
                IArchitexFeePlugin(entry.target).onFees(token, slice);
                _checkExactPull(entry.target, slice, balanceBefore);
            } else {
                USDC.safeTransfer(entry.target, slice);
            }
        }
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IComboPlugin
    function allocationOf(address token)
        external
        view
        returns (address[] memory targets, uint16[] memory bps, bool[] memory isPlugin)
    {
        Entry[] storage entries = _entries[token];
        uint256 count = entries.length;
        targets = new address[](count);
        bps = new uint16[](count);
        isPlugin = new bool[](count);
        for (uint256 i; i < count; ++i) {
            Entry storage entry = entries[i];
            targets[i] = entry.target;
            bps[i] = entry.bps;
            isPlugin[i] = entry.isPlugin;
        }
    }

    /// @inheritdoc IComboPlugin
    function previewSplit(address token, uint256 amount) external view returns (uint256[] memory slices) {
        return _split(_entries[token], amount);
    }

    /// @inheritdoc ILaunchFeePlugin
    /// @dev Always zero: onFees forwards everything it pulls in the same call.
    function usdcHeld(address) external pure returns (uint256) {
        return 0;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Validates an allocation and decides, once and for good, which entries are plugins (ERC-165).
    ///      Runs before anything is stored. Calls in a loop are bounded by MAX_ENTRIES.
    function _checkAllocation(address token, address[] memory targets, uint16[] memory bps, bytes[] memory datas)
        private
        view
        returns (bool[] memory isPlugin)
    {
        uint256 count = targets.length;
        if (count == 0 || count > MAX_ENTRIES) revert InvalidEntryCount(count);
        if (bps.length != count || datas.length != count) revert LengthMismatch();

        isPlugin = new bool[](count);
        uint256 sum = 0;
        for (uint256 i; i < count; ++i) {
            address target = targets[i];
            _checkRecipient(token, target); // also rejects this Combo itself
            for (uint256 j; j < i; ++j) {
                if (targets[j] == target) revert DuplicateEntry(target);
            }
            if (bps[i] == 0) revert ZeroBps(target);
            sum += bps[i];
            isPlugin[i] = ERC165Checker.supportsInterface(target, type(IArchitexFeePlugin).interfaceId);
            // Data for an address that turned out not to be a plugin would be silently dropped.
            if (!isPlugin[i] && datas[i].length != 0) revert DataForNonPlugin(target);
        }
        if (sum != TOTAL_BPS) revert BpsSumNot10000(sum);
    }

    /// @dev `amount * bps / 10,000` per entry, the last entry taking the rounding remainder: sums to `amount`.
    function _split(Entry[] storage entries, uint256 amount) private view returns (uint256[] memory slices) {
        uint256 count = entries.length;
        slices = new uint256[](count);
        uint256 remaining = amount;
        for (uint256 i; i < count; ++i) {
            uint256 slice = i + 1 == count ? remaining : (amount * entries[i].bps) / TOTAL_BPS;
            remaining -= slice;
            slices[i] = slice;
        }
    }
}
