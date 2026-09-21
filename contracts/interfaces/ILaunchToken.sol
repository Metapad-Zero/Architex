// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./ILaunchTokenExtensions.sol";

/// @notice A token launched on the Architex launchpad v1.3 (docs/launchpad/V13-SPEC.md §3): fixed 1B supply minted
///         once to the launchpad, no owner, no mint. Holders can burn; USDC dividends are built in.
interface ILaunchToken is IERC20, ILaunchTokenExtensions {
    error OnlyLaunchpad();
    error OnlyLaunchpadOrRouter();
    /// @notice A pull to anywhere but its fixed destination (the launchpad for the launchpad, the pair for the router).
    error InvalidPullTarget();
    error PairAlreadySet();
    error AlreadyGraduated();
    error PairLockedUntilGraduation();

    function launchpad() external view returns (address);
    /// @notice The launch router, fixed at construction. It may `pull` sellers' tokens into the launch pair.
    function router() external view returns (address);
    /// @notice The token's launch pair: closed to deposits until graduation, excluded from dividends.
    function pair() external view returns (address);
    function graduated() external view returns (bool);

    /// @notice The smallest eligible supply dividends run on (one whole token). Below it `eligibleSupply()` reports 0 and
    ///         the dividend stream pauses, which bounds the dividend-per-share growth a near-empty supply would
    ///         otherwise allow.
    function MIN_ELIGIBLE_SUPPLY() external view returns (uint256);
    /// @notice USDC dividends `holder` has claimed so far.
    function claimed(address holder) external view returns (uint256);

    /// @notice Launchpad only, once: the launch pair that stays closed to deposits until graduation.
    function initPair(address pair) external;
    /// @notice Launchpad only, once: opens transfers to the pair.
    function markGraduated() external;
    /// @notice Moves a seller's tokens without an ERC-20 approval. Callable only by the launchpad (destination: the
    ///         launchpad, a curve sell) or the launch router (destination: the pair, a pool sell). Each passes only
    ///         its own `msg.sender` as `from`.
    function pull(address from, address to, uint256 amount) external;
}
