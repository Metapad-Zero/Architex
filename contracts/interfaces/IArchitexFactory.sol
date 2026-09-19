// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Architex factory — creates and indexes constant-product pairs.
/// @dev One pair per unordered token tuple. Pairs are created with CREATE2 so
///      `getPair` is the only lookup anyone needs; nothing off-chain hashes init code.
interface IArchitexFactory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength);
    event FeeToUpdated(address indexed feeTo);
    event FeeToSetterUpdated(address indexed feeToSetter);

    error IdenticalAddresses();
    error ZeroAddress();
    error PairExists();
    error Forbidden();

    /// @notice Receiver of the protocol share of swap fees. address(0) disables it.
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);

    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint256 index) external view returns (address pair);
    function allPairsLength() external view returns (uint256);

    /// @notice Deterministic pair creation; reverts if the pair exists.
    function createPair(address tokenA, address tokenB) external returns (address pair);

    function setFeeTo(address feeTo) external;
    function setFeeToSetter(address feeToSetter) external;
}
