// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IArchitexFeePlugin} from "../../interfaces/IArchitexFeePlugin.sol";
import {ILaunchTokenExtensions} from "../../interfaces/ILaunchTokenExtensions.sol";
import {ILaunchFeePlugin} from "../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IHolderDistributionPlugin} from "../../interfaces/plugins/IHolderDistributionPlugin.sol";
import {LaunchFeePluginBase} from "./LaunchFeePluginBase.sol";

/// @title HolderDistributionPlugin
/// @notice Pays each launch token's creator fees to that token's holders, pro-rata, through the token's built-in
///         USDC dividend tracker, dripped out linearly over DRIP_PERIOD rather than at once, so a bot cannot buy,
///         collect, claim and sell in one transaction (V13-SPEC §2.2, §3, [D15], [D21]). Holders claim on the
///         token, or with dripAndClaim here.
/// @dev One stream per token: `unreleased` USDC released linearly from `lastDrip` to `streamEnd`. A delivery moves
///      the end to the amount-weighted average of the old end and a full period from now, so a delivery that dwarfs
///      what is streaming gets close to the full period, while dust moves the end by at most the one second of
///      rounding up. What is due is
///      recomputed from the remaining balance and the remaining window at every release, never from a stored rate,
///      so rounding (always down, which only defers USDC to a later release) cannot accumulate, and everything is
///      due at streamEnd. The plugin's USDC balance is Σ unreleased over its tokens (plus direct transfers): every
///      other unit it received went into a token's distribute, which is checked to pull exactly what it was
///      approved for. State is written before any external call; the token's eligibleSupply read is a static call.
contract HolderDistributionPlugin is IHolderDistributionPlugin, LaunchFeePluginBase {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @inheritdoc IHolderDistributionPlugin
    uint256 public constant DRIP_PERIOD = 24 hours;

    /// @dev Whenever `unreleased != 0` and now < streamEnd, lastDrip <= now < streamEnd: onFees sets lastDrip = now
    ///      and a streamEnd in (now, now + DRIP_PERIOD], and a release before streamEnd moves lastDrip to now (a
    ///      release at or after streamEnd empties the stream). So the window a release divides by is never empty,
    ///      and streamEnd - lastDrip never exceeds DRIP_PERIOD.
    struct Stream {
        uint256 unreleased;
        uint256 distributed;
        uint64 lastDrip;
        uint64 streamEnd;
    }

    mapping(address token => Stream) private _streams;

    constructor(address launchpad_) LaunchFeePluginBase(launchpad_) {}

    // ─── Hooks ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexFeePlugin
    /// @dev Takes no configuration: `data` must be empty.
    function onLaunch(address token, address creator, bytes calldata data) external nonReentrant {
        if (data.length != 0) revert DataNotEmpty();
        _configure(token, creator);
    }

    /// @inheritdoc IArchitexFeePlugin
    /// @dev Pulls exactly `amount` from the caller. First releases what the running stream owes by now, on its old
    ///      schedule (nothing without eligible supply). Then `amount` joins what is left, the line restarts from now
    ///      (lastDrip = now), and the end moves to the amount-weighted average of the old end and now + DRIP_PERIOD
    ///      (see _weightedEnd). The new end is after now, so none of `amount` can be released in this block; a
    ///      delivery to an empty stream streams over exactly DRIP_PERIOD; dust barely moves the end. Zero is a
    ///      no-op: it neither releases nor moves anything.
    function onFees(address token, uint256 amount) external nonReentrant {
        _requireConfigured(token);
        if (amount == 0) return;
        emit FeesReceived(token, msg.sender, amount);

        Stream storage stream = _streams[token];
        uint256 due = _releasable(token, stream);
        uint256 kept = stream.unreleased - due;
        uint256 remaining = kept + amount;
        uint256 end = _weightedEnd(kept, stream.streamEnd, amount);
        stream.unreleased = remaining;
        stream.lastDrip = block.timestamp.toUint64();
        stream.streamEnd = end.toUint64();
        if (due != 0) {
            stream.distributed += due;
            emit Distributed(token, due);
        }
        emit FeesStreamed(token, amount, remaining, end);

        _pullFees(amount);
        if (due != 0) _pushToHolders(token, due);
    }

    // ─── Drip ─────────────────────────────────────────────────────────────────

    /// @inheritdoc IHolderDistributionPlugin
    function drip(address token) external nonReentrant returns (uint256 released) {
        _requireConfigured(token);
        released = _drip(token);
    }

    /// @inheritdoc IHolderDistributionPlugin
    /// @dev Safe to leave open: the token's claimFor pays the holder passed to it, never its caller, and the holder
    ///      passed is always msg.sender. A configured token is one the launchpad created.
    function dripAndClaim(address token) external nonReentrant returns (uint256 released, uint256 claimed) {
        _requireConfigured(token);
        released = _drip(token);
        claimed = ILaunchTokenExtensions(token).claimFor(msg.sender);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IHolderDistributionPlugin
    function releasable(address token) external view returns (uint256) {
        return _releasable(token, _streams[token]);
    }

    /// @inheritdoc IHolderDistributionPlugin
    function unreleased(address token) external view returns (uint256) {
        return _streams[token].unreleased;
    }

    /// @inheritdoc IHolderDistributionPlugin
    function lastDrip(address token) external view returns (uint256) {
        return _streams[token].lastDrip;
    }

    /// @inheritdoc IHolderDistributionPlugin
    function streamEnd(address token) external view returns (uint256) {
        return _streams[token].streamEnd;
    }

    /// @inheritdoc IHolderDistributionPlugin
    function totalDistributed(address token) external view returns (uint256) {
        return _streams[token].distributed;
    }

    /// @inheritdoc ILaunchFeePlugin
    /// @dev The stream's unreleased USDC.
    function usdcHeld(address token) external view returns (uint256) {
        return _streams[token].unreleased;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev Releases what is due to the token's holders. Changes nothing when nothing is due or the token has no
    ///      eligible supply, so lastDrip stays put and the elapsed time keeps counting towards the next release.
    function _drip(address token) private returns (uint256 released) {
        Stream storage stream = _streams[token];
        released = _releasable(token, stream);
        if (released == 0) return 0;
        stream.unreleased -= released;
        stream.distributed += released;
        stream.lastDrip = block.timestamp.toUint64();
        emit Distributed(token, released);
        _pushToHolders(token, released);
    }

    /// @dev What the stream owes holders now: all of it once now >= streamEnd, otherwise
    ///      unreleased * (now - lastDrip) / (streamEnd - lastDrip), rounded down, which is below unreleased because
    ///      now < streamEnd. Zero when the token has no eligible supply, where its distribute would revert; the token
    ///      is only asked when something is due.
    function _releasable(address token, Stream storage stream) private view returns (uint256 due) {
        uint256 pending = stream.unreleased;
        if (pending == 0) return 0;
        uint256 end = stream.streamEnd;
        if (block.timestamp < end) {
            uint256 last = stream.lastDrip;
            due = Math.mulDiv(pending, block.timestamp - last, end - last);
        } else {
            due = pending;
        }
        if (due != 0 && ILaunchTokenExtensions(token).eligibleSupply() == 0) due = 0;
    }

    /// @dev The end of the stream after `amount` joins the `kept` USDC left in it: the amount-weighted average of
    ///      the old end (clamped to now: a stream that has ended counts as ending now) and now + DRIP_PERIOD for the
    ///      new fees, rounded up so rounding never brings anyone's schedule forward:
    ///          ceil((kept * max(oldEnd, now) + amount * (now + DRIP_PERIOD)) / (kept + amount)),
    ///      computed as from + ceil(amount * (to - from) / (kept + amount)), which is equal (from is a whole number)
    ///      and cannot overflow. The result lies in [max(oldEnd, now), now + DRIP_PERIOD] and is after now because
    ///      amount > 0; with nothing kept it is exactly now + DRIP_PERIOD. `to - from` cannot underflow: every end
    ///      was set at most DRIP_PERIOD after a delivery that is not in the future.
    function _weightedEnd(uint256 kept, uint256 oldEnd, uint256 amount) private view returns (uint256) {
        uint256 from = Math.max(oldEnd, block.timestamp);
        uint256 to = block.timestamp + DRIP_PERIOD;
        return from + Math.mulDiv(amount, to - from, kept + amount, Math.Rounding.Ceil);
    }

    /// @dev The token's distribute pulls from its caller: approve exactly `amount`, then check it all went.
    function _pushToHolders(address token, uint256 amount) private {
        uint256 balanceBefore = USDC.balanceOf(address(this));
        USDC.forceApprove(token, amount);
        ILaunchTokenExtensions(token).distribute(amount);
        _checkExactPull(token, amount, balanceBefore);
    }
}
