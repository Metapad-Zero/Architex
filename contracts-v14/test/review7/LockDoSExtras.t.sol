// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {ReviewBase, Flash} from "./ReviewBase.sol";

/// @notice Claude review #7 (fixed), two more ways lock() could stop:
///         1. A dust donation accrued fees to the hook's full-range position, which any later re-add (Deepen pool v1.4)
///            would have owed and never taken. Donations are now refused.
///         2. In an open pool every bid shared its far tick with the full-range position, and an outside LP could fill
///            that tick's liquidity cap (about 21M USDC, parked, not spent) so every later bid reverted
///            (TickLiquidityOverflow; Grok review #7's Low too). Bids now run BID_SPAN_TICKS down from their top and
///            never reach the far tick, so a window buy still places its bid with the far tick full (and since bids are
///            placed inside buys, a revert there would have stopped the buy itself).
abstract contract LockDoSExtrasTest is ReviewBase {
    using PoolIdLibrary for PoolKey;

    function test_aDustDonationIsRefusedSoTheFullRangePositionNeverAccrues() public {
        address token = _graduated(0, false);
        PoolKey memory key = _key(token);
        vm.prank(bob);
        IERC20(token).transfer(address(flash), 1e18);
        Flash.Op[] memory ops = new Flash.Op[](1);
        ops[0] = _opDonateToken(token, 1e18);
        vm.expectRevert();
        flash.run(key, ops);

        (uint256 in0, uint256 in1) = StateLibrary.getFeeGrowthInside(
            manager, key.toId(), TickMath.minUsableTick(200), TickMath.maxUsableTick(200)
        );
        assertEq(in0 + in1, 0, "no fee ever accrues to the full-range position");
    }

    function test_fillingTheFarTickCannotStopABid() public {
        address token = _launch(0, creatorWallet, "", true, 0); // open pool
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX); // graduates: the pool's opening block, its 90% window

        PoolKey memory key = _key(token);
        bool u0 = _usdcIs0(token);
        int24 farTick = u0 ? TickMath.maxUsableTick(200) : TickMath.minUsableTick(200);
        (uint128 gross,) = StateLibrary.getTickLiquidity(manager, key.toId(), farTick);
        uint128 room = Pool.tickSpacingToMaxLiquidityPerTick(200) - gross;
        // The review's attack: a USDC-only position one tick-spacing wide on the far tick, filling its cap.
        ModifyLiquidityParams memory p = u0
            ? ModifyLiquidityParams(farTick - 200, farTick, int256(uint256(room)), bytes32(0))
            : ModifyLiquidityParams(farTick, farTick + 200, int256(uint256(room)), bytes32(0));
        usdc.mint(address(raw), 100_000_000e6);
        raw.addLiquidity(key, p);
        (gross,) = StateLibrary.getTickLiquidity(manager, key.toId(), farTick);
        assertEq(gross, Pool.tickSpacingToMaxLiquidityPerTick(200), "the far tick is full");

        uint256 bids0 = hook.bidCount(token);
        vm.prank(carol);
        router.buy(token, 5_000e6, 0, carol, MAX); // an opening-window buy: its surcharge becomes a bid inside it
        assertEq(hook.bidCount(token), bids0 + 1, "the bid still goes in");
        assertLe(hook.lockHeld(token), 2);
        _assertHookClean(token);
    }
}

contract LockDoSExtrasUsdcLowTest is LockDoSExtrasTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract LockDoSExtrasUsdcHighTest is LockDoSExtrasTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
