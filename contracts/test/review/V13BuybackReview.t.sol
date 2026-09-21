// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IBuybackBurnPlugin} from "../../interfaces/plugins/IBuybackBurnPlugin.sol";
import {BuybackBurnPlugin} from "../../plugins/launch/BuybackBurnPlugin.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {LaunchpadV13Base} from "../launchpad/LaunchpadV13Base.sol";

/// @notice Review: Buyback & burn pacing on the real launchpad, curve, router and pool, with random trades moving the
///         reserve the cap is taken from, random gaps (including same-second blocks) and a graduation along the way.
contract V13BuybackReviewTest is LaunchpadV13Base {
    uint256 internal constant HOUR = 3600;
    BuybackBurnPlugin internal buyback;
    address internal keeper = makeAddr("keeper");
    address internal funder = makeAddr("funder");

    function setUp() public override {
        super.setUp();
        buyback = new BuybackBurnPlugin(address(pad));
        vm.warp(1_700_000_000);
    }

    function _fundPlugin(address t, uint256 amount) internal {
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(address(buyback), amount);
        buyback.onFees(t, amount);
        vm.stopPrank();
    }

    function _cap(address t) internal view returns (uint256) {
        if (pad.isGraduated(t)) {
            (, uint112 ru,) = ILaunchPair(pad.pairOf(t)).getReserves();
            return uint256(ru) * 25 / 10_000;
        }
        return pad.virtualUsdcOf(t) * 25 / 10_000;
    }

    /// @dev Every run offers exactly min(held, floor(cap * min(elapsed, 1 h) / 1 h)) (a full cap the first time),
    ///      previewRun says the same, the spend equals the offer except on the curve's sell-out buy, and the plugin's
    ///      USDC always equals what it holds for the token.
    function testFuzz_review_pacingHoldsOnTheRealSuite(uint256 seed) public {
        address t = _create(1000, address(buyback));
        vm.prank(carol);
        pad.buy(t, 18_000e6, 0, carol, type(uint256).max);
        _fundPlugin(t, 3_000e6);
        uint256 lastRun;
        bool sawGraduation;
        for (uint256 i; i < 50; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + (r % 4) * ((r >> 8) % 2400)); // includes same-second blocks
            uint256 x = r >> 32;
            // a trade that moves the reserve the cap is read from
            bool isGrad = pad.isGraduated(t);
            if (x % 3 == 0) {
                uint256 amt = 1e6 + (x >> 8) % 4_000e6;
                vm.prank(bob);
                if (isGrad) router.buy(t, amt, 0, bob, vm.getBlockTimestamp());
                else pad.buy(t, amt, 0, bob, type(uint256).max);
            } else if (x % 3 == 1) {
                uint256 bal = IERC20(t).balanceOf(carol) / 50;
                vm.prank(carol);
                if (isGrad) router.sell(t, bal, 0, carol, vm.getBlockTimestamp());
                else pad.sell(t, bal, 0, carol, type(uint256).max);
            }
            if ((x >> 64) % 4 == 0) _fundPlugin(t, (x >> 96) % 500e6);

            uint256 held = buyback.usdcHeld(t);
            uint256 cap = _cap(t);
            uint256 budget = cap;
            if (lastRun != 0) {
                uint256 elapsed = vm.getBlockTimestamp() - lastRun;
                if (elapsed < HOUR) budget = cap * elapsed / HOUR;
            }
            uint256 expected = held < budget ? held : budget;
            if (expected < 3) expected = 0;
            (uint256 offered, bool grad) = buyback.previewRun(t);
            assertEq(offered, expected, "previewRun == min(held, paced budget)");
            if (offered == 0) {
                vm.prank(keeper);
                vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, t));
                buyback.run(t);
                continue;
            }
            vm.prank(keeper);
            (uint256 spent,) = buyback.run(t);
            if (!grad && pad.isGraduated(t)) {
                sawGraduation = true;
                assertLe(spent, offered, "sell-out run takes at most the offer");
            } else {
                assertEq(spent, offered, "spend == offer");
            }
            assertEq(buyback.usdcHeld(t), held - spent);
            assertEq(usdc.balanceOf(address(buyback)), buyback.usdcHeld(t), "plugin USDC == held");
            assertEq(IERC20(t).balanceOf(address(buyback)), 0, "everything bought is burned");
            lastRun = vm.getBlockTimestamp();
        }
        _assertSolvent();
        sawGraduation; // graduation is reached for some seeds only
    }

    /// @dev Info: pacing caps spending at 0.25% of the reserve per hour, so a token whose creator fees arrive faster
    ///      than that never catches up. At a 10% creator fee and a 25,000 USDC pool, 15,000 USDC of daily volume
    ///      already brings in more than a day of budget; here 30,000 USDC of volume a day leaves most of it waiting.
    function test_review_highFeeVolumeOutpacesThePacedBudget() public {
        address t = _create(1000, address(buyback));
        _graduate(t); // bob buys the curve out
        pad.collectCreatorFees(t);
        uint256 spentTotal;
        uint256 feesTotal = buyback.usdcHeld(t);
        uint256 heldAtGrad = feesTotal;
        for (uint256 h; h < 72; ++h) {
            // 1,250 USDC of volume an hour (30,000 a day), alternating buys and sells
            vm.startPrank(carol);
            router.buy(t, 625e6, 0, carol, vm.getBlockTimestamp());
            router.sell(t, IERC20(t).balanceOf(carol) / 2, 0, carol, vm.getBlockTimestamp());
            vm.stopPrank();
            feesTotal += pad.collectCreatorFees(t);
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + HOUR);
            (uint256 offered,) = buyback.previewRun(t);
            if (offered != 0) {
                vm.prank(keeper);
                (uint256 spent,) = buyback.run(t);
                spentTotal += spent;
            }
        }
        emit log_named_uint("held at graduation (USDC units)", heldAtGrad);
        emit log_named_uint("fees in over 72 h               ", feesTotal);
        emit log_named_uint("spent over 72 h                 ", spentTotal);
        emit log_named_uint("still waiting                   ", buyback.usdcHeld(t));
        assertGt(buyback.usdcHeld(t), heldAtGrad, "what waits keeps growing: fees arrive faster than the pace spends");
    }
}
