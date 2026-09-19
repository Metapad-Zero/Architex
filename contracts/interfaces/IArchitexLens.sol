// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Architex lens — read-only batch views so the frontend loads a whole screen in ONE eth_call.
/// @dev Stateless except for the immutable factory/router addresses. Never reverts on a bad token:
///      metadata lookups use try/catch and return empty strings / 18 decimals when a call fails.
interface IArchitexLens {
    struct TokenMeta {
        address token;
        string symbol;
        string name;
        uint8 decimals;
    }

    struct PairInfo {
        address pair;
        address token0;
        address token1;
        uint112 reserve0;
        uint112 reserve1;
        uint32 blockTimestampLast;
        uint256 totalSupply;
    }

    struct Position {
        address pair;
        address token0;
        address token1;
        uint256 lpBalance;
        uint256 lpTotalSupply;
        uint112 reserve0;
        uint112 reserve1;
        uint256 routerAllowance; // LP allowance owner -> router
    }

    function factory() external view returns (address);
    function router() external view returns (address);

    function pairsLength() external view returns (uint256);
    /// @notice Pairs [start, start+count) clamped to allPairsLength().
    function pairs(uint256 start, uint256 count) external view returns (PairInfo[] memory);
    function pairsByAddress(address[] calldata pairAddrs) external view returns (PairInfo[] memory);

    function tokenMeta(address[] calldata tokens) external view returns (TokenMeta[] memory);
    function balances(address owner, address[] calldata tokens) external view returns (uint256[] memory);
    function allowances(address owner, address spender, address[] calldata tokens) external view returns (uint256[] memory);

    /// @notice Every pair in [start, start+count) where `owner` holds LP > 0.
    function positions(address owner, uint256 start, uint256 count) external view returns (Position[] memory);
}
