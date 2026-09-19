// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A token launched on the Architex launchpad: fixed 1B supply, no owner, no mint after construction.
interface ILaunchToken is IERC20 {
    error OnlyLaunchpad();
    error PairAlreadySet();
    error AlreadyGraduated();
    error PairLockedUntilGraduation();

    function launchpad() external view returns (address);
    function pair() external view returns (address);
    function graduated() external view returns (bool);

    /// @notice Launchpad only, once: the Architex pair that stays closed to deposits until graduation.
    function initPair(address pair) external;
    /// @notice Launchpad only, once: opens transfers to the pair.
    function markGraduated() external;
    /// @notice Launchpad only: moves a seller's tokens back to the curve without an ERC-20 approval.
    ///         The launchpad only ever passes its own `msg.sender` as `from`.
    function launchpadPull(address from, uint256 amount) external;
}
