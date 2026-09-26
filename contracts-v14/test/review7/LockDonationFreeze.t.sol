// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {ReviewBase, Flash} from "./ReviewBase.sol";

/// @notice Claude review #7, Medium (fixed). The hook had no beforeDonate, and every bid re-added to one position (salt
///         0). A flash round trip that sold into the graduation-time bid, donated one token and bought back left a token
///         fee on that position; the next lock() re-added to it, v4 folded the fee into the hook's delta, the hook never
///         took it, and lock() reverted CurrencyNotSettled for as long as the price stayed above graduation.
///         Now the hook refuses every donation, every bid is a fresh position (its own salt) that has no fees, and a
///         snipe fee becomes its bid inside the buy that pays it (there is no lock() left to freeze).
abstract contract LockDonationFreezeTest is ReviewBase {
    using PoolIdLibrary for PoolKey;

    function test_theDonationThatFrozeLockIsRefused() public {
        // A creation-block sniper pays the curve surcharge, so graduation places a bid (the position the attack targeted).
        address token = _graduateWithCurveSnipe(0, false, dave, 2_000e6);
        uint256 bids0 = hook.bidCount(token);
        assertGe(bids0, 1, "graduation bid");
        vm.prank(carol);
        router.buy(token, 5_000e6, 0, carol, MAX); // opening-window buy: its surcharge becomes a bid at once
        assertEq(hook.bidCount(token), bids0 + 1, "a bid of its own");
        assertLe(hook.lockHeld(token), 2, "nothing waits");
        _step(hook.SNIPE_BLOCKS());
        (, int24 tickBefore) = _slot0(token);

        uint256 push = 100_000_000e18;
        vm.prank(bob);
        IERC20(token).transfer(address(flash), 1e18);
        usdc.mint(address(flash), 10_000e6);
        PoolKey memory key = _key(token);

        // The attack as it was: sell into the bid, donate a token, buy back. The donation is refused: nothing lands.
        Flash.Op[] memory ops = new Flash.Op[](3);
        ops[0] = _opSwap(_sellExactIn(token, push));
        ops[1] = _opDonateToken(token, 1e18);
        ops[2] = _opSwap(_buyExactOut(token, push));
        vm.expectRevert();
        flash.run(key, ops);

        // The same round trip without the donation lands, and leaves every hook position as it was, fee-free.
        Flash.Op[] memory trip = new Flash.Op[](2);
        (trip[0], trip[1]) = (ops[0], ops[2]);
        flash.run(key, trip);
        (, int24 tickAfter) = _slot0(token);
        assertEq(tickAfter, tickBefore, "price back where it was");
        (uint256 g0, uint256 g1) = StateLibrary.getFeeGrowthGlobals(manager, key.toId());
        assertEq(g0 + g1, 0, "no fee ever accrues to any position");
        assertEq(hook.bidCount(token), bids0 + 1, "no bid added or moved outside the window");
        _assertHookClean(token);
        _assertSolvent();
    }
}

contract LockDonationFreezeUsdcLowTest is LockDonationFreezeTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract LockDonationFreezeUsdcHighTest is LockDonationFreezeTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
