// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title v1.3 launch-token features: true burn and streamed USDC dividends (docs/launchpad/V13-SPEC.md §3).
/// @notice The v1.3 `ILaunchToken` extends this. Excluded from dividends: the launchpad, the token's launch
///         pair, the burn address 0x…dEaD and address(0). Eligible supply = total supply minus excluded balances.
///         Dividends stream: distribute(amount) pays `amount` to the eligible holders continuously over DRIP_PERIOD,
///         and each eligible account earns, second by second, in proportion to what it holds. A holder therefore
///         earns only for the time it holds: buying, claiming and selling in one transaction earns nothing, however
///         much has been distributed or however long nobody collected. A new amount joins the running stream, whose
///         end moves to the amount-weighted average of its old end and now + DRIP_PERIOD, rounded down (a first
///         stream runs exactly DRIP_PERIOD; dust does not move the end). While eligible supply is under one whole
///         token (MIN_ELIGIBLE_SUPPLY) the stream pauses: nothing accrues and its end moves out by the paused time.
interface ILaunchTokenExtensions {
    event DividendsDistributed(address indexed from, uint256 amount);
    event DividendClaimed(address indexed holder, uint256 amount);

    /// @notice The dividend asset.
    function usdc() external view returns (address);

    /// @notice Burns the caller's own tokens; total supply drops.
    function burn(uint256 amount) external;

    /// @notice Pulls exactly `amount` USDC from the caller and streams it to eligible holders (see above). Anyone may
    ///         call: a fee plugin, or a creator paying holders directly. 0 is a no-op. It does not revert for lack
    ///         of eligible supply: the stream waits, paused, until there are holders.
    function distribute(uint256 amount) external;

    /// @notice 24 hours: how long a first distribution streams for, and the most any distribution extends the end
    ///         from now.
    function DRIP_PERIOD() external view returns (uint256);
    /// @notice Eligible supply, reported as 0 below MIN_ELIGIBLE_SUPPLY (where the stream pauses).
    function eligibleSupply() external view returns (uint256);
    function isExcluded(address account) external view returns (bool);
    /// @notice All USDC ever distributed (pulled by distribute), streamed out or not.
    function totalDistributed() external view returns (uint256);
    /// @notice What `holder` could claim now: everything it has earned up to this second, less what it claimed.
    function claimable(address holder) external view returns (uint256);
    /// @notice What the stream pays all eligible holders together right now, in USDC units per second (rounded down;
    ///         for display, the exact rate is kept magnified). 0 while nothing is paying: before the first distribute,
    ///         once the stream has ended, and while it is paused (eligible supply under MIN_ELIGIBLE_SUPPLY).
    function streamRate() external view returns (uint256);
    /// @notice When the running stream ends if nothing changes. While it is paused the end keeps moving out with time,
    ///         so this reports the end as of now (the stored end plus the paused time so far). More distributed moves it
    ///         too. The last end if none runs, 0 if nothing was ever distributed.
    function streamEnd() external view returns (uint256);
    /// @notice The time the stream was last accrued up to.
    function lastAccrual() external view returns (uint256);
    /// @notice About what the running stream still has to pay out from now on (rounded down; 0 if none runs).
    function undistributed() external view returns (uint256);

    /// @notice Pays the caller's claimable USDC to the caller.
    function claim() external returns (uint256 amount);
    /// @notice Pays `holder`'s claimable USDC to `holder` (never to the caller).
    function claimFor(address holder) external returns (uint256 amount);
}
