// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A 6-decimal stand-in for Arc's USDC in the v1.4 tests. Tests etch it at chosen addresses so a launch token
///         can sort on either side of it. Has a blocklist like Circle's: a blocked address can neither send nor receive.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocked;

    error Blocked();

    constructor() ERC20("USD Coin", "USDC") {}

    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from] || blocked[to]) revert Blocked();
        super._update(from, to, value);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
