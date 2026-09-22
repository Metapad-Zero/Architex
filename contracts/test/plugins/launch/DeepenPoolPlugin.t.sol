// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchPair} from "../../../launchpad/LaunchPair.sol";
import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IDeepenPoolPlugin} from "../../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {DeepenPoolPlugin} from "../../../plugins/launch/DeepenPoolPlugin.sol";
import {MockLaunchToken} from "./LaunchPluginMocks.sol";
import {SkewedMintPair} from "./DeepenPoolMocks.sol";
import {PluginConformanceTest} from "./LaunchPluginTestBase.sol";
import {DeepenPoolTestBase} from "./DeepenPoolTestBase.sol";

contract DeepenPoolPluginConformanceTest is PluginConformanceTest {
    function _deployPlugin(address launchpad_) internal override returns (ILaunchFeePlugin) {
        return new DeepenPoolPlugin(launchpad_);
    }

    function _validData() internal pure override returns (bytes memory) {
        return "";
    }
}

/// @notice Deepen pool against the mock launchpad (curve) and real LaunchPairs behind a mock router (pool).
contract DeepenPoolPluginTest is DeepenPoolTestBase {
    uint256 internal constant DEFAULT_CAP = 20_833_333; // 0.25% of VIRTUAL_USDC_0, rounded down
    uint256 internal constant POOL_CAP = 62_500_000; // 0.25% of POOL_USDC
    uint256 internal constant VIRTUAL_USDC_0_MOCK = 8_333_333_333; // the mock curve's starting virtual USDC

    MockLaunchToken internal token;
    LaunchPair internal pair;

    function setUp() public override {
        super.setUp();
        (token, pair) = _launchDeepen();
    }

    // ─── Configuration and deliveries ─────────────────────────────────────────

    function test_onLaunch_rejectsAnyData() public {
        MockLaunchToken t = _newToken();
        vm.expectRevert(ILaunchFeePlugin.DataNotEmpty.selector);
        launchpad.launch(address(t), creator, address(deepen), address(0), hex"00");
        assertFalse(deepen.isConfigured(address(t)));
    }

    function test_constants() public view {
        assertEq(deepen.CAP_BPS(), 25);
        assertEq(deepen.RUN_INTERVAL(), 1 hours);
        assertEq(deepen.MIN_RUN_USDC(), 3);
        assertEq(deepen.LP_RECIPIENT(), DEAD);
    }

    /// @dev Anyone may top a configured token's pot up (Architex's fee wallet, say): credited to that token, spent by
    ///      its runs like any creator fee, and never paid back.
    function test_anyoneCanTopUpAConfiguredTokensPot() public {
        usdc.mint(alice, 7e6);
        vm.startPrank(alice);
        usdc.approve(address(deepen), type(uint256).max);
        vm.expectEmit(true, true, false, true, address(deepen));
        emit ILaunchFeePlugin.FeesReceived(address(token), alice, 7e6);
        deepen.onFees(address(token), 7e6);
        vm.stopPrank();
        assertEq(deepen.usdcHeld(address(token)), 7e6);
        assertEq(usdc.balanceOf(alice), 0, "pulled exactly");
        (uint256 spent,,) = _runAs(keeper, address(token));
        assertEq(spent, 7e6);
        assertEq(deepen.usdcHeld(address(token)), 0);
    }

    // ─── Run on the curve (Buyback & burn's) ──────────────────────────────────

    function test_run_onCurve_spendsTheCapAndBurnsEverything() public {
        _collect(token, 100e6);
        uint256 bought = DEFAULT_CAP * TOKENS_PER_UNIT;
        vm.expectEmit(true, true, false, true, address(deepen));
        emit IDeepenPoolPlugin.DeepenRun(address(token), keeper, false, DEFAULT_CAP, 0, bought, 0, bought, 0);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));

        assertEq(spent, DEFAULT_CAP);
        assertEq(burned, bought);
        assertEq(liquidity, 0, "no liquidity on the curve");
        assertEq(launchpad.lastBuyUsdcIn(), DEFAULT_CAP, "offered the cap");
        assertEq(launchpad.lastBuyMinOut(), 0, "no slippage bound, by design");
        assertEq(launchpad.lastBuyTo(), address(deepen));
        assertEq(launchpad.lastBuyDeadline(), vm.getBlockTimestamp(), "the curve buy's deadline is now");
        assertEq(deepen.usdcHeld(address(token)), 100e6 - DEFAULT_CAP);
        assertEq(usdc.balanceOf(address(deepen)), 100e6 - DEFAULT_CAP);
        assertEq(deepen.totalUsdcSpent(address(token)), DEFAULT_CAP);
        assertEq(deepen.totalTokensBurned(address(token)), burned);
        assertEq(deepen.totalUsdcAdded(address(token)) + deepen.totalTokensAdded(address(token)), 0);
        assertEq(deepen.totalLiquidityLocked(address(token)), 0);
        assertEq(deepen.nextRunBlock(address(token)), block.number + 1);
        assertEq(deepen.lastRunAt(address(token)), vm.getBlockTimestamp());
        assertEq(usdc.allowance(address(deepen), address(launchpad)), 0);
        assertEq(token.burnCalls(), 1);
        assertEq(token.totalSupply(), 0, "a true burn");
        assertEq(token.balanceOf(address(deepen)), 0);
        assertEq(poolRouter.buyCalls(), 0, "never the router before graduation");
    }

    function test_run_onCurve_spendsEverythingHeldBelowTheCap() public {
        _collect(token, 5e6);
        (uint256 spent,,) = _runAs(keeper, address(token));
        assertEq(spent, 5e6);
        assertEq(deepen.usdcHeld(address(token)), 0);
        assertEq(usdc.balanceOf(address(deepen)), 0);
    }

    function test_run_onCurve_capTracksTheCurvesVirtualUsdc() public {
        launchpad.setVirtualUsdc(address(token), 40_000e6);
        _collect(token, 250e6);
        (uint256 spent,,) = _runAs(keeper, address(token));
        assertEq(spent, 100e6);
    }

    /// @dev The sell-out buy: the launchpad takes only what the last tokens cost and graduates the token; the rest of
    ///      the offer stays held and no allowance is left behind.
    function test_run_onCurve_sellOutBuySpendsLessThanOfferedAndKeepsTheRest() public {
        launchpad.setSellOutCost(address(token), 7e6);
        _collect(token, 100e6);
        (uint256 spent, uint256 burned,) = _runAs(keeper, address(token));
        assertEq(launchpad.lastBuyUsdcIn(), DEFAULT_CAP, "offered the cap");
        assertEq(spent, 7e6, "spent only the sell-out cost");
        assertEq(burned, 7e6 * TOKENS_PER_UNIT);
        assertTrue(launchpad.isGraduated(address(token)));
        assertEq(deepen.usdcHeld(address(token)), 93e6);
        assertEq(usdc.balanceOf(address(deepen)), 93e6);
        assertEq(usdc.allowance(address(deepen), address(launchpad)), 0);
    }

    /// @dev After the sell-out run the token is in its pool; the next run, paced from the sell-out run, deepens it.
    function test_run_sellOutThenTheNextRunDeepensThePool() public {
        launchpad.setSellOutCost(address(token), 7e6);
        _collect(token, 1_000e6);
        _runAs(keeper, address(token));
        _graduate(token, pair, POOL_TOKENS, POOL_USDC); // what the launchpad's graduation does

        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.AlreadyRanThisBlock.selector, address(token)));
        _runAs(keeper, address(token));

        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 30 minutes);
        (uint256 offered, bool graduated) = deepen.previewRun(address(token));
        assertTrue(graduated);
        assertEq(offered, POOL_CAP / 2, "half an hour: half the pool's cap");
        uint256 deadBefore = pair.balanceOf(DEAD);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertLe(spent, offered);
        assertLe(offered - spent, 4, "only rounding stays behind");
        assertEq(burned, 0);
        assertGt(liquidity, 0);
        assertEq(pair.balanceOf(DEAD), deadBefore + liquidity, "the LP went to the burn address");
        assertEq(deepen.usdcHeld(address(token)), 1_000e6 - 7e6 - spent);
    }

    function test_run_onCurve_revertsWhenTheLaunchpadMisreportsTheSpend() public {
        _collect(token, 100e6);
        launchpad.setReportedSpendSkew(1);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.SpendMismatch.selector, DEFAULT_CAP + 1, DEFAULT_CAP));
        _runAs(keeper, address(token));
    }

    function test_run_onCurve_revertsWhenTheBuyDeliversNoTokens() public {
        _collect(token, 100e6);
        launchpad.setWithholdTokens(true);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingBought.selector, address(token)));
        _runAs(keeper, address(token));
        assertEq(deepen.usdcHeld(address(token)), 100e6);
        assertEq(deepen.lastRunAt(address(token)), 0, "a reverted run leaves the pacing untouched");
    }

    /// @dev The spend is what the launchpad pulled through the allowance: USDC reaching the plugin during the buy is
    ///      not mistaken for a smaller spend; it stays in the plugin, uncredited, like any direct transfer.
    function test_run_onCurve_usdcArrivingDuringTheBuyDoesNotDistortTheSpend() public {
        _collect(token, 100e6);
        usdc.mint(address(launchpad), 7e6);
        launchpad.setDonateDuringBuy(7e6);
        (uint256 spent,,) = _runAs(keeper, address(token));
        assertEq(spent, DEFAULT_CAP);
        assertEq(deepen.usdcHeld(address(token)), 100e6 - DEFAULT_CAP);
        assertEq(usdc.balanceOf(address(deepen)), 100e6 - DEFAULT_CAP + 7e6);
    }

    function test_run_onCurve_burnsTokensSentToThePluginToo() public {
        _collect(token, 100e6);
        token.mint(address(deepen), 5e18);
        (, uint256 burned,) = _runAs(keeper, address(token));
        assertEq(burned, DEFAULT_CAP * TOKENS_PER_UNIT + 5e18);
        assertEq(token.balanceOf(address(deepen)), 0);
        assertEq(token.totalSupply(), 0);
    }

    // ─── Run in the pool ──────────────────────────────────────────────────────

    /// @dev A full cap: about half buys through the router, the rest goes into the pool with every token bought, and
    ///      the LP is minted straight to 0x…dEaD. The pool's token reserve ends where it was; its USDC reserve grows by
    ///      the net buy and the add; the plugin keeps no token, no LP and no allowance.
    function test_run_inPool_buysAboutHalfAndLocksTheAddAtDead() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 1_000e6);
        (uint256 toBuy, uint256 forLiquidity) = deepen.previewSplit(address(token), POOL_CAP);
        assertEq(toBuy + forLiquidity, POOL_CAP);
        assertApproxEqAbs(toBuy, _refRoot(POOL_CAP, POOL_USDC, FEE_BPS_TOTAL), 1, "the documented root");
        assertGt(toBuy, POOL_CAP / 2, "a little over half buys: the buy pays the fees");
        assertLt(toBuy, POOL_CAP * 51 / 100);
        Sim memory s = _simulate(address(token), pair, POOL_CAP, toBuy, 0);
        uint256 deadBefore = pair.balanceOf(DEAD);
        uint256 supplyBefore = pair.totalSupply();
        (uint256 rt0, uint256 ru0) = _reservesOf(pair);
        (uint256 platformFee, uint256 creatorFee) = _fees(toBuy);

        vm.expectEmit(true, true, false, true, address(deepen));
        emit IDeepenPoolPlugin.DeepenRun(
            address(token), keeper, true, toBuy + s.usdcAdded, s.usdcAdded, s.tokensBought, s.tokensAdded, 0, s.liquidity
        );
        vm.expectEmit(true, true, true, true, address(pair));
        emit IERC20.Transfer(address(0), DEAD, s.liquidity);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));

        assertEq(spent, toBuy + s.usdcAdded);
        assertEq(burned, 0, "every token bought went into the pool");
        assertEq(s.tokensAdded, s.tokensBought);
        assertEq(liquidity, s.liquidity);
        assertGt(liquidity, 0);
        assertLe(POOL_CAP - spent, 4, "at most 4 units stay for the next run");
        assertEq(poolRouter.lastUsdcIn(), toBuy);
        assertEq(poolRouter.lastMinOut(), 0, "no slippage bound, by design");
        assertEq(poolRouter.lastTo(), address(deepen));
        assertEq(poolRouter.lastDeadline(), vm.getBlockTimestamp());
        assertEq(launchpad.buyCalls(), 0, "never the curve after graduation");

        (uint256 rt1, uint256 ru1) = _reservesOf(pair);
        assertEq(rt1, rt0, "the token reserve is back where it was");
        assertEq(ru1, ru0 + (toBuy - platformFee - creatorFee) + s.usdcAdded, "net buy + add");
        assertGt(rt1 * ru1, rt0 * ru0, "k grows");
        assertEq(pair.balanceOf(DEAD), deadBefore + liquidity, "the LP went to the burn address");
        assertEq(pair.totalSupply(), supplyBefore + liquidity);
        assertEq(pair.balanceOf(address(deepen)), 0, "no LP kept");
        assertEq(token.balanceOf(address(deepen)), 0, "no token kept");
        assertEq(usdc.allowance(address(deepen), address(poolRouter)), 0);
        assertEq(usdc.balanceOf(address(pair)), ru1, "nothing left for anyone to skim");
        assertEq(token.balanceOf(address(pair)), rt1);

        assertEq(deepen.usdcHeld(address(token)), 1_000e6 - spent);
        assertEq(usdc.balanceOf(address(deepen)), 1_000e6 - spent);
        assertEq(deepen.totalUsdcSpent(address(token)), spent);
        assertEq(deepen.totalUsdcAdded(address(token)), s.usdcAdded);
        assertEq(deepen.totalTokensAdded(address(token)), s.tokensAdded);
        assertEq(deepen.totalLiquidityLocked(address(token)), liquidity);
        assertEq(deepen.totalTokensBurned(address(token)), 0);
    }

    function test_run_inPool_routerIsReadLazily() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 10e6);
        launchpad.setRouter(address(0));
        vm.expectRevert(IDeepenPoolPlugin.RouterNotSet.selector);
        _runAs(keeper, address(token));
        launchpad.setRouter(address(poolRouter));
        (uint256 spent,,) = _runAs(keeper, address(token));
        assertLe(10e6 - spent, 4);
    }

    function test_run_inPool_revertsWithoutAPair() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 10e6);
        launchpad.setPair(address(token), address(0));
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.PairNotSet.selector, address(token)));
        _runAs(keeper, address(token));
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.PairNotSet.selector, address(token)));
        deepen.previewRun(address(token));
    }

    /// @dev Accounting follows the USDC that actually left, never what was offered: a router that pulls less leaves
    ///      more for the add, which the tokens then limit; the rest stays held.
    function test_run_inPool_accountsWhatTheRouterActuallyPulled() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 1_000e6);
        (uint256 toBuy,) = deepen.previewSplit(address(token), POOL_CAP);
        poolRouter.setPullShortfall(1e6);
        (uint256 spent,, uint256 liquidity) = _runAs(keeper, address(token));
        uint256 added = deepen.totalUsdcAdded(address(token));
        assertEq(spent, toBuy - 1e6 + added, "the pull plus the add");
        assertGt(POOL_CAP - spent, 1e6, "the tokens limit the add; the rest stays held");
        assertGt(liquidity, 0);
        assertEq(deepen.usdcHeld(address(token)), 1_000e6 - spent);
        assertEq(usdc.balanceOf(address(deepen)), 1_000e6 - spent);
        assertEq(usdc.allowance(address(deepen), address(poolRouter)), 0, "the unused allowance is removed");
        assertEq(token.balanceOf(address(deepen)), 0);
    }

    function test_run_inPool_revertsWhenTheRouterReportsMoreThanItDelivered() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 100e6);
        poolRouter.setReportSkew(1);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingBought.selector, address(token)));
        _runAs(keeper, address(token));
    }

    function test_run_inPool_revertsWhenTheTokensGoElsewhere() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 100e6);
        poolRouter.setDivertTo(alice);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingBought.selector, address(token)));
        _runAs(keeper, address(token));
    }

    /// @dev The plugin computes the LP the pair's formula owes the deposit and refuses anything else, in either
    ///      direction (a pair that does not do what LaunchPair does).
    function test_run_inPool_revertsWhenThePairMintsOtherThanComputed() public {
        MockLaunchToken t = _newToken();
        SkewedMintPair skewed = new SkewedMintPair(address(t), address(usdc), address(poolRouter));
        launchpad.launch(address(t), creator, address(deepen), address(skewed), "");
        t.mint(address(skewed), POOL_TOKENS);
        usdc.mint(address(skewed), POOL_USDC);
        skewed.mint(DEAD);
        launchpad.setGraduated(address(t), true);
        _collect(t, 1_000e6);

        (uint256 toBuy,) = deepen.previewSplit(address(t), POOL_CAP);
        Sim memory s = _simulate(address(t), LaunchPair(address(skewed)), POOL_CAP, toBuy, 0);
        skewed.setMintSkew(1, false);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.LiquidityMismatch.selector, s.liquidity, s.liquidity + 1));
        _runAs(keeper, address(t));
        skewed.setMintSkew(1, true);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.LiquidityMismatch.selector, s.liquidity, s.liquidity - 1));
        _runAs(keeper, address(t));
        skewed.setMintSkew(0, false);
        (,, uint256 liquidity) = _runAs(keeper, address(t));
        assertEq(liquidity, s.liquidity);
    }

    /// @dev The minimum offer (3 units) is all buy: nothing is left to add, so everything bought is burned.
    function test_run_inPool_minimumOfferIsBuyAndBurn() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _payDirect(address(deepen), address(token), alice, 3);
        (uint256 toBuy, uint256 forLiquidity) = deepen.previewSplit(address(token), 3);
        assertEq(toBuy, 3);
        assertEq(forLiquidity, 0);
        (uint256 bought,,) = poolRouter.quoteBuy(address(token), 3);
        uint256 supplyBefore = pair.totalSupply();
        vm.expectEmit(true, true, false, true, address(deepen));
        emit IDeepenPoolPlugin.DeepenRun(address(token), keeper, true, 3, 0, bought, 0, bought, 0);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertEq(spent, 3);
        assertEq(burned, bought);
        assertEq(liquidity, 0);
        assertEq(pair.totalSupply(), supplyBefore, "no LP minted");
        assertEq(token.balanceOf(address(deepen)), 0);
    }

    /// @dev Offers of a few units: the buy is raised to 3 units, an add too small to mint LP is skipped (its tokens
    ///      burned, its USDC kept), and nothing ever reverts or stays in the plugin but USDC.
    function test_run_inPool_dustOffersNeverRevert() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        for (uint256 held = 3; held < 12; ++held) {
            uint256 snap = vm.snapshotState();
            _payDirect(address(deepen), address(token), alice, held);
            (uint256 toBuy,) = deepen.previewSplit(address(token), held);
            assertGe(toBuy, 3);
            Sim memory s = _simulate(address(token), pair, held, toBuy, 0);
            (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
            assertEq(spent, toBuy + s.usdcAdded);
            assertEq(burned, s.burned);
            assertEq(liquidity, s.liquidity);
            assertEq(token.balanceOf(address(deepen)), 0);
            assertEq(deepen.usdcHeld(address(token)), held - spent);
            vm.revertToState(snap);
        }
    }

    /// @dev Tokens sent to the plugin join the add: the USDC left then limits it, all of that USDC goes in, and the
    ///      tokens it cannot pair are burned. The plugin ends with none.
    function test_run_inPool_strayTokensAreAddedOrBurned() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 1_000e6);
        token.mint(address(deepen), 1_000_000e18); // ~125 USDC worth, more than the add can pair
        (uint256 toBuy,) = deepen.previewSplit(address(token), POOL_CAP);
        Sim memory s = _simulate(address(token), pair, POOL_CAP, toBuy, 1_000_000e18);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertEq(spent, POOL_CAP, "all the USDC left went into the pool");
        assertEq(s.leftover, 0);
        assertEq(burned, s.burned);
        assertGt(burned, 0);
        assertEq(liquidity, s.liquidity);
        assertEq(s.tokensAdded + burned, s.tokensBought + 1_000_000e18, "every token added or burned");
        assertEq(token.balanceOf(address(deepen)), 0);
    }

    /// @dev LP someone sends the plugin is passed to 0x…dEaD by the next pool run, with the run's own LP.
    function test_run_inPool_strayLiquidityIsLockedAtDead() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 1_000e6);
        token.mint(address(pair), 800_000e18); // 100 USDC at the pool's price
        usdc.mint(address(pair), 100e6);
        uint256 stray = pair.mint(address(deepen));
        assertGt(stray, 0);
        uint256 deadBefore = pair.balanceOf(DEAD);
        vm.expectEmit(true, true, true, true, address(pair));
        emit IERC20.Transfer(address(deepen), DEAD, stray);
        (,, uint256 liquidity) = _runAs(keeper, address(token));
        assertEq(pair.balanceOf(address(deepen)), 0);
        assertEq(pair.balanceOf(DEAD), deadBefore + liquidity + stray);
        assertEq(deepen.totalLiquidityLocked(address(token)), liquidity, "the books count only what the run minted");
    }

    /// @dev USDC or tokens donated to the pair before a run (not synced) are absorbed into the reserves by the run's
    ///      own buy, so the mint credits exactly the run's deposit; the plugin's check passes and nothing is left to
    ///      skim afterwards.
    function test_run_inPool_aDonationBeforeTheRunIsAbsorbedNotSkimmable() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 1_000e6);
        usdc.mint(address(pair), 5e6);
        token.mint(address(pair), 1_000e18);
        uint256 deadBefore = pair.balanceOf(DEAD);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertGt(liquidity, 0);
        assertLe(spent, POOL_CAP);
        assertEq(pair.balanceOf(DEAD), deadBefore + liquidity);
        (uint256 rt, uint256 ru) = _reservesOf(pair);
        assertEq(usdc.balanceOf(address(pair)), ru);
        assertEq(token.balanceOf(address(pair)), rt);
        assertEq(token.balanceOf(address(deepen)), 0);
        assertEq(deepen.totalTokensBurned(address(token)), burned);
        pair.skim(attacker);
        assertEq(usdc.balanceOf(attacker) + token.balanceOf(attacker), 0, "nothing to skim");
    }

    // ─── Once per block, per token ────────────────────────────────────────────

    function test_run_atMostOncePerTokenPerBlock() public {
        _collect(token, 100e6);
        _runAs(keeper, address(token));
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.AlreadyRanThisBlock.selector, address(token)));
        _runAs(keeper, address(token));
        (uint256 offered,) = deepen.previewRun(address(token));
        assertEq(offered, 0);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 1 hours);
        (uint256 spent,,) = _runAs(keeper, address(token));
        assertEq(spent, ((VIRTUAL_USDC_0_MOCK + DEFAULT_CAP) * 25) / 10_000, "the cap follows the grown reserve");
    }

    function test_run_anotherTokenCanRunInTheSameBlock() public {
        (MockLaunchToken other,) = _launchDeepen();
        _collect(token, 100e6);
        _collect(other, 100e6);
        _runAs(keeper, address(token));
        (uint256 spent,,) = _runAs(keeper, address(other));
        assertEq(spent, DEFAULT_CAP);
    }

    // ─── Guards ───────────────────────────────────────────────────────────────

    function test_run_revertsForUnconfiguredToken() public {
        MockLaunchToken other = _launch(alice, "");
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotConfigured.selector, address(other)));
        _runAs(keeper, address(other));
    }

    function test_run_revertsWhenNothingIsHeld() public {
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, address(token)));
        _runAs(keeper, address(token));
    }

    // ─── Views and isolation ──────────────────────────────────────────────────

    function test_previewRun() public {
        (uint256 offered, bool graduated) = deepen.previewRun(address(token));
        assertEq(offered, 0);
        assertFalse(graduated);
        _collect(token, 100e6);
        (offered, graduated) = deepen.previewRun(address(token));
        assertEq(offered, DEFAULT_CAP);
        _graduate(token, pair, POOL_TOKENS, 1_000e6);
        (offered, graduated) = deepen.previewRun(address(token));
        assertEq(offered, 2.5e6);
        assertTrue(graduated);
        MockLaunchToken unconfigured = _launch(alice, "");
        (offered,) = deepen.previewRun(address(unconfigured));
        assertEq(offered, 0);
    }

    function test_previewSplit() public {
        (uint256 toBuy, uint256 forLiquidity) = deepen.previewSplit(address(token), 50e6);
        assertEq(toBuy, 50e6, "on the curve the whole offer buys");
        assertEq(forLiquidity, 0);
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        (toBuy, forLiquidity) = deepen.previewSplit(address(token), 0);
        assertEq(toBuy + forLiquidity, 0);
        (toBuy, forLiquidity) = deepen.previewSplit(address(token), 2);
        assertEq(toBuy, 2, "never more than offered");
        (toBuy, forLiquidity) = deepen.previewSplit(address(token), 50e6);
        assertEq(toBuy + forLiquidity, 50e6);
        assertApproxEqAbs(toBuy, _refRoot(50e6, POOL_USDC, FEE_BPS_TOTAL), 1);
    }

    /// @dev A run spends only the running token's USDC, even when the plugin holds much more for other tokens.
    function test_perTokenIsolation() public {
        (MockLaunchToken other, LaunchPair otherPair) = _launchDeepen();
        _graduate(other, otherPair, POOL_TOKENS, POOL_USDC);
        _collect(token, 100e6);
        _collect(other, 5e6);
        (uint256 spentOther,,) = _runAs(keeper, address(other));
        assertLe(spentOther, 5e6);
        assertEq(deepen.usdcHeld(address(token)), 100e6);
        (uint256 spent,,) = _runAs(keeper, address(token));
        assertEq(spent, DEFAULT_CAP);
        assertEq(
            usdc.balanceOf(address(deepen)), deepen.usdcHeld(address(token)) + deepen.usdcHeld(address(other))
        );
        assertEq(pair.totalSupply(), 0, "the curve token's pool was never touched");
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function testFuzz_run_onCurve(uint64 heldRaw, uint64 virtualUsdcRaw, uint64 sellOutRaw) public {
        uint256 held = bound(heldRaw, 3, 1e13);
        uint256 virtualUsdc = bound(virtualUsdcRaw, VIRTUAL_USDC_0_MOCK, 1e14);
        uint256 sellOut = bound(sellOutRaw, 1, 2e13);
        launchpad.setVirtualUsdc(address(token), virtualUsdc);
        launchpad.setSellOutCost(address(token), sellOut);
        _collect(token, held);
        uint256 cap = (virtualUsdc * 25) / 10_000;
        uint256 offer = held < cap ? held : cap;
        uint256 expectedSpend = offer < sellOut ? offer : sellOut;
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertEq(spent, expectedSpend);
        assertEq(burned, spent * TOKENS_PER_UNIT);
        assertEq(liquidity, 0);
        assertEq(deepen.usdcHeld(address(token)), held - spent);
        assertEq(usdc.balanceOf(address(deepen)), held - spent);
        assertEq(usdc.allowance(address(deepen), address(launchpad)), 0);
        assertEq(launchpad.isGraduated(address(token)), offer >= sellOut);
        assertEq(token.totalSupply(), 0);
    }

    /// @dev Any pool (reserves from 1,000 to 100M USDC against 1M to 1B tokens, optionally with third-party
    ///      liquidity) and any pot: the offer is min(held, cap), the buy is the documented root (to a unit, raised to
    ///      the minimum), the add takes every token bought, at most 4 units of the offer stay held, the LP goes to
    ///      0x…dEaD exactly, and the plugin keeps nothing.
    function testFuzz_run_inPool(uint64 heldRaw, uint112 reserveUsdcRaw, uint112 reserveTokenRaw, bool thirdPartyLp)
        public
    {
        uint256 ru0 = bound(reserveUsdcRaw, 1e9, 1e14);
        uint256 rt0 = bound(reserveTokenRaw, 1e24, 1e27);
        _graduate(token, pair, rt0, ru0);
        if (thirdPartyLp) {
            token.mint(address(pair), rt0 / 3);
            usdc.mint(address(pair), ru0 / 3);
            pair.mint(alice);
            (rt0, ru0) = _reservesOf(pair);
        }
        uint256 held = bound(heldRaw, 3, 1e13);
        _collect(token, held);
        uint256 cap = ru0 * 25 / 10_000;
        uint256 offer = held < cap ? held : cap;
        vm.assume(offer >= 3);

        (uint256 offered, bool graduated) = deepen.previewRun(address(token));
        assertTrue(graduated);
        assertEq(offered, offer, "previewRun = min(held, cap)");
        (uint256 toBuy,) = deepen.previewSplit(address(token), offer);
        uint256 root = _refRoot(offer, ru0, FEE_BPS_TOTAL);
        if (root >= 4 && root < offer) assertApproxEqAbs(toBuy, root, 1, "the documented root");
        Sim memory s = _simulate(address(token), pair, offer, toBuy, 0);
        uint256 deadBefore = pair.balanceOf(DEAD);
        uint256 aliceLp = pair.balanceOf(alice);

        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertEq(spent, toBuy + s.usdcAdded);
        assertEq(burned, s.burned);
        assertEq(liquidity, s.liquidity);
        assertLe(offer - spent, 4, "at most 4 units stay held");
        (uint256 rt1, uint256 ru1) = _reservesOf(pair);
        // Tokens that did not fit are burned: worth about 2 units at most at the pool's price.
        assertLe(burned * ru1, 2 * rt1 + rt1 / 1e6, "at most ~2 units' worth burned");
        if (offer >= 1_000) {
            assertEq(burned, 0, "beyond dust, every token bought goes back into the pool");
            assertGt(liquidity, 0);
            assertEq(rt1, rt0, "the token reserve is back where it was");
        }
        assertGe(rt1 * ru1, rt0 * ru0, "k never falls");
        assertEq(pair.balanceOf(DEAD), deadBefore + liquidity);
        assertEq(pair.balanceOf(alice), aliceLp, "a third party's LP is untouched");
        assertEq(pair.balanceOf(address(deepen)), 0);
        assertEq(token.balanceOf(address(deepen)), 0);
        assertEq(usdc.allowance(address(deepen), address(poolRouter)), 0);
        assertEq(deepen.usdcHeld(address(token)), held - spent);
        assertEq(usdc.balanceOf(address(deepen)), held - spent);
        assertEq(deepen.totalUsdcSpent(address(token)), spent);
        assertEq(deepen.totalLiquidityLocked(address(token)), liquidity);
    }
}
