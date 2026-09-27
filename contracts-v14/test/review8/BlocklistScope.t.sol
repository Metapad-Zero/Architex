// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Review8Base} from "./Review8Base.sol";

/// @notice Claude review #8, spec error (V14-SPEC §10, "A USDC blocklist"): "On the launchpad it stops only payouts:
///         pools keep trading and their fees wait as the hook's claims." Pools do keep trading, but a blocklisted
///         launchpad also stops every curve buy and sell (the launchpad pulls and pays the USDC), every graduation (it
///         passes the curve's USDC to the hook), every launch with a launch fee and every sync (the spec is corrected).
///         The hook half of the paragraph holds: a blocklisted hook stops only graduations; pool swaps, the bids they
///         place and sync all still work.
abstract contract BlocklistScopeTest is Review8Base {
    function test_aBlocklistedLaunchpadStopsTheCurvesAndGraduationToo() public {
        address graduated = _graduated(300, false);
        address live = _launch(0, creatorWallet, "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.prank(carol);
        pad.buy(live, 1_000e6, 0, carol, MAX);
        uint256 bag = IERC20(live).balanceOf(carol);

        usdc.setBlocked(address(pad), true);

        vm.startPrank(carol);
        vm.expectRevert();
        pad.buy(live, 1_000e6, 0, carol, MAX); // a curve buy
        vm.expectRevert();
        pad.sell(live, bag, 0, carol, MAX); // a curve sell
        vm.expectRevert();
        pad.buy(live, 1_000_000e6, 0, carol, MAX); // the graduating buy
        vm.expectRevert();
        pad.createToken("X", "X", "", 0, creatorWallet, "", false, 0, 0, MAX); // a launch (1 USDC launch fee)
        uint256 got = router.buy(graduated, 1_000e6, 0, carol, MAX); // the pool trades on
        router.sell(graduated, got, 0, carol, MAX);
        vm.stopPrank();
        vm.expectRevert();
        pad.syncPoolFees(graduated);
    }

    function test_aBlocklistedHookStopsOnlyGraduation() public {
        address graduated = _graduateWithCurveSnipe(300, false, dave, 0); // returns in the graduation block
        usdc.setBlocked(address(hook), true);

        uint256 bids0 = hook.bidCount(graduated);
        vm.startPrank(carol);
        uint256 got = router.buy(graduated, 1_000e6, 0, carol, MAX); // pool swaps: no USDC through the hook
        assertEq(hook.bidCount(graduated), bids0 + 1, "the opening-window surcharge became a bid");
        router.sell(graduated, got, 0, carol, MAX);
        vm.stopPrank();
        address live = _launch(0, creatorWallet, "", false, 0);
        _step(pad.SNIPE_BLOCKS());
        vm.startPrank(carol);
        pad.buy(live, 1_000e6, 0, carol, MAX); // the curve trades
        vm.expectRevert();
        pad.buy(live, 1_000_000e6, 0, carol, MAX); // but cannot graduate
        vm.stopPrank();
        pad.syncPoolFees(graduated); // the PoolManager pays the launchpad, not the hook
        _assertHookClean(graduated);
        _assertSolvent();
    }
}

contract BlocklistScopeUsdcLowTest is BlocklistScopeTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract BlocklistScopeUsdcHighTest is BlocklistScopeTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
