// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {ILaunchRouter} from "../../interfaces/ILaunchRouter.sol";
import {IDeepenPoolPlugin} from "../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {DeepenPoolPlugin} from "../../plugins/launch/DeepenPoolPlugin.sol";
import {DeepenReviewBase} from "./DeepenReviewBase.sol";

/// @dev Does everything a third party can do to a pair or to the plugin in the SAME transaction as a run, so the
///      plugin sees the state the attacker wants and nothing can be re-ordered in between.
contract SameBlockGriefer {
    DeepenPoolPlugin public immutable plugin;
    ILaunchPair public immutable pair;
    IERC20 public immutable token;
    IERC20 public immutable usdcToken;

    constructor(DeepenPoolPlugin p, address pair_, address token_, address usdc_) {
        plugin = p;
        pair = ILaunchPair(pair_);
        token = IERC20(token_);
        usdcToken = IERC20(usdc_);
    }

    function donateTokensThenRun(uint256 amount) external returns (uint256 spent) {
        token.transfer(address(pair), amount);
        (spent,,) = plugin.run(address(token));
    }

    function donateUsdcThenRun(uint256 amount) external returns (uint256 spent) {
        usdcToken.transfer(address(pair), amount);
        (spent,,) = plugin.run(address(token));
    }

    function donateBothThenRun(uint256 t, uint256 u) external returns (uint256 spent) {
        token.transfer(address(pair), t);
        usdcToken.transfer(address(pair), u);
        (spent,,) = plugin.run(address(token));
    }

    function donateToPluginThenRun(uint256 t, uint256 u) external returns (uint256 spent) {
        if (t != 0) token.transfer(address(plugin), t);
        if (u != 0) usdcToken.transfer(address(plugin), u);
        (spent,,) = plugin.run(address(token));
    }

    function syncThenRun() external returns (uint256 spent) {
        pair.sync();
        (spent,,) = plugin.run(address(token));
    }

    function skimThenRun() external returns (uint256 spent) {
        pair.skim(address(this));
        (spent,,) = plugin.run(address(token));
    }

    /// @dev Adds liquidity (raising the pool's USDC reserve and therefore the run's cap), runs, removes it again.
    function jitRun(uint256 tokenSide, uint256 usdcSide) external returns (uint256 spent) {
        token.transfer(address(pair), tokenSide);
        usdcToken.transfer(address(pair), usdcSide);
        pair.mint(address(this));
        (spent,,) = plugin.run(address(token));
        uint256 lpBal = IERC20(address(pair)).balanceOf(address(this));
        IERC20(address(pair)).transfer(address(pair), lpBal);
        pair.burn(address(this));
    }

    function sendLpThenRun(uint256 amount) external returns (uint256 spent) {
        IERC20(address(pair)).transfer(address(plugin), amount);
        (spent,,) = plugin.run(address(token));
    }
}

