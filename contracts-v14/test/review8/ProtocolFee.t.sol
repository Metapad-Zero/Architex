// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Review8Base} from "./Review8Base.sol";

/// @notice Claude review #8 (holds). With donations refused, the only other thing in v4 that moves fee growth is a swap's
///         fee. The pools' LP fee is 0 (static), so if Uniswap governance ever turns a protocol fee on for one of our
///         pools, v4 books the whole swap fee to the protocol (Pool.swap: `swapFee == protocolFee`) and nothing to
///         positions. Here the maximum protocol fee (0.1% each way) is set on a pool with a graduation bid: every kind of
///         swap still settles (PartialFill included), window buys still place their bids, the pool's fee growth stays
///         exactly 0, so no hook position ever has fees to fold into a later modifyLiquidity, and sync and the books
///         all hold.
abstract contract ProtocolFeeTest is Review8Base {
    using PoolIdLibrary for PoolKey;

    function test_maxProtocolFeeAccruesNothingToHookPositions() public {
        address token = _graduateWithCurveSnipe(300, false, dave, 2_000e6); // a graduation bid exists
        PoolKey memory key = _key(token);
        bool u0 = _usdcIs0(token);

        // The PoolManager's protocolFeeController is storage slot 2 (Owned.owner 0, protocolFeesAccrued 1).
        vm.store(POOL_MANAGER, bytes32(uint256(2)), bytes32(uint256(uint160(address(this)))));
        assertEq(manager.protocolFeeController(), address(this));
        manager.setProtocolFee(key, uint24((1000 << 12) | 1000));

        // All four swap kinds, in the opening window and after it.
        uint256 bids0 = hook.bidCount(token);
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 300_000_000e18);
        for (uint256 round; round < 2; ++round) {
            vm.prank(carol);
            uint256 got = router.buy(token, 3_000e6, 0, carol, MAX); // exact-in buy (PartialFill checked)
            vm.prank(carol);
            router.sell(token, got / 2, 0, carol, MAX); // exact-in sell
            raw.swap(
                key,
                SwapParams(u0, int256(1_000_000e18), u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
            ); // exact-out buy
            raw.swap(
                key, SwapParams(!u0, int256(500e6), !u0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
            ); // exact-out sell (PartialFill checked)
            _step(hook.SNIPE_BLOCKS());
        }

        assertGt(manager.protocolFeesAccrued(Currency.wrap(address(usdc))), 0, "the protocol fee was charged");
        assertGt(manager.protocolFeesAccrued(Currency.wrap(token)), 0, "on both input sides");
        (uint256 g0, uint256 g1) = StateLibrary.getFeeGrowthGlobals(manager, key.toId());
        assertEq(g0, 0, "no fee growth for any position");
        assertEq(g1, 0, "no fee growth for any position");

        assertEq(hook.bidCount(token), bids0 + 2, "both opening-window buys placed their bids");
        assertLe(hook.lockHeld(token), 2);
        pad.syncPoolFees(token);
        _assertHookClean(token);
        _assertSolvent();
    }
}

contract ProtocolFeeUsdcLowTest is ProtocolFeeTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract ProtocolFeeUsdcHighTest is ProtocolFeeTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
