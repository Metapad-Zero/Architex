// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Architex flash-swap callback interface.
/// @dev Any contract that wants to receive flash-swap proceeds must implement this.
interface IArchitexCallee {
    /// @notice Called by an ArchitexPair after sending out tokens in a flash swap.
    /// @param sender   The address that initiated the swap.
    /// @param amount0  Token0 amount sent to the callee.
    /// @param amount1  Token1 amount sent to the callee.
    /// @param data     Arbitrary data forwarded from the swap caller.
    function architexCall(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}
