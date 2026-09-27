// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReviewBase} from "./ReviewBase.sol";

/// @notice Claude review #7 (informational, numbers for the owner's "is half enough?"): a creation-block curve sniper who holds
///         through graduation and then dumps into the pool is paid part of his own surcharge back by the bid it
///         became. Measured as: the sniper's dump proceeds with the bid in the pool, minus the same dump's proceeds
///         in the same pool without the bid (the surcharge moved out of the launchpad's pendingSnipe beforehand).
abstract contract SniperRefundTest is ReviewBase {
    function _dumpProceeds(bool withBid, uint256 snipeUsdc) internal returns (uint256 proceeds, uint256 surcharge) {
        address token = _launch(0, creatorWallet, "", false, 0);
        vm.prank(dave);
        pad.buy(token, snipeUsdc, 0, dave, MAX); // creation block: 90% surcharge
        surcharge = pad.pendingSnipe(token);
        if (!withBid) {
            // Counterfactual: no bid (zero the held surcharge and take the USDC out, keeping the books square).
            vm.store(address(pad), keccak256(abi.encode(token, uint256(8))), bytes32(0)); // pendingSnipe is slot 8
            require(pad.pendingSnipe(token) == 0, "slot");
            vm.prank(address(pad));
            usdc.transfer(address(0xdead), surcharge);
        }
        _step(pad.SNIPE_BLOCKS());
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX);
        _step(hook.SNIPE_BLOCKS());
        uint256 bag = IERC20(token).balanceOf(dave);
        uint256 u0 = usdc.balanceOf(dave);
        vm.prank(dave);
        router.sell(token, bag, 0, dave, MAX);
        proceeds = usdc.balanceOf(dave) - u0;
    }

    function test_curveSniperGetsPartOfHisSurchargeBack() public {
        uint256[3] memory snipes = [uint256(5_000e6), 20_000e6, 100_000e6];
        for (uint256 i; i < snipes.length; ++i) {
            uint256 snap = vm.snapshotState();
            (uint256 withBid, uint256 surcharge) = _dumpProceeds(true, snipes[i]);
            vm.revertToState(snap);
            (uint256 without,) = _dumpProceeds(false, snipes[i]);
            vm.revertToState(snap);
            console2.log("sniper spent (6dp)", snipes[i]);
            console2.log("  surcharge locked as the bid (6dp)", surcharge);
            console2.log("  dump proceeds with the bid (6dp)", withBid);
            console2.log("  refund from the bid, bps of surcharge", (withBid - without) * 1e4 / surcharge);
            assertGe(withBid, without);
        }
    }
}

contract SniperRefundUsdcHighTest is SniperRefundTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
