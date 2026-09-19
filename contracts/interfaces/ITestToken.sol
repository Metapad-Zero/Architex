// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Testnet-only ERC-20 with an open faucet. NEVER deploy to mainnet.
interface ITestToken {
    event Faucet(address indexed to, uint256 amount);

    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);

    /// @notice Whole-token amount (before decimals) minted per faucet() call.
    function FAUCET_UNITS() external view returns (uint256);
    /// @notice Anyone: mints FAUCET_UNITS * 10**decimals to msg.sender. No cooldown (testnet).
    function faucet() external;
    /// @notice Owner only: arbitrary mint for pool seeding.
    function mint(address to, uint256 amount) external;
    function owner() external view returns (address);
}
