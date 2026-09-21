// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./WeightedSplitDistributor.sol";

/// @title EqualSplitDistributor
/// @notice A `WeightedSplitDistributor` with every payee given an equal share (weight 1). For
///         the common case — "N cofounders/collaborators split protocol fees evenly" — without
///         having to think about a shares array.
contract EqualSplitDistributor is WeightedSplitDistributor {
    constructor(address[] memory payees_) WeightedSplitDistributor(payees_, _equalShares(payees_.length)) {}

    function _equalShares(uint256 count) private pure returns (uint256[] memory shares) {
        shares = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            shares[i] = 1;
        }
    }
}
