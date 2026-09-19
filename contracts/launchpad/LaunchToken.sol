// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/ILaunchToken.sol";

/// @title LaunchToken
/// @notice Fixed-supply ERC-20 minted entirely to the launchpad at construction.
///         No owner, no mint/burn after construction.
///         Transfer to the registered Architex pair is blocked until graduation so the
///         launchpad controls the pool opening price.
contract LaunchToken is ERC20, ILaunchToken {
    /// @inheritdoc ILaunchToken
    address public immutable launchpad;

    /// @inheritdoc ILaunchToken
    address public pair;

    /// @inheritdoc ILaunchToken
    bool public graduated;

    uint256 private constant _TOTAL = 1_000_000_000e18;

    constructor(string memory _name, string memory _symbol) ERC20(_name, _symbol) {
        launchpad = msg.sender;
        _mint(msg.sender, _TOTAL);
    }

    // ─── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyLaunchpad() {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _;
    }

    // ─── Launchpad-only state setters ─────────────────────────────────────────

    /// @inheritdoc ILaunchToken
    /// @notice Launchpad only, callable once: register the Architex pair.
    function initPair(address _pair) external onlyLaunchpad {
        if (pair != address(0)) revert PairAlreadySet();
        pair = _pair;
    }

    /// @inheritdoc ILaunchToken
    /// @notice Launchpad only, callable once: open transfers to the pair.
    function markGraduated() external onlyLaunchpad {
        if (graduated) revert AlreadyGraduated();
        graduated = true;
    }

    /// @inheritdoc ILaunchToken
    /// @notice Launchpad only: pull tokens from a seller without an ERC-20 approval.
    ///         The launchpad only ever passes its own msg.sender as `from`.
    function launchpadPull(address from, uint256 amount) external onlyLaunchpad {
        _transfer(from, launchpad, amount);
    }

    // ─── Transfer hook ────────────────────────────────────────────────────────

    /// @dev Reverts any transfer TO `pair` before graduation.
    function _update(address from, address to, uint256 value) internal override {
        if (to == pair && pair != address(0) && !graduated) {
            revert PairLockedUntilGraduation();
        }
        super._update(from, to, value);
    }
}