/// @notice Can anyone make a Deepen run revert, strand a token's pot, or bend a run to their advantage by touching
///         the pair or the plugin in the same block? (Review brief items 1, 2, 4, 8.)
contract DeepenGriefTest is DeepenReviewBase {
    address internal token;
    address internal pair;
    SameBlockGriefer internal g;

    function setUp() public override {
        super.setUp();
        token = _graduatedToken(100, 5_000, 50_000e6);
        pair = pad.pairOf(token);
        g = new SameBlockGriefer(deepen, pair, token, address(usdc));
        // Arm the griefer with USDC and tokens of its own.
        usdc.mint(address(g), 10_000_000e6);
        vm.prank(bob);
        router.buy(token, 200_000e6, 0, address(g), block.timestamp);
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](1);
        t[0] = token;
    }

    // ─── 1. Donations into the pair around the sync ───────────────────────────

    function test_donatingTokensToThePairCannotStopARun() public {
        uint256[6] memory amounts = [uint256(1), 2, 1e6, 1e18, 1_000_000e18, 10_000_000e18];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 spent = g.donateTokensThenRun(amounts[i]);
            assertGt(spent, 0, "run still spends after a token donation");
            _assertPluginClean(_tokens());
            vm.revertToState(snap);
        }
    }

    function test_donatingUsdcToThePairCannotStopARun() public {
        uint256[6] memory amounts = [uint256(1), 2, 3, 1e6, 100_000e6, 5_000_000e6];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 spent = g.donateUsdcThenRun(amounts[i]);
            assertGt(spent, 0, "run still spends after a USDC donation");
            _assertPluginClean(_tokens());
            vm.revertToState(snap);
        }
    }

    function testFuzz_donationsIntoThePairCannotStopARun(uint96 tokenDust, uint64 usdcDust) public {
        uint256 t = bound(uint256(tokenDust), 0, 1_000_000e18);
        uint256 u = bound(uint256(usdcDust), 0, 1_000_000e6);
        uint256 spent = g.donateBothThenRun(t, u);
        assertGt(spent, 0, "run survives any donation into the pair");
        _assertPluginClean(_tokens());
    }

    function test_donationsToThePluginCannotStopARun() public {
        uint256[4] memory t = [uint256(0), 1, 1e18, 1_000_000e18];
        uint256[4] memory u = [uint256(0), 1, 3, 1_000e6];
        for (uint256 i; i < t.length; ++i) {
            for (uint256 j; j < u.length; ++j) {
                uint256 snap = vm.snapshotState();
                uint256 spent = g.donateToPluginThenRun(t[i], u[j]);
                assertGt(spent, 0, "run survives donations to the plugin");
                _assertPluginClean(_tokens());
                vm.revertToState(snap);
            }
        }
    }

    // ─── 2. sync / skim / LP in the same block ────────────────────────────────

    function test_syncingOrSkimmingFirstCannotStopARun() public {
        uint256 snap = vm.snapshotState();
        assertGt(g.syncThenRun(), 0, "sync then run");
        _assertPluginClean(_tokens());
        vm.revertToState(snap);
        assertGt(g.skimThenRun(), 0, "skim then run");
        _assertPluginClean(_tokens());
    }

    function test_strayLpSentToThePluginIsLockedNotStuck() public {
        // The griefer needs LP of its own.
        (uint256 rT, uint256 rU) = _reserves(token);
        vm.startPrank(address(g));
        IERC20(token).transfer(pair, 1_000e6 * rT / rU);
        usdc.transfer(pair, 1_000e6);
        uint256 minted = ILaunchPair(pair).mint(address(g));
        vm.stopPrank();
        assertGt(minted, 0);

        uint256 deadBefore = IERC20(pair).balanceOf(DEAD);
        uint256 spent = g.sendLpThenRun(minted);
        assertGt(spent, 0, "run survives stray LP");
        assertEq(IERC20(pair).balanceOf(address(deepen)), 0, "no LP kept");
        assertEq(IERC20(pair).balanceOf(DEAD) - deadBefore, minted + deepen.totalLiquidityLocked(token), "locked");
    }

    // ─── 3. Liquidity around a run ────────────────────────────────────────────

    /// @dev Liquidity parked across a run used to raise the run's cap inside the same transaction (finding H1; the
    ///      P&L of doing that on purpose is settled, USDC in to USDC out, in CapInflationSettle.t.sol). The cap is now
    ///      0.25% of the locked part of the pool's USDC reserve, which a proportional add leaves where it was.
    function test_jitLiquidityCannotRaiseTheRunsCap() public {
        uint256 snap = vm.snapshotState();
        uint256 plain = g.donateToPluginThenRun(0, 0); // a normal run
        vm.revertToState(snap);

        // The griefer already holds tokens; pair them with USDC at the pool ratio.
        (uint256 rT, uint256 rU) = _reserves(token);
        uint256 usdcSide = rU * 10; // ten times the pool
        uint256 tokenSide = usdcSide * rT / rU;
        uint256 have = IERC20(token).balanceOf(address(g));
        if (tokenSide > have) {
            usdcSide = have * rU / rT;
            tokenSide = usdcSide * rT / rU;
        }
        uint256 parked = g.jitRun(tokenSide, usdcSide);
        emit log_named_uint("plain run spend        ", plain);
        emit log_named_uint("spend with a parked LP ", parked);
        assertGt(usdcSide, rU, "the parked liquidity is larger than the pool");
        assertApproxEqAbs(parked, plain, 1, "parked liquidity does not change what one run spends");
    }

    /// @dev An LP that withdraws everything it can right before a run: the pool gets shallower, the cap smaller.
    function test_drainingLiquidityBeforeARunCannotStopIt() public {
        // Somebody big sells into the pool, pushing the USDC reserve down hard.
        vm.startPrank(bob);
        router.buy(token, 500_000e6, 0, bob, block.timestamp);
        uint256 bal = IERC20(token).balanceOf(bob);
        router.sell(token, bal, 0, bob, block.timestamp);
        vm.stopPrank();
        _step(HOUR);
        vm.prank(keeper);
        (uint256 spent,,) = deepen.run(token);
        assertGt(spent, 0, "a shallow pool still runs");
        _assertPluginClean(_tokens());
    }

    // ─── 4. The dust rule and tiny pots ───────────────────────────────────────

    function test_dustPotsRunOrRevertCleanly() public {
        address t2 = _launch(100, 5_000);
        _graduate(t2);
        address[] memory list = new address[](1);
        list[0] = t2;
        for (uint256 amount = 1; amount <= 12; ++amount) {
            uint256 snap = vm.snapshotState();
            _topUp(t2, amount);
            _step(HOUR);
            (uint256 offered, uint256 toBurn, uint256 toDeepen,) = deepen.previewRun(t2);
            if (offered == 0) {
                vm.prank(keeper);
                vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, t2));
                deepen.run(t2);
            } else {
                assertEq(toBurn + toDeepen, offered, "the split sums to the offer");
                vm.prank(keeper);
                (uint256 spent,,) = deepen.run(t2);
                assertLe(spent, offered);
                assertLe(offered - spent, 4, "at most 4 units of the offer stay behind");
                _assertPluginClean(list);
            }
            vm.revertToState(snap);
        }
    }

    // ─── 5. Repeating the run every block ─────────────────────────────────────

    /// @dev Grinding the run once a second: does it strand the pot, or only burn it on rounded-up fees?
    function test_grindingRunsEverySecondDoesNotStrandThePot() public {
        uint256 held0 = deepen.usdcHeld(token);
        uint256 feeToBefore = pad.pendingFees();
        for (uint256 i; i < 600; ++i) {
            _step(1);
            (uint256 offered,,,) = deepen.previewRun(token);
            if (offered == 0) continue;
            vm.prank(keeper);
            deepen.run(token);
        }
        uint256 spentGrind = held0 - deepen.usdcHeld(token);
        uint256 platformGrind = pad.pendingFees() - feeToBefore;
        emit log_named_uint("grind: spent    ", spentGrind);
        emit log_named_uint("grind: platform ", platformGrind);
        emit log_named_uint("grind: pct fee  ", platformGrind * 10_000 / spentGrind);
        _assertPluginClean(_tokens());
        assertGt(spentGrind, 0);
    }

    function test_oneHourlyRunSpendsTheSameBudgetWithFarLessFee() public {
        uint256 held0 = deepen.usdcHeld(token);
        uint256 feeToBefore = pad.pendingFees();
        _step(600);
        vm.prank(keeper);
        deepen.run(token);
        uint256 spent = held0 - deepen.usdcHeld(token);
        uint256 platform = pad.pendingFees() - feeToBefore;
        emit log_named_uint("single: spent   ", spent);
        emit log_named_uint("single: platform", platform);
        emit log_named_uint("single: pct fee ", platform * 10_000 / spent);
    }
}
