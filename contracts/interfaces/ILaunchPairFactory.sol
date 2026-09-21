// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Creates launch pairs. Only the launchpad may create them, one token/USDC pair per launch token (V13-SPEC §4).
/// @notice Separate from the core Architex factory, which never sees launch tokens.
interface ILaunchPairFactory {
    event PairCreated(address indexed token, address pair, uint256 allPairsLength);

    error OnlyLaunchpad();
    error PairExists();
    error ZeroAddress();

    function launchpad() external view returns (address);
    function usdc() external view returns (address);
    function getPair(address token) external view returns (address pair);
    function allPairs(uint256 index) external view returns (address pair);
    function allPairsLength() external view returns (uint256);

    /// @notice Launchpad only. The pair's router is read from the launchpad at creation.
    function createPair(address token) external returns (address pair);
}
