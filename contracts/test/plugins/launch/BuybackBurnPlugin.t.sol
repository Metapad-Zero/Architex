// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IBuybackBurnPlugin} from "../../../interfaces/plugins/IBuybackBurnPlugin.sol";
import {BuybackBurnPlugin} from "../../../plugins/launch/BuybackBurnPlugin.sol";
import {MockLaunchToken, MockLaunchPair} from "./LaunchPluginMocks.sol";
import {LaunchPluginTestBase, PluginConformanceTest} from "./LaunchPluginTestBase.sol";

contract BuybackBurnPluginConformanceTest is PluginConformanceTest {
    function _deployPlugin(address launchpad_) internal override returns (ILaunchFeePlugin) {
        return new BuybackBurnPlugin(launchpad_);
    }

    function _validData() internal pure override returns (bytes memory) {
        return "";
    }
}

contract BuybackBurnPluginTest is LaunchPluginTestBase {
    uint256 internal constant VIRTUAL_USDC_0 = 8_333_333_333;
    uint256 internal constant DEFAULT_CAP = 20_833_333; // 0.25% of VIRTUAL_USDC_0, rounded down
    uint256 internal constant TOKENS_PER_UNIT = 1e14; // the mocks' price

    BuybackBurnPlugin internal buyback;
    MockLaunchToken internal token;

    function setUp() public override {
        super.setUp();
        buyback = new BuybackBurnPlugin(address(launchpad));
        token = _launch(address(buyback), "");
    }

    function _graduate(MockLaunchToken t, uint112 reserveUsdc) internal {
        launchpad.setGraduated(address(t), true);
        _pairOf(t).setReserves(200_000_000e18, reserveUsdc);
    }

    function _run(MockLaunchToken t) internal returns (uint256 spent, uint256 burned) {
        vm.prank(keeper);
        return buyback.run(address(t));
    }

    // ─── Configuration ────────────────────────────────────────────────────────

    function test_onLaunch_rejectsAnyData() public {
        MockLaunchToken t = _newToken();
        vm.expectRevert(ILaunchFeePlugin.DataNotEmpty.selector);
        launchpad.launch(address(t), creator, address(buyback), address(0), hex"00");
        assertFalse(buyback.isConfigured(address(t)));
    }

    function test_constants() public view {
        assertEq(buyback.CAP_BPS(), 25);
        assertEq(buyback.RUN_INTERVAL(), 1 hours);
        assertEq(buyback.MIN_RUN_USDC(), 3);
    }

    // ─── Run on the curve ─────────────────────────────────────────────────────

    function test_run_onCurve_spendsTheCapWhenMoreIsHeld() public {
        _collect(token, 100e6);
        assertEq(buyback.usdcHeld(address(token)), 100e6);

        vm.expectEmit(true, true, false, true, address(buyback));
        emit IBuybackBurnPlugin.BuybackRun(address(token), keeper, false, DEFAULT_CAP, DEFAULT_CAP * TOKENS_PER_UNIT);
        (uint256 spent, uint256 burned) = _run(token);

        assertEq(spent, DEFAULT_CAP);
        assertEq(burned, DEFAULT_CAP * TOKENS_PER_UNIT);
        assertEq(launchpad.lastBuyUsdcIn(), DEFAULT_CAP, "offered the cap");
        assertEq(launchpad.lastBuyMinOut(), 0, "no slippage bound, by design");
        assertEq(launchpad.lastBuyTo(), address(buyback));
        assertEq(launchpad.lastBuyDeadline(), vm.getBlockTimestamp(), "the curve buy's deadline is now");
        assertEq(buyback.usdcHeld(address(token)), 100e6 - DEFAULT_CAP);
        assertEq(usdc.balanceOf(address(buyback)), 100e6 - DEFAULT_CAP);
        assertEq(buyback.totalUsdcSpent(address(token)), DEFAULT_CAP);
        assertEq(buyback.totalTokensBurned(address(token)), burned);
        assertEq(buyback.nextRunBlock(address(token)), block.number + 1);
        assertEq(usdc.allowance(address(buyback), address(launchpad)), 0);
        // A true burn: supply drops and the plugin keeps nothing.
        assertEq(token.burnCalls(), 1);
        assertEq(token.totalBurned(), burned);
        assertEq(token.totalSupply(), 0);
        assertEq(token.balanceOf(address(buyback)), 0);
    }

    function test_run_onCurve_spendsEverythingHeldWhenBelowTheCap() public {
        _collect(token, 5e6);
        (uint256 spent,) = _run(token);
        assertEq(spent, 5e6);
        assertEq(buyback.usdcHeld(address(token)), 0);
        assertEq(usdc.balanceOf(address(buyback)), 0);
    }

    function test_run_capTracksTheCurvesVirtualUsdc() public {
        launchpad.setVirtualUsdc(address(token), 40_000e6);
        _collect(token, 250e6);
        (uint256 spent,) = _run(token);
        assertEq(spent, 100e6); // 0.25% of 40,000 USDC
    }

    function test_run_capRoundingToZeroMeansNothingToBuy() public {
        launchpad.setVirtualUsdc(address(token), 399); // 399 * 25 / 10,000 = 0
        _collect(token, 100e6);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, address(token)));
        _run(token);
    }

    /// @dev The sell-out buy: the launchpad takes only what the last curve tokens cost and graduates the token.
    ///      The rest of the offer stays held, and no allowance is left behind.
    function test_run_sellOutBuySpendsLessThanOffered() public {
        launchpad.setSellOutCost(address(token), 7e6);
        _collect(token, 100e6);

        (uint256 spent, uint256 burned) = _run(token);

        assertEq(launchpad.lastBuyUsdcIn(), DEFAULT_CAP, "offered the cap");
        assertEq(spent, 7e6, "spent only the sell-out cost");
        assertEq(burned, 7e6 * TOKENS_PER_UNIT);
        assertTrue(launchpad.isGraduated(address(token)));
        assertEq(buyback.usdcHeld(address(token)), 93e6);
        assertEq(usdc.balanceOf(address(buyback)), 93e6);
        assertEq(usdc.allowance(address(buyback), address(launchpad)), 0);
    }

    function test_run_sellOutThenTheNextRunBuysInThePool() public {
        launchpad.setSellOutCost(address(token), 7e6);
        _collect(token, 100e6);
        _run(token);
        _pairOf(token).setReserves(200_000_000e18, 40_000e6);

        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.AlreadyRanThisBlock.selector, address(token)));
        _run(token);

        // An hour on, the budget is a full cap again (pacing: BuybackBurnPacing.t.sol).
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (uint256 spent,) = _run(token);
        assertEq(spent, 93e6); // below the pool cap of 100e6
        assertEq(router.lastUsdcIn(), 93e6);
        assertEq(buyback.usdcHeld(address(token)), 0);
        assertEq(buyback.totalUsdcSpent(address(token)), 100e6);
        assertEq(token.totalSupply(), 0);
    }

    // ─── Run after graduation ─────────────────────────────────────────────────

    function test_run_afterGraduation_buysThroughTheRouterCappedByThePoolReserve() public {
        _graduate(token, 40_000e6);
        _collect(token, 150e6);

        vm.expectEmit(true, true, false, true, address(buyback));
        emit IBuybackBurnPlugin.BuybackRun(address(token), keeper, true, 100e6, 100e6 * TOKENS_PER_UNIT);
        (uint256 spent, uint256 burned) = _run(token);

        assertEq(spent, 100e6); // 0.25% of the pool's 40,000 USDC
        assertEq(router.lastUsdcIn(), 100e6);
        assertEq(router.lastMinOut(), 0, "no slippage bound, by design");
        assertEq(router.lastTo(), address(buyback));
        assertEq(router.lastDeadline(), block.timestamp);
        assertEq(launchpad.buyCalls(), 0, "never the curve after graduation");
        assertEq(usdc.balanceOf(address(_pairOf(token))), 100e6);
        assertEq(usdc.allowance(address(buyback), address(router)), 0);
        assertEq(buyback.usdcHeld(address(token)), 50e6);
        assertEq(burned, 100e6 * TOKENS_PER_UNIT);
        assertEq(token.totalSupply(), 0);
        assertEq(token.burnCalls(), 1);
    }

    function test_run_afterGraduation_routerIsReadLazily() public {
        _graduate(token, 40_000e6);
        _collect(token, 10e6);
        launchpad.setRouter(address(0));
        vm.expectRevert(IBuybackBurnPlugin.RouterNotSet.selector);
        _run(token);

        launchpad.setRouter(address(router));
        (uint256 spent,) = _run(token);
        assertEq(spent, 10e6);
    }

    function test_run_afterGraduation_revertsWithoutAPair() public {
        _graduate(token, 40_000e6);
        _collect(token, 10e6);
        launchpad.setPair(address(token), address(0));
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.PairNotSet.selector, address(token)));
        _run(token);
    }

    /// @dev Accounting follows the USDC that actually left, not what was offered.
    function test_run_afterGraduation_accountsWhatTheRouterActuallyPulled() public {
        _graduate(token, 40_000e6);
        _collect(token, 150e6);
        router.setPullShortfall(1e6);
        (uint256 spent,) = _run(token);
        assertEq(spent, 99e6);
        assertEq(buyback.usdcHeld(address(token)), 51e6);
        assertEq(usdc.balanceOf(address(buyback)), 51e6);
        assertEq(usdc.allowance(address(buyback), address(router)), 0);
    }

    // ─── Once per block, per token ────────────────────────────────────────────

    function test_run_atMostOncePerTokenPerBlock() public {
        _collect(token, 100e6);
        _run(token);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.AlreadyRanThisBlock.selector, address(token)));
        _run(token);
        (uint256 offered,) = buyback.previewRun(address(token));
        assertEq(offered, 0);

        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (uint256 spent,) = _run(token);
        // The first run's buy raised the curve's virtual USDC, and the cap follows the reserve.
        assertEq(spent, ((VIRTUAL_USDC_0 + DEFAULT_CAP) * 25) / 10_000);
    }

    function test_run_anotherTokenCanRunInTheSameBlock() public {
        MockLaunchToken other = _launch(address(buyback), "");
        _collect(token, 100e6);
        _collect(other, 100e6);
        _run(token);
        (uint256 spent,) = _run(other);
        assertEq(spent, DEFAULT_CAP);
    }

    // ─── Guards ───────────────────────────────────────────────────────────────

    function test_run_revertsForUnconfiguredToken() public {
        MockLaunchToken other = _launch(alice, "");
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotConfigured.selector, address(other)));
        _run(other);
    }

    function test_run_revertsWhenNothingIsHeld() public {
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, address(token)));
        _run(token);
    }

    function test_run_revertsWhenTheLaunchpadMisreportsTheSpend() public {
        _collect(token, 100e6);
        launchpad.setReportedSpendSkew(1);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.SpendMismatch.selector, DEFAULT_CAP + 1, DEFAULT_CAP));
        _run(token);
    }

    function test_run_revertsWhenTheBuyDeliversNoTokens() public {
        _collect(token, 100e6);
        launchpad.setWithholdTokens(true);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingBought.selector, address(token)));
        _run(token);
        assertEq(buyback.usdcHeld(address(token)), 100e6);
    }

    /// @dev The spend is what the launchpad pulled through the allowance, so USDC that reaches the plugin during the
    ///      buy is not mistaken for a smaller spend: it stays in the plugin, uncredited, like any direct transfer.
    function test_run_usdcArrivingDuringTheBuyDoesNotDistortTheSpend() public {
        _collect(token, 100e6);
        usdc.mint(address(launchpad), 7e6);
        launchpad.setDonateDuringBuy(7e6);

        (uint256 spent,) = _run(token);

        assertEq(spent, DEFAULT_CAP);
        assertEq(buyback.usdcHeld(address(token)), 100e6 - DEFAULT_CAP);
        assertEq(usdc.balanceOf(address(buyback)), 100e6 - DEFAULT_CAP + 7e6);
    }

    function test_run_burnsTokensSentToThePluginToo() public {
        _collect(token, 100e6);
        token.mint(address(buyback), 5e18);
        (, uint256 burned) = _run(token);
        assertEq(burned, DEFAULT_CAP * TOKENS_PER_UNIT + 5e18);
        assertEq(token.balanceOf(address(buyback)), 0);
        assertEq(token.totalSupply(), 0);
    }

    // ─── Views and isolation ──────────────────────────────────────────────────

    function test_previewRun() public {
        (uint256 offered, bool graduated) = buyback.previewRun(address(token));
        assertEq(offered, 0);
        assertFalse(graduated);

        _collect(token, 100e6);
        (offered, graduated) = buyback.previewRun(address(token));
        assertEq(offered, DEFAULT_CAP);

        _graduate(token, 1_000e6);
        (offered, graduated) = buyback.previewRun(address(token));
        assertEq(offered, 2.5e6);
        assertTrue(graduated);

        MockLaunchToken unconfigured = _launch(alice, "");
        (offered,) = buyback.previewRun(address(unconfigured));
        assertEq(offered, 0);
    }

    /// @dev A run spends only the running token's USDC, even when the plugin holds much more for other tokens.
    function test_perTokenIsolation() public {
        MockLaunchToken other = _launch(address(buyback), "");
        _collect(token, 100e6);
        _collect(other, 3e6);

        (uint256 spent,) = _run(other);
        assertEq(spent, 3e6);
        assertEq(buyback.usdcHeld(address(other)), 0);
        assertEq(buyback.usdcHeld(address(token)), 100e6);

        vm.roll(block.number + 1);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, address(other)));
        _run(other);

        (spent,) = _run(token);
        assertEq(spent, DEFAULT_CAP);
        assertEq(buyback.totalUsdcSpent(address(other)), 3e6);
        assertEq(usdc.balanceOf(address(buyback)), 100e6 - DEFAULT_CAP);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_run_onCurve(uint64 heldRaw, uint64 virtualUsdcRaw, uint64 sellOutRaw) public {
        uint256 held = bound(heldRaw, 3, 1e13); // from MIN_RUN_USDC (dust: BuybackBurnDust.t.sol)
        uint256 virtualUsdc = bound(virtualUsdcRaw, VIRTUAL_USDC_0, 1e14);
        uint256 sellOut = bound(sellOutRaw, 1, 2e13);
        launchpad.setVirtualUsdc(address(token), virtualUsdc);
        launchpad.setSellOutCost(address(token), sellOut);
        _collect(token, held);

        uint256 cap = (virtualUsdc * 25) / 10_000;
        uint256 offer = held < cap ? held : cap;
        uint256 expectedSpend = offer < sellOut ? offer : sellOut;

        (uint256 spent, uint256 burned) = _run(token);
        assertEq(spent, expectedSpend);
        assertLe(spent, cap, "never above 0.25% of the reserve");
        assertEq(burned, spent * TOKENS_PER_UNIT);
        assertEq(buyback.usdcHeld(address(token)), held - spent);
        assertEq(usdc.balanceOf(address(buyback)), held - spent);
        assertEq(usdc.allowance(address(buyback), address(launchpad)), 0);
        assertEq(launchpad.isGraduated(address(token)), offer >= sellOut);
        assertEq(token.totalSupply(), 0);
    }

    function testFuzz_run_inThePool(uint64 heldRaw, uint112 reserveUsdcRaw) public {
        uint256 held = bound(heldRaw, 3, 1e13); // from MIN_RUN_USDC (dust: BuybackBurnDust.t.sol)
        uint112 reserveUsdc = uint112(bound(reserveUsdcRaw, 1200, 1e15)); // cap >= MIN_RUN_USDC
        _graduate(token, reserveUsdc);
        _collect(token, held);

        uint256 cap = (uint256(reserveUsdc) * 25) / 10_000;
        uint256 offer = held < cap ? held : cap;

        (uint256 spent,) = _run(token);
        assertEq(spent, offer);
        assertLe(spent, cap, "never above 0.25% of the reserve");
        assertEq(buyback.usdcHeld(address(token)), held - spent);
        assertEq(usdc.balanceOf(address(buyback)), held - spent);
        assertEq(usdc.allowance(address(buyback), address(router)), 0);
        assertEq(token.totalSupply(), 0);
    }
}
