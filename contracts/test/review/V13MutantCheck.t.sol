// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../launchpad/LaunchpadV13Base.sol";
import {MutantLaunchToken} from "./mutants/MutantLaunchToken.sol";
import {V13ShadowModelReview} from "./V13ShadowModelReview.t.sol";

/// @notice Sensitivity check for the review's shadow model: a mutant LaunchToken whose accrual runs LAST in _update
///         (after eligible supply and corrections move). These tests PASS when the mutant is caught.
contract V13MutantCheck is Test {
    function test_mutant_accrueLastPaysAZeroSecondHolder() public {
        vm.warp(1_700_000_000);
        BlockableUSDC usdc = new BlockableUSDC();
        MutantLaunchToken token = new MutantLaunchToken("M", "M", address(usdc), makeAddr("router"));
        token.initPair(makeAddr("pair"));
        address payer = makeAddr("payer");
        address h0 = makeAddr("h0");
        address h1 = makeAddr("h1");
        usdc.mint(payer, 1e12);
        vm.prank(payer);
        usdc.approve(address(token), type(uint256).max);
        token.transfer(h0, 100e18);
        vm.prank(payer);
        token.distribute(24e6);
        vm.warp(vm.getBlockTimestamp() + 12 hours);
        token.transfer(h1, 100e18); // buys at 12 h, has held for 0 s
        assertGt(token.claimable(h1), 5e6, "the mutant pays a 0-second holder half the elapsed stream");
    }
}

/// @notice The random-sequence shadow model against the same mutant: caught on at least one of 8 seeds.
contract V13ShadowModelAgainstMutant is V13ShadowModelReview {
    function _deployToken() internal override returns (LaunchToken) {
        return LaunchToken(address(new MutantLaunchToken("Shadow", "SHD", address(usdc), makeAddr("router"))));
    }

    /// @dev Disabled for the mutant (it is expected to fail there); see test_mutant_shadowModelCatchesIt.
    function testFuzz_review_shadowModelAttributesEveryIntervalByBalance(uint256) public pure override {}

    function test_mutant_shadowModelCatchesIt() public {
        uint256 caught;
        for (uint256 s; s < 8; ++s) {
            uint256 snap = vm.snapshotState();
            try this.runModel(s) {} catch {
                caught++;
            }
            vm.revertToState(snap);
        }
        emit log_named_uint("seeds (of 8) on which the model caught the mutant", caught);
        assertGt(caught, 0);
    }
}
