// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {ReviewBase, Flash} from "./ReviewBase.sol";

/// @notice Claude review #7 L2 (fixed, then fixed again after review #8). lock() placed the bid from half the LOWER of
///         the current and the graduation price, so a griefer who pushed the price down just before calling it parked
///         the snipe fees far lower. The first fix anchored the bid to the graduation price, which review #8 showed
///         could be harvested after a crash (CLAUDE-REVIEW-8.md). Now there is no lock(): each snipe fee becomes a bid
///         inside the buy that pays it, from half the price just before that buy. After the window nothing can add or
///         move a bid; inside it, a push before someone's buy can only be undone with a buy that pays the surcharge.
abstract contract BidPlacementTest is ReviewBase {
    function test_afterTheWindowNoPushAddsOrMovesABid() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 2_000e6); // a graduation bid
        vm.prank(carol);
        router.buy(token, 5_000e6, 0, carol, MAX); // an opening-block bid
        _step(hook.SNIPE_BLOCKS());
        uint256 bids = hook.bidCount(token);
        uint256 claims = _hookClaims();

        // The review's 300M push, down and back, then the same up and back, each in one transaction.
        vm.prank(bob);
        IERC20(token).transfer(address(flash), 300_000_000e18);
        usdc.mint(address(flash), 1_000_000e6);
        PoolKey memory key = _key(token);
        Flash.Op[] memory ops = new Flash.Op[](2);
        ops[0] = _opSwap(_sellExactIn(token, 300_000_000e18));
        ops[1] = _opSwap(_buyExactOut(token, 300_000_000e18));
        flash.run(key, ops);
        ops[0] = _opSwap(_buyExactOut(token, 50_000_000e18));
        ops[1] = _opSwap(_sellExactIn(token, 50_000_000e18));
        flash.run(key, ops);

        assertEq(hook.bidCount(token), bids, "no bid added");
        assertLe(hook.lockHeld(token), 2, "nothing waiting to be placed");
        assertGe(_hookClaims(), claims, "no claims spent on a bid");
        _assertHookClean(token);
    }

    function test_aPushBeforeAWindowBuyCostsTheSurchargeToUndo() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0); // returns in the pool's opening block
        uint256 inWindow = _griefCost(token);
        _step(hook.SNIPE_BLOCKS());
        uint256 after_ = _griefCost(token);
        // Inside the window the griefer's buy-back pays the surcharge on top (about 86,000 USDC for this trip, against
        // about 8,300 after the window, where carol's buy places no bid at all).
        assertGt(inWindow, 5 * after_, "undoing a push inside the window costs the surcharge");
    }

    /// @dev A griefer sells 100M tokens just before carol's 5,000 USDC buy (so her bid lands from the lower price), then
    ///      buys the 100M back. Returns what the round trip cost him in USDC.
    function _griefCost(address token) internal returns (uint256 cost) {
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 100_000_000e18);
        uint256 u0 = usdc.balanceOf(address(raw));
        bool usdcIs0 = _usdcIs0(token);
        raw.swap(_key(token), _sellExactIn(token, 100_000_000e18));
        vm.prank(carol);
        router.buy(token, 5_000e6, 0, carol, MAX);
        raw.swap(
            _key(token),
            SwapParams({
                zeroForOne: usdcIs0,
                amountSpecified: int256(100_000_000e18),
                sqrtPriceLimitX96: usdcIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            })
        );
        cost = u0 - usdc.balanceOf(address(raw));
        vm.revertToState(snap);
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
