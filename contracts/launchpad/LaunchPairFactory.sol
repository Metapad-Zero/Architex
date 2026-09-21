// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../interfaces/ILaunchPairFactory.sol";
import "../interfaces/IArchitexLaunchpadLite.sol";
import "./LaunchPair.sol";

/// @title LaunchPairFactory (launchpad v1.3)
/// @notice Creates launch pairs. Only the launchpad may create them, one token/USDC pair per launch token, inside
///         createToken (V13-SPEC §4). It never creates core pairs, and the core Architex factory never sees launch
///         tokens. Nobody can pre-create or squat a launch pair.
contract LaunchPairFactory is ILaunchPairFactory {
    /// @inheritdoc ILaunchPairFactory
    address public immutable launchpad;
    /// @inheritdoc ILaunchPairFactory
    address public immutable usdc;

    /// @inheritdoc ILaunchPairFactory
    mapping(address => address) public getPair;
    /// @inheritdoc ILaunchPairFactory
    address[] public allPairs;

    /// @dev Deploy after the launchpad; its USDC is read here and fixed.
    constructor(address launchpad_) {
        if (launchpad_ == address(0)) revert ZeroAddress();
        address usdc_ = IArchitexLaunchpadLite(launchpad_).usdc();
        if (usdc_ == address(0)) revert ZeroAddress();
        launchpad = launchpad_;
        usdc = usdc_;
    }

    /// @inheritdoc ILaunchPairFactory
    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @inheritdoc ILaunchPairFactory
    function createPair(address token) external returns (address pair) {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (token == address(0)) revert ZeroAddress();
        if (getPair[token] != address(0)) revert PairExists();
        // The launchpad only creates tokens after initialize(), so its router is set by now.
        address router = IArchitexLaunchpadLite(msg.sender).router();
        if (router == address(0)) revert ZeroAddress();

        pair = address(new LaunchPair(token, usdc, router));
        getPair[token] = pair;
        allPairs.push(pair);
        emit PairCreated(token, pair, allPairs.length);
    }
}
