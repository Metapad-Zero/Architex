// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ReviewBase, Flash} from "./ReviewBase.sol";

/// @notice Claude review #7 L2 (fixed). lock() placed the bid from half the LOWER of the current and the graduation
///         price, so a griefer who pushed the price down just before calling it (sell, lock, buy back) parked the pool's
///         snipe fees far below half the graduation price. The bid is now anchored to the graduation price alone: a
///         push that leaves the price above the bid's top changes nothing, and one that goes below it makes lock() place
///         nothing, so the claims wait for the price to come back.
abstract contract BidPlacementTest is ReviewBase {
    bytes32 internal constant BID_LOCKED = keccak256("BidLocked(address,uint256,uint128,int24,int24)");

    /// @dev The bid's price edge nearest the market: its upper tick when USDC is currency1, lower when currency0.
    function _bidTop(address token, Vm.Log[] memory logs) internal view returns (bool found, int24 top) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == BID_LOCKED && address(uint160(uint256(logs[i].topics[1]))) == token) {
                (,, int24 lower, int24 upper) = abi.decode(logs[i].data, (uint256, uint128, int24, int24));
                (found, top) = (true, _usdcIs0(token) ? lower : upper);
            }
        }
    }

    function _pushed(address token, uint256 bag) internal returns (bool found, int24 top, uint128 liquidity) {
        PoolKey memory key = _key(token);
        uint256 before = IERC20(token).balanceOf(address(flash));
        Flash.Op[] memory ops = new Flash.Op[](1);
        ops[0] = _opSwap(_sellExactIn(token, bag));
        flash.run(key, ops);
        vm.recordLogs();
        liquidity = hook.lock(token);
        (found, top) = _bidTop(token, vm.getRecordedLogs());
        ops[0] = _opSwap(_buyExactOut(token, bag));
        flash.run(key, ops);
        assertEq(IERC20(token).balanceOf(address(flash)), before, "bag back in full");
    }

    function test_pushingThePriceBeforeLockCannotMoveTheBid() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0);
        vm.prank(carol);
        router.buy(token, 5_000e6, 0, carol, MAX);
        uint256 held = hook.lockHeld(token);
        _step(hook.SNIPE_BLOCKS());
        int24 grad = _gradTick(token);
        vm.prank(bob);
        IERC20(token).transfer(address(flash), 300_000_000e18);
        usdc.mint(address(flash), 1_000e6);

        // Honest lock, for comparison: the top about half the graduation price.
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        hook.lock(token);
        (bool honest, int24 honestTop) = _bidTop(token, vm.getRecordedLogs());
        assertTrue(honest);
        int256 gap = _usdcIs0(token) ? int256(honestTop) - grad : int256(grad) - honestTop;
        assertGe(gap, 6_932, "at or under half the graduation price");
        assertLt(gap, 6_932 + 200, "within a tick spacing of it");
        vm.revertToState(snap);

        // A push that keeps the price above the bid's top (30M tokens, about 0.76 of it): the very same bid.
        (bool found, int24 top,) = _pushed(token, 30_000_000e18);
        assertTrue(found);
        assertEq(top, honestTop, "same bid as without the push");
        vm.revertToState(snap);

        // The review's 300M push takes the price under the bid's top: lock() places nothing and the claims wait.
        uint128 liquidity;
        (found,, liquidity) = _pushed(token, 300_000_000e18);
        assertFalse(found, "no bid placed");
        assertEq(liquidity, 0);
        assertEq(hook.lockHeld(token), held, "the claims wait");
        // With the price back, the next lock() places the honest bid.
        vm.recordLogs();
        hook.lock(token);
        (found, top) = _bidTop(token, vm.getRecordedLogs());
        assertTrue(found);
        assertEq(top, honestTop, "the honest bid, after all");
        _assertHookClean(token);
    }
}

contract BidPlacementUsdcLowTest is BidPlacementTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract BidPlacementUsdcHighTest is BidPlacementTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
