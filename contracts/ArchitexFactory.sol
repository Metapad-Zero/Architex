// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./interfaces/IArchitexFactory.sol";
import "./ArchitexPair.sol";

/// @title Architex Factory
/// @notice Deploys and indexes constant-product pairs via CREATE2.
///         One pair per unordered token tuple; salt = keccak256(abi.encodePacked(token0, token1)).
contract ArchitexFactory is IArchitexFactory {
    /// @inheritdoc IArchitexFactory
    address public feeTo;
    /// @inheritdoc IArchitexFactory
    address public feeToSetter;

    /// @dev token0 < token1 always; nested mapping for O(1) lookup in both orders.
    mapping(address => mapping(address => address)) private _getPair;
    address[] public allPairs;

    constructor(address _feeToSetter) {
        if (_feeToSetter == address(0)) revert ZeroAddress();
        feeToSetter = _feeToSetter;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexFactory
    function getPair(address tokenA, address tokenB) external view returns (address pair) {
        return _getPair[tokenA][tokenB];
    }

    /// @inheritdoc IArchitexFactory
    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    // ─── Pair creation ────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexFactory
    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (tokenA == tokenB) revert IdenticalAddresses();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (_getPair[token0][token1] != address(0)) revert PairExists();

        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        ArchitexPair p = new ArchitexPair{salt: salt}();
        p.initialize(token0, token1);

        pair = address(p);
        _getPair[token0][token1] = pair;
        _getPair[token1][token0] = pair; // symmetric lookup
        allPairs.push(pair);

        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexFactory
    function setFeeTo(address _feeTo) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        feeTo = _feeTo;
        emit FeeToUpdated(_feeTo);
    }

    /// @inheritdoc IArchitexFactory
    function setFeeToSetter(address _feeToSetter) external {
        if (msg.sender != feeToSetter) revert Forbidden();
        feeToSetter = _feeToSetter;
        emit FeeToSetterUpdated(_feeToSetter);
    }
}
