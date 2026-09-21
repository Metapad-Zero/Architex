// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Distribute to holders: a token's creator fees paid to its holders pro-rata as USDC dividends through the
///        token's built-in tracker, dripped out over DRIP_PERIOD (24 hours) (V13-SPEC §2.2, §3, [D15], [D21]).
/// @notice onLaunch data must be empty. Fees are not distributed when they arrive: each token has one stream of
///         `unreleased` USDC that is released linearly from `lastDrip` to `streamEnd`, so a bot cannot buy, collect,
///         claim and sell in one transaction and take fees meant for longer-term holders.
///         - onFees(token, amount) pulls `amount`, first releases what the running stream owes by now (on its old
///           schedule), then adds `amount` to what is left (`kept`) and sets lastDrip = now and
///           streamEnd = ceil((kept * max(oldEnd, now) + amount * (now + DRIP_PERIOD)) / (kept + amount)): the
///           amount-weighted average of the old end (a stream that has ended counts as ending now) and a full period
///           for the new fees, rounded up. A delivery to an empty stream therefore streams over exactly DRIP_PERIOD;
///           after a delivery at least as large as what is left, the stream runs at least half of DRIP_PERIOD; and
///           dust (at most kept / (DRIP_PERIOD - 1)) puts the end at most one second past max(oldEnd, now). The end
///           is always after now, so nothing of new fees is released in the block that delivers them.
///         - drip(token), by anyone, releases what is due: all of `unreleased` once now >= streamEnd, otherwise
///           unreleased * (now - lastDrip) / (streamEnd - lastDrip), rounded down (recomputed from the remaining
///           balance each time, so rounding never accumulates; the remainder is all due at streamEnd). A release
///           approves exactly that amount to the token, calls its distribute, and sets lastDrip = now.
///         - While the token has no eligible supply (its eligibleSupply() is 0 below one whole eligible token and
///           its distribute would revert) nothing is released and lastDrip does not move, so the clock keeps
///           running: what matured goes out with the first drip once holders exist. A delivery meanwhile restarts
///           the line from now for the whole balance, the matured part counting as ending now in the average.
///         - dripAndClaim(token) drips, then calls the token's claimFor(msg.sender), which pays the caller its
///           claimable USDC (never anyone else). Holders can also claim on the token itself (claim / claimFor).
///         There is no flush: drip replaces it. The plugin's USDC balance equals the sum of `unreleased` over all
///         tokens (plus anything sent to it directly); everything else went into a token's distribute.
///         What the drip does not stop: a release goes to whoever holds at that moment, so a buyer just before a
///         drip shares what matured since the previous one. Frequent drips keep that small; every delivery and
///         every dripAndClaim also drips, and the site or a keeper should drip regularly.
interface IHolderDistributionPlugin is ILaunchFeePlugin {
    /// @notice `amount` new USDC joined `token`'s stream: `unreleased` USDC now drips out until `streamEnd`.
    event FeesStreamed(address indexed token, uint256 amount, uint256 unreleased, uint256 streamEnd);
    /// @notice `amount` USDC was distributed to `token`'s holders through its distribute.
    event Distributed(address indexed token, uint256 amount);

    /// @notice 24 hours: fees delivered to an empty stream are all due after this long, and no delivery moves the
    ///         end further than this from now (later fees average the end towards now + DRIP_PERIOD by amount).
    function DRIP_PERIOD() external view returns (uint256);

    /// @notice Releases what `token`'s stream owes its holders by now (see releasable) through the token's
    ///         distribute. Callable by anyone. Returns 0, changing nothing, when nothing is due or the token has no
    ///         eligible supply. Reverts NotConfigured for a token this plugin does not serve.
    function drip(address token) external returns (uint256 released);

    /// @notice drip(token), then the token's claimFor(msg.sender): one transaction for a holder on the token page.
    ///         `claimed` is the USDC paid to the caller; nobody else is paid. Reverts NotConfigured like drip.
    function dripAndClaim(address token) external returns (uint256 released, uint256 claimed);

    /// @notice What drip(token) would release now: 0 if nothing is due or the token has no eligible supply.
    function releasable(address token) external view returns (uint256);
    /// @notice USDC waiting to be released to `token`'s holders; the same as usdcHeld(token).
    function unreleased(address token) external view returns (uint256);
    /// @notice When the stream last released USDC or received fees (the start of what is due now); 0 if never.
    function lastDrip(address token) external view returns (uint256);
    /// @notice From this time on all of `unreleased` is due (released by the next drip, given eligible supply). New
    ///         fees move it to the amount-weighted average described above. 0 if the stream was never fed.
    function streamEnd(address token) external view returns (uint256);
    /// @notice All USDC this plugin has distributed to `token`'s holders.
    function totalDistributed(address token) external view returns (uint256);
}
