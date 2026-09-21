// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title v1.3 launch-token features: true burn and USDC dividends (docs/launchpad/V13-SPEC.md §3).
/// @notice The v1.3 `ILaunchToken` extends this. Excluded from dividends: the launchpad, the token's launch
///         pair, the burn address 0x…dEaD and address(0). Eligible supply = total supply minus excluded balances.
interface ILaunchTokenExtensions {
    event DividendsDistributed(address indexed from, uint256 amount);
    event DividendClaimed(address indexed holder, uint256 amount);

    error NoEligibleSupply();

    /// @notice The dividend asset.
    function usdc() external view returns (address);

    /// @notice Burns the caller's own tokens; total supply drops.
    function burn(uint256 amount) external;

    /// @notice Pulls `amount` USDC from the caller and credits it pro-rata to eligible holders. Anyone may call.
    ///         Reverts NoEligibleSupply when eligible supply is zero.
    function distribute(uint256 amount) external;

    function eligibleSupply() external view returns (uint256);
    function isExcluded(address account) external view returns (bool);
    function totalDistributed() external view returns (uint256);
    function claimable(address holder) external view returns (uint256);

    /// @notice Pays the caller's claimable USDC to the caller.
    function claim() external returns (uint256 amount);
    /// @notice Pays `holder`'s claimable USDC to `holder` (never to the caller).
    function claimFor(address holder) external returns (uint256 amount);
}
