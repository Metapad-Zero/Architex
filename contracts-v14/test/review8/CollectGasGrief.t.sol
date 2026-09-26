// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Review8Base} from "./Review8Base.sol";

/// @notice Claude review #8 (holds). collectCreatorFees releases the pool's fees inside try/catch, so a caller could try
///         to pick a gas limit at which `release` runs out of gas (caught) while the rest of the collection still
///         completes on the 1/64 the EVM keeps back. Every gas limit from 30k to 600k is tried here, with the contracts'
///         storage cold as in a real transaction, both with launchpad-held creator fees to pay and with none (the cheapest
///         path after the catch): no call ever succeeds with the pool's fees left unreleased. Even if one did, nothing
///         would be lost: a caught release rolls back whole and the fees stay the hook's claims for the next call.
abstract contract CollectGasGriefTest is Review8Base {
    function _sweep(address token) internal returns (uint256 successes, uint256 skipped, uint256 minGas) {
        for (uint256 g = 30_000; g <= 600_000; g += 1_000) {
            uint256 snap = vm.snapshotState();
            vm.cool(address(pad));
            vm.cool(address(hook));
            vm.cool(POOL_MANAGER);
            vm.cool(address(usdc));
            (bool ok,) = address(pad).call{gas: g}(abi.encodeCall(pad.collectCreatorFees, (token)));
            if (ok) {
                if (minGas == 0) minGas = g;
                ++successes;
                if (hook.pendingCreator(token) + hook.pendingPlatform(token) != 0) ++skipped;
            }
            vm.revertToState(snap);
        }
    }

    function _poolFees(address token) internal {
        vm.prank(carol);
        uint256 got = router.buy(token, 10_000e6, 0, carol, MAX);
        vm.prank(carol);
        router.sell(token, got / 2, 0, carol, MAX);
        assertGt(hook.pendingCreator(token), 0);
    }

    function test_withCurveFeesToPay() public {
        address token = _graduated(500, false);
        _poolFees(token);
        assertGt(pad.pendingCreatorFees(token), 0, "curve creator fees in the launchpad");
        (uint256 successes, uint256 skipped, uint256 minGas) = _sweep(token);
        console2.log("successful gas limits", successes, "lowest", minGas);
        assertGt(successes, 0);
        assertEq(skipped, 0, "never succeeds with the release skipped");
    }

    function test_withNothingElseToPay() public {
        address token = _graduated(500, false);
        pad.collectCreatorFees(token); // the launchpad now holds none of this token's creator fees
        assertEq(pad.pendingCreatorFees(token), 0);
        _poolFees(token);
        (uint256 successes, uint256 skipped, uint256 minGas) = _sweep(token);
        console2.log("successful gas limits", successes, "lowest", minGas);
        assertGt(successes, 0);
        assertEq(skipped, 0, "never succeeds with the release skipped");
    }
}

contract CollectGasGriefUsdcLowTest is CollectGasGriefTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract CollectGasGriefUsdcHighTest is CollectGasGriefTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
