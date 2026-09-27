// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Reads a pool's price and tick straight from the PoolManager's storage. The same arithmetic as v4-core's
///         StateLibrary.getSlot0 (MIT), kept here so the hook never compiles StateLibrary's import of Position.sol,
///         which is BUSL-1.1 until 2027-06-15.
library PoolState {
    /// @dev `pools` is the PoolManager's storage slot 6.
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));

    function getSlot0(IPoolManager manager, PoolId poolId) internal view returns (uint160 sqrtPriceX96, int24 tick) {
        bytes32 data = manager.extsload(keccak256(abi.encodePacked(PoolId.unwrap(poolId), POOLS_SLOT)));
        assembly ("memory-safe") {
            sqrtPriceX96 := and(data, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)
            tick := signextend(2, shr(160, data))
        }
    }
}
