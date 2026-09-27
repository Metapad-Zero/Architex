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

    /// @dev Empty data is valid here (the default burn share), which is what the conformance suite passes around.
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
        (token, pair) = _launchDeepen(); // the default burn share
    }

    // ─── Configuration ────────────────────────────────────────────────────────

    function test_onLaunch_emptyDataMeansTheDefaultBurnShare() public view {
        assertEq(deepen.DEFAULT_BURN_BPS(), 5_000);
        assertEq(deepen.burnBpsOf(address(token)), 5_000);
        assertTrue(deepen.isConfigured(address(token)));
    }

    function test_onLaunch_takesTheCreatorsBurnShare() public {
        uint16[4] memory shares = [uint16(0), 2_500, 7_500, 10_000];
        for (uint256 i; i < shares.length; ++i) {
            MockLaunchToken t = _newToken();
            vm.expectEmit(true, false, false, true, address(deepen));
            emit IDeepenPoolPlugin.BurnShareSet(address(t), shares[i]);
            launchpad.launch(address(t), creator, address(deepen), address(0), abi.encode(shares[i]));
            assertEq(deepen.burnBpsOf(address(t)), shares[i]);
        }
    }

    function test_onLaunch_rejectsABurnShareAboveTotal() public {
        MockLaunchToken t = _newToken();
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.InvalidBurnBps.selector, 10_001));
        launchpad.launch(address(t), creator, address(deepen), address(0), abi.encode(uint16(10_001)));
        assertFalse(deepen.isConfigured(address(t)));
    }

    function test_onLaunch_rejectsNonCanonicalData() public {
        MockLaunchToken t = _newToken();
        vm.expectRevert(ILaunchFeePlugin.NonCanonicalData.selector);
        launchpad.launch(address(t), creator, address(deepen), address(0), abi.encodePacked(abi.encode(uint16(1)), hex"01"));
        assertFalse(deepen.isConfigured(address(t)));
    }

    function test_burnBpsOf_isZeroForAnUnconfiguredToken() public {
        MockLaunchToken other = _launch(alice, ""); // a token whose fees go to a wallet
        assertEq(deepen.burnBpsOf(address(other)), 0);
        assertFalse(deepen.isConfigured(address(other)));
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

    // ─── Run on the curve (Buyback & burn's, whatever the burn share) ─────────

    function test_run_onCurve_spendsTheCapAndBurnsEverything() public {
        _collect(token, 100e6);
        uint256 bought = DEFAULT_CAP * TOKENS_PER_UNIT;
        vm.expectEmit(true, true, false, true, address(deepen));
        emit IDeepenPoolPlugin.DeepenRun(
            address(token), keeper, false, DEFAULT_CAP, DEFAULT_CAP, 0, bought, 0, bought, 0
        );
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
        assertEq(deepen.totalUsdcBurning(address(token)), DEFAULT_CAP, "the whole curve spend buys tokens to burn");
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

    /// @dev Even a token that never burns in its pool burns on the curve: there is nothing to add to yet.
    function test_run_onCurve_burnsEvenWithNoBurnShare() public {
        (MockLaunchToken t,) = _launchDeepen(uint16(0));
        _collect(t, 100e6);
        (uint256 offered, uint256 toBurn, uint256 toDeepen, bool graduated) = deepen.previewRun(address(t));
        assertEq(toBurn, offered, "the whole offer buys and burns");
        assertEq(toDeepen, 0);
        assertFalse(graduated);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(t));
        assertEq(spent, offered);
        assertEq(burned, spent * TOKENS_PER_UNIT);
        assertEq(liquidity, 0);
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

    /// @dev After the sell-out run the token is in its pool; the next run, paced from the sell-out run, splits.
    function test_run_sellOutThenTheNextRunSplits() public {
        launchpad.setSellOutCost(address(token), 7e6);
        _collect(token, 1_000e6);
        _runAs(keeper, address(token));
        _graduate(token, pair, POOL_TOKENS, POOL_USDC); // what the launchpad's graduation does

        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.AlreadyRanThisBlock.selector, address(token)));
        _runAs(keeper, address(token));

        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 30 minutes);
        (uint256 offered, uint256 toBurn, uint256 toDeepen, bool graduated) = deepen.previewRun(address(token));
        assertTrue(graduated);
        assertEq(offered, POOL_CAP / 2, "half an hour: half the pool's cap");
        assertEq(toBurn, offered / 2, "and half of that burns");
        assertEq(toDeepen, offered - toBurn);
        uint256 deadBefore = pair.balanceOf(DEAD);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertLe(spent, offered);
        assertLe(offered - spent, 4, "only rounding stays behind");
        assertGt(burned, 0, "the burn side burned");
        assertGt(liquidity, 0, "and the deepen side added");
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

    // ─── Run in the pool: the two sides ───────────────────────────────────────

    /// @dev The default half and half: half the offer buys and burns, the rest buys and goes into the pool with the
    ///      USDC left, the LP minted to 0x…dEaD. The pool's token reserve falls by exactly what was burned out of it;
    ///      its USDC reserve grows by everything spent but the fees; the plugin keeps nothing.
    function test_run_inPool_halfBurnsHalfDeepens() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 1_000e6);
        (uint256 usdcToBurn, uint256 usdcToBuy, uint256 usdcForLiquidity) = deepen.previewSplit(address(token), POOL_CAP);
        assertEq(usdcToBurn, POOL_CAP / 2, "half burns");
        assertEq(usdcToBurn + usdcToBuy + usdcForLiquidity, POOL_CAP, "the three sum to the offer");
        assertGt(usdcToBuy * 2, POOL_CAP / 2, "a little over half of the deepen side buys");
        Sim memory s = _simulateRun(address(token), pair, POOL_CAP, 0);
        uint256 deadBefore = pair.balanceOf(DEAD);
        uint256 supplyBefore = pair.totalSupply();
        (uint256 rt0, uint256 ru0) = _reservesOf(pair);
        uint256 tokenSupplyBefore = token.totalSupply();

        vm.expectEmit(true, true, false, true, address(deepen));
        emit IDeepenPoolPlugin.DeepenRun(
            address(token),
            keeper,
            true,
            s.spent,
            s.usdcToBurn,
            s.usdcAdded,
            s.tokensBought,
            s.tokensAdded,
            s.burned,
            s.liquidity
        );
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));

        assertEq(spent, s.spent);
        assertEq(burned, s.burned);
        assertGt(burned, 0);
        assertEq(liquidity, s.liquidity);
        assertGt(liquidity, 0);
        assertLe(POOL_CAP - spent, 4, "at most 4 units stay for the next run");
        assertEq(poolRouter.buyCalls(), 2, "one buy per side");
        assertEq(poolRouter.lastMinOut(), 0, "no slippage bound, by design");
        assertEq(poolRouter.lastTo(), address(deepen));
        assertEq(launchpad.buyCalls(), 0, "never the curve after graduation");
        assertEq(token.totalSupply(), tokenSupplyBefore - burned, "a true burn");

        (uint256 rt1, uint256 ru1) = _reservesOf(pair);
        assertEq(rt1, s.reserveToken, "the pool's token side");
        assertEq(ru1, s.reserveUsdc, "the pool's USDC side");
        assertLt(rt1, rt0, "the burn side took tokens out of the pool");
        assertGt(ru1, ru0);
        assertGt(rt1 * ru1, rt0 * ru0, "k grows");
        assertEq(pair.balanceOf(DEAD), deadBefore + liquidity, "the LP went to the burn address");
        assertEq(pair.totalSupply(), supplyBefore + liquidity);
        assertEq(pair.balanceOf(address(deepen)), 0, "no LP kept");
        assertEq(token.balanceOf(address(deepen)), 0, "no token kept");
        assertEq(usdc.allowance(address(deepen), address(poolRouter)), 0);
        assertEq(usdc.balanceOf(address(pair)), ru1, "nothing left for anyone to skim");

        assertEq(deepen.usdcHeld(address(token)), 1_000e6 - spent);
        assertEq(deepen.totalUsdcSpent(address(token)), spent);
        assertEq(deepen.totalUsdcBurning(address(token)), s.usdcToBurn);
        assertEq(deepen.totalUsdcAdded(address(token)), s.usdcAdded);
        assertEq(deepen.totalTokensAdded(address(token)), s.tokensAdded);
        assertEq(deepen.totalLiquidityLocked(address(token)), liquidity);
        assertEq(deepen.totalTokensBurned(address(token)), burned);
    }

    /// @dev burnBps = 0: nothing is burned in the pool, every token bought goes back in, so the token reserve ends
    ///      where it was.
    function test_run_inPool_pureDeepenAddsEverythingItBuys() public {
        (MockLaunchToken t, LaunchPair p) = _launchDeepen(uint16(0));
        _graduate(t, p, POOL_TOKENS, POOL_USDC);
        _collect(t, 1_000e6);
        (uint256 usdcToBurn,,) = deepen.previewSplit(address(t), POOL_CAP);
        assertEq(usdcToBurn, 0);
        (uint256 rt0,) = _reservesOf(p);
        Sim memory s = _simulateRun(address(t), p, POOL_CAP, 0);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(t));
        assertEq(burned, 0, "nothing burned");
        assertEq(spent, s.spent);
        assertEq(liquidity, s.liquidity);
        assertGt(liquidity, 0);
        (uint256 rt1,) = _reservesOf(p);
        assertEq(rt1, rt0, "the token reserve is back where it was");
        assertEq(poolRouter.buyCalls(), 1, "one buy: the deepen side only");
        assertEq(deepen.totalUsdcBurning(address(t)), 0);
    }

    /// @dev burnBps = 10,000: a pure buyback, no add at all, and the LP supply never moves.
    function test_run_inPool_pureBurnNeverAdds() public {
        (MockLaunchToken t, LaunchPair p) = _launchDeepen(uint16(10_000));
        _graduate(t, p, POOL_TOKENS, POOL_USDC);
        _collect(t, 1_000e6);
        (uint256 usdcToBurn, uint256 usdcToBuy, uint256 usdcForLiquidity) = deepen.previewSplit(address(t), POOL_CAP);
        assertEq(usdcToBurn, POOL_CAP);
        assertEq(usdcToBuy + usdcForLiquidity, 0);
        uint256 supplyBefore = p.totalSupply();
        (uint256 rt0, uint256 ru0) = _reservesOf(p);
        Sim memory s = _simulateRun(address(t), p, POOL_CAP, 0);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(t));
        assertEq(spent, POOL_CAP, "the whole offer");
        assertEq(burned, s.tokensBought);
        assertEq(liquidity, 0);
        assertEq(p.totalSupply(), supplyBefore, "no LP minted");
        (uint256 rt1, uint256 ru1) = _reservesOf(p);
        assertLt(rt1, rt0);
        assertGt(ru1, ru0);
        assertEq(deepen.totalUsdcBurning(address(t)), POOL_CAP);
        assertEq(deepen.totalUsdcAdded(address(t)), 0);
    }

    /// @dev Every burn share between the two: the sides follow burnBps, and the pool moves accordingly.
    function test_run_inPool_everyBurnShare() public {
        uint16[5] memory shares = [uint16(0), 2_500, 5_000, 7_500, 10_000];
        uint256 heldAcross;
        for (uint256 i; i < shares.length; ++i) {
            (MockLaunchToken t, LaunchPair p) = _launchDeepen(shares[i]);
            _graduate(t, p, POOL_TOKENS, POOL_USDC);
            _collect(t, 1_000e6);
            (uint256 usdcToBurn,,) = deepen.previewSplit(address(t), POOL_CAP);
            assertEq(usdcToBurn, POOL_CAP * shares[i] / 10_000, "the burn side is the configured share");
            Sim memory s = _simulateRun(address(t), p, POOL_CAP, 0);
            (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(t));
            assertEq(spent, s.spent);
            assertEq(burned, s.burned);
            assertEq(liquidity, s.liquidity);
            assertEq(deepen.totalUsdcBurning(address(t)), usdcToBurn);
            assertEq(t.balanceOf(address(deepen)), 0);
            assertEq(p.balanceOf(address(deepen)), 0);
            heldAcross += deepen.usdcHeld(address(t));
            assertEq(usdc.balanceOf(address(deepen)), heldAcross, "one pot per token, all of it in the plugin");
        }
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
        (MockLaunchToken t, LaunchPair p) = _launchDeepen(uint16(0));
        _graduate(t, p, POOL_TOKENS, POOL_USDC);
        _collect(t, 1_000e6);
        (, uint256 usdcToBuy,) = deepen.previewSplit(address(t), POOL_CAP);
        poolRouter.setPullShortfall(1e6);
        (uint256 spent,, uint256 liquidity) = _runAs(keeper, address(t));
        uint256 added = deepen.totalUsdcAdded(address(t));
        assertEq(spent, usdcToBuy - 1e6 + added, "the pull plus the add");
        assertGt(POOL_CAP - spent, 1e6, "the tokens limit the add; the rest stays held");
        assertGt(liquidity, 0);
        assertEq(deepen.usdcHeld(address(t)), 1_000e6 - spent);
        assertEq(usdc.allowance(address(deepen), address(poolRouter)), 0, "the unused allowance is removed");
        assertEq(t.balanceOf(address(deepen)), 0);
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
        launchpad.launch(address(t), creator, address(deepen), address(skewed), abi.encode(uint16(0)));
        t.mint(address(skewed), POOL_TOKENS);
        usdc.mint(address(skewed), POOL_USDC);
        skewed.mint(DEAD);
        launchpad.setGraduated(address(t), true);
        _collect(t, 1_000e6);

        Sim memory s = _simulateRun(address(t), LaunchPair(address(skewed)), POOL_CAP, 0);
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

    // ─── The dust rule ────────────────────────────────────────────────────────

    /// @dev A side that would be under the minimum gives way: the whole offer goes through the other one rather than
    ///      wasting the run. The burn side gives way first, and an offer whose deepen side is dust is all burn.
    function test_run_inPool_aSideTooSmallGivesWayToTheOther() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        // 5 units at 50% would be 2 and 3: the burn side gives way and all 5 deepen.
        _payDirect(address(deepen), address(token), alice, 5);
        (uint256 usdcToBurn, uint256 usdcToBuy, uint256 usdcForLiquidity) = deepen.previewSplit(address(token), 5);
        assertEq(usdcToBurn, 0, "the burn side gave way");
        assertEq(usdcToBuy + usdcForLiquidity, 5);
        (uint256 offered, uint256 toBurn, uint256 toDeepen,) = deepen.previewRun(address(token));
        assertEq(offered, 5);
        assertEq(toBurn, 0);
        assertEq(toDeepen, 5);
        _runAs(keeper, address(token));
        assertEq(poolRouter.buyCalls(), 1);
        assertEq(deepen.totalUsdcBurning(address(token)), 0);

        // A 90% burn share of 5 units leaves 1 unit to deepen: that side gives way instead.
        (MockLaunchToken t, LaunchPair p) = _launchDeepen(uint16(9_000));
        _graduate(t, p, POOL_TOKENS, POOL_USDC);
        _payDirect(address(deepen), address(t), alice, 5);
        (usdcToBurn, usdcToBuy, usdcForLiquidity) = deepen.previewSplit(address(t), 5);
        assertEq(usdcToBurn, 5, "all of it burns");
        assertEq(usdcToBuy + usdcForLiquidity, 0);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(t));
        assertEq(spent, 5);
        assertGt(burned, 0);
        assertEq(liquidity, 0);
        assertEq(deepen.usdcHeld(address(t)), 0, "nothing wasted");
    }

    /// @dev Offers of a few units at every burn share: the run never reverts, the plugin ends with no tokens, and
    ///      what it could not use stays held.
    function test_run_inPool_dustOffersNeverRevert() public {
        uint16[3] memory shares = [uint16(0), 5_000, 10_000];
        for (uint256 i; i < shares.length; ++i) {
            for (uint256 held = 3; held < 12; ++held) {
                uint256 snap = vm.snapshotState();
                (MockLaunchToken t, LaunchPair p) = _launchDeepen(shares[i]);
                _graduate(t, p, POOL_TOKENS, POOL_USDC);
                _payDirect(address(deepen), address(t), alice, held);
                Sim memory s = _simulateRun(address(t), p, held, 0);
                (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(t));
                assertEq(spent, s.spent);
                assertEq(burned, s.burned);
                assertEq(liquidity, s.liquidity);
                assertEq(t.balanceOf(address(deepen)), 0);
                assertEq(deepen.usdcHeld(address(t)), held - spent);
                vm.revertToState(snap);
            }
        }
    }

    // ─── Strays and donations ─────────────────────────────────────────────────

    /// @dev Tokens sent to the plugin are burned by the next run: only the deepen side's own tokens go into the pool.
    function test_run_inPool_strayTokensAreBurned() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 1_000e6);
        token.mint(address(deepen), 1_000_000e18);
        Sim memory s = _simulateRun(address(token), pair, POOL_CAP, 1_000_000e18);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertEq(spent, s.spent);
        assertEq(burned, s.burned);
        assertEq(burned, s.tokensBought + 1_000_000e18 - s.tokensAdded, "every token added or burned");
        assertEq(liquidity, s.liquidity);
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

    /// @dev USDC or tokens donated to the pair before a run (not synced) are folded into the reserves by the run's own
    ///      sync, so the split is computed on the pool the buys will trade against and nothing is left to skim.
    function test_run_inPool_aDonationBeforeTheRunIsAbsorbedNotSkimmable() public {
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _collect(token, 1_000e6);
        usdc.mint(address(pair), 5e6);
        token.mint(address(pair), 1_000e18);
        uint256 deadBefore = pair.balanceOf(DEAD);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(token));
        assertGt(liquidity, 0);
        assertGt(burned, 0);
        assertLe(POOL_CAP - spent, 4, "the sync keeps the split honest");
        assertEq(pair.balanceOf(DEAD), deadBefore + liquidity);
        (uint256 rt, uint256 ru) = _reservesOf(pair);
        assertEq(usdc.balanceOf(address(pair)), ru);
        assertEq(token.balanceOf(address(pair)), rt);
        assertEq(token.balanceOf(address(deepen)), 0);
        pair.skim(attacker);
        assertEq(usdc.balanceOf(attacker) + token.balanceOf(attacker), 0, "nothing to skim");
    }

    // ─── Once per block, per token ────────────────────────────────────────────

    function test_run_atMostOncePerTokenPerBlock() public {
        _collect(token, 100e6);
        _runAs(keeper, address(token));
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.AlreadyRanThisBlock.selector, address(token)));
        _runAs(keeper, address(token));
        assertEq(_offeredFor(address(token)), 0);
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
        (uint256 offered, uint256 toBurn, uint256 toDeepen, bool graduated) = deepen.previewRun(address(token));
        assertEq(offered + toBurn + toDeepen, 0);
        assertFalse(graduated);
        _collect(token, 100e6);
        (offered, toBurn, toDeepen, graduated) = deepen.previewRun(address(token));
        assertEq(offered, DEFAULT_CAP);
        assertEq(toBurn, offered, "on the curve the whole offer burns");
        assertEq(toDeepen, 0);
        _graduate(token, pair, POOL_TOKENS, 1_000e6);
        (offered, toBurn, toDeepen, graduated) = deepen.previewRun(address(token));
        assertEq(offered, 2.5e6);
        assertEq(toBurn, 1.25e6);
        assertEq(toDeepen, 1.25e6);
        assertTrue(graduated);
        MockLaunchToken unconfigured = _launch(alice, "");
        (offered,,,) = deepen.previewRun(address(unconfigured));
        assertEq(offered, 0);
    }

    function test_previewSplit() public {
        (uint256 toBurn, uint256 toBuy, uint256 forLiquidity) = deepen.previewSplit(address(token), 50e6);
        assertEq(toBurn, 50e6, "on the curve the whole offer buys and burns");
        assertEq(toBuy + forLiquidity, 0);
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        (toBurn, toBuy, forLiquidity) = deepen.previewSplit(address(token), 0);
        assertEq(toBurn + toBuy + forLiquidity, 0);
        (toBurn, toBuy, forLiquidity) = deepen.previewSplit(address(token), 2);
        assertEq(toBurn, 0, "the burn side gives way");
        assertEq(toBuy, 2, "never more than offered");
        (toBurn, toBuy, forLiquidity) = deepen.previewSplit(address(token), 50e6);
        assertEq(toBurn + toBuy + forLiquidity, 50e6);
        assertEq(toBurn, 25e6);
        // The deepen side splits against the reserve the burn side's buy leaves.
        (, uint256 ru) = _reservesOf(pair);
        (, uint256 net) = _quoteAt(1, ru, 25e6);
        net; // silence the unused warning: only the USDC side matters below
        (uint256 platformFee, uint256 creatorFee) = _fees(25e6);
        assertApproxEqAbs(toBuy, _refRoot(25e6, ru + 25e6 - platformFee - creatorFee, FEE_BPS_TOTAL), 1);
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
        assertEq(usdc.balanceOf(address(deepen)), deepen.usdcHeld(address(token)) + deepen.usdcHeld(address(other)));
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
        assertEq(usdc.allowance(address(deepen), address(launchpad)), 0);
        assertEq(launchpad.isGraduated(address(token)), offer >= sellOut);
        assertEq(token.totalSupply(), 0);
    }

    /// @dev Any pool, any pot and any burn share: the sides follow burnBps and the dust rule, the deepen side buys the
    ///      documented root, its add takes every token it bought beyond dust, at most 4 units of the offer stay held,
    ///      the LP goes to 0x…dEaD exactly, and the plugin keeps nothing.
    function testFuzz_run_inPool(uint64 heldRaw, uint112 reserveUsdcRaw, uint112 reserveTokenRaw, uint16 burnRaw)
        public
    {
        uint16 burnBps = uint16(bound(burnRaw, 0, 10_000));
        (MockLaunchToken t, LaunchPair p) = _launchDeepen(burnBps);
        uint256 ru0 = bound(reserveUsdcRaw, 1e9, 1e14);
        uint256 rt0 = bound(reserveTokenRaw, 1e24, 1e27);
        _graduate(t, p, rt0, ru0);
        uint256 held = bound(heldRaw, 3, 1e13);
        _collect(t, held);
        uint256 cap = ru0 * 25 / 10_000;
        uint256 offer = held < cap ? held : cap;

        (uint256 offered, uint256 toBurn, uint256 toDeepen, bool graduated) = deepen.previewRun(address(t));
        assertTrue(graduated);
        assertEq(offered, offer, "previewRun = min(held, cap)");
        (uint256 refBurn, uint256 refDeepen) = _sidesRef(offer, burnBps);
        assertEq(toBurn, refBurn, "the burn side follows burnBps and the dust rule");
        assertEq(toDeepen, refDeepen);
        (uint256 splitBurn, uint256 splitBuy, uint256 splitAdd) = deepen.previewSplit(address(t), offer);
        assertEq(splitBurn + splitBuy + splitAdd, offer, "the split covers the offer");
        assertEq(splitBurn, refBurn);

        Sim memory s = _simulate(p, offer, splitBurn, splitBuy, 0);
        uint256 deadBefore = p.balanceOf(DEAD);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runAs(keeper, address(t));

        assertEq(spent, s.spent);
        assertEq(burned, s.burned);
        assertEq(liquidity, s.liquidity);
        assertLe(offer - spent, 4, "at most 4 units stay held");
        (uint256 rt1, uint256 ru1) = _reservesOf(p);
        assertEq(rt1, s.reserveToken);
        assertEq(ru1, s.reserveUsdc);
        assertGe(rt1 * ru1, rt0 * ru0, "k never falls");
        assertEq(p.balanceOf(DEAD), deadBefore + liquidity);
        assertEq(p.balanceOf(address(deepen)), 0);
        assertEq(t.balanceOf(address(deepen)), 0);
        assertEq(usdc.allowance(address(deepen), address(poolRouter)), 0);
        assertEq(deepen.usdcHeld(address(t)), held - spent);
        assertEq(deepen.totalUsdcSpent(address(t)), spent);
        assertEq(deepen.totalUsdcBurning(address(t)), splitBurn);
        assertEq(deepen.totalLiquidityLocked(address(t)), liquidity);
        if (refDeepen >= 1_000) {
            assertEq(liquidity > 0, true, "beyond dust the deepen side always adds");
            assertEq(burned, s.tokensBought - s.tokensAdded);
        }
    }
}
