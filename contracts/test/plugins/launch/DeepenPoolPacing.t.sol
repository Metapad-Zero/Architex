// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LaunchPair} from "../../../launchpad/LaunchPair.sol";
import {IDeepenPoolPlugin} from "../../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {MockLaunchToken} from "./LaunchPluginMocks.sol";
import {DeepenPoolTestBase} from "./DeepenPoolTestBase.sol";

/// @notice Deepen pool's pacing, which is Buyback & burn's (V13-SPEC §2.2, §2.3): a run offers
///         min(held, cap * min(now - lastRunAt, RUN_INTERVAL) / RUN_INTERVAL), rounded down, a full cap for a token's
///         first run, and at most one run per token per block. The cap is 0.25% of the curve's virtual USDC before
///         graduation and of the pool's USDC reserve after. The economics against the real curve and pool are in
///         DeepenPoolFrontRun.t.sol.
contract DeepenPoolPacingTest is DeepenPoolTestBase {
    uint256 internal constant HOUR = 3600;
    /// @dev A curve reserve whose cap is a round 100 USDC. The mock's buy raises the curve's virtual USDC by what it
    ///      spends, so the helpers put it back after each run to keep the cap fixed.
    uint256 internal constant RESERVE = 40_000e6;
    uint256 internal constant CAP = 100e6;
    uint256 internal constant START = 1_700_000_000;

    MockLaunchToken internal token;
    LaunchPair internal pair;

    function setUp() public override {
        super.setUp();
        (token, pair) = _launchDeepen();
        vm.warp(START);
        launchpad.setVirtualUsdc(address(token), RESERVE);
    }

    function _run(MockLaunchToken t) internal returns (uint256 spent) {
        vm.prank(keeper);
        (spent,,) = deepen.run(address(t));
        launchpad.setVirtualUsdc(address(t), RESERVE);
    }

    /// @dev The next block, `secs` seconds later.
    function _after(uint256 secs) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function _offered(MockLaunchToken t) internal view returns (uint256 offered) {
        (offered,,,) = deepen.previewRun(address(t));
    }

    // ─── The budget ───────────────────────────────────────────────────────────

    function test_views() public {
        assertEq(deepen.RUN_INTERVAL(), 1 hours);
        assertEq(deepen.CAP_BPS(), 25);
        assertEq(deepen.lastRunAt(address(token)), 0, "never ran");
        _collect(token, 1_000e6);
        _run(token);
        assertEq(deepen.lastRunAt(address(token)), START);
        assertEq(deepen.nextRunBlock(address(token)), vm.getBlockNumber() + 1, "the block rule stays");
        _after(600);
        _run(token);
        assertEq(deepen.lastRunAt(address(token)), START + 600);
    }

    function test_firstRunGetsAFullCap() public {
        _collect(token, 1_000e6);
        assertEq(_offered(token), CAP);
        assertEq(_run(token), CAP);
        assertEq(launchpad.lastBuyUsdcIn(), CAP);
    }

    /// @dev cap * elapsed / 1 h, rounded down, for every elapsed below an hour.
    function test_prorationIsExactAndRoundsDown() public {
        _collect(token, 10_000e6);
        _run(token);
        _after(1800);
        assertEq(_run(token), 50e6, "half an hour: half a cap");
        _after(1);
        assertEq(_run(token), 27_777, "one second: 100e6 / 3600 = 27,777.7");
        _after(1799);
        assertEq(_run(token), 49_972_222, "100e6 * 1799 / 3600 = 49,972,222.2");
        _after(3599);
        assertEq(_run(token), 99_972_222, "a second short of an hour");
        _after(3600);
        assertEq(_run(token), CAP, "an hour: the full cap");
    }

    function test_halfAnHourOfAnOddCapRoundsDown() public {
        launchpad.setVirtualUsdc(address(token), 8_333_333_333); // cap 20,833,333
        _collect(token, 1_000e6);
        vm.prank(keeper);
        (uint256 first,,) = deepen.run(address(token));
        assertEq(first, 20_833_333);
        launchpad.setVirtualUsdc(address(token), 8_333_333_333);
        _after(1800);
        assertEq(_offered(token), 10_416_666, "20,833,333 / 2 = 10,416,666.5");
    }

    /// @dev Idle time does not accumulate: after any idle stretch of an hour or more, one full cap and no more.
    function test_afterAnHourOrMoreTheRunGetsOneCapAndNoMore() public {
        _collect(token, 10_000e6);
        _run(token);
        _after(1 hours);
        assertEq(_run(token), CAP);
        _after(30 days);
        assertEq(_offered(token), CAP);
        assertEq(_run(token), CAP);
        _after(1);
        assertEq(_run(token), 27_777, "and the clock restarted at the last run");
    }

    /// @dev A run spends what is held when that is below the budget, and the clock restarts all the same.
    function test_runBelowTheBudgetSpendsHeldAndRestartsTheClock() public {
        _collect(token, 5e6);
        assertEq(_run(token), 5e6);
        _collect(token, 1_000e6);
        _after(900);
        assertEq(_run(token), 25e6, "a quarter of an hour since the small run");
    }

    // ─── Blocks and seconds ───────────────────────────────────────────────────

    function test_sameBlockSecondRunReverts() public {
        _collect(token, 1_000e6);
        _run(token);
        vm.warp(vm.getBlockTimestamp() + 2 hours); // same block
        assertEq(_offered(token), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.AlreadyRanThisBlock.selector, address(token)));
        deepen.run(address(token));
    }

    /// @dev Arc makes several blocks a second and timestamps are whole seconds: a run in a later block of the same
    ///      second has a zero budget.
    function test_nextBlockInTheSameSecondHasNothingToBuy() public {
        _collect(token, 1_000e6);
        _run(token);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_offered(token), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, address(token)));
        deepen.run(address(token));
        assertEq(deepen.lastRunAt(address(token)), START);
        assertEq(deepen.usdcHeld(address(token)), 1_000e6 - CAP);
    }

    /// @dev A run that reverts spends none of the budget: the pacing state is only written by a run that succeeds.
    function test_aRevertedRunLeavesThePacingUntouched() public {
        _collect(token, 1_000e6);
        launchpad.setWithholdTokens(true);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingBought.selector, address(token)));
        deepen.run(address(token));
        assertEq(deepen.lastRunAt(address(token)), 0);
        assertEq(deepen.nextRunBlock(address(token)), 0);
        launchpad.setWithholdTokens(false);
        assertEq(_run(token), CAP, "still a full cap, in the same block");
    }

    function test_eachTokenHasItsOwnClock() public {
        (MockLaunchToken other,) = _launchDeepen();
        launchpad.setVirtualUsdc(address(other), RESERVE);
        _collect(token, 1_000e6);
        _collect(other, 1_000e6);
        _run(token);
        assertEq(_run(other), CAP, "another token's first run, in the same block");
        _after(1800);
        assertEq(_run(token), 50e6);
        _after(1800);
        assertEq(_run(other), CAP, "an hour since its own last run");
        assertEq(_run(token), 50e6);
    }

    // ─── The pool's cap ───────────────────────────────────────────────────────

    /// @dev After graduation the cap follows the pool's USDC reserve, which the runs themselves raise; the clock is
    ///      the same one the curve runs left behind.
    function test_inThePoolTheCapFollowsThePoolsUsdcReserve() public {
        _collect(token, 10_000e6);
        _run(token); // a curve run
        _graduate(token, pair, POOL_TOKENS, POOL_USDC);
        _after(1800);
        (, uint256 reserveUsdc) = _reservesOf(pair);
        assertEq(_offered(token), (reserveUsdc * 25 / 10_000) / 2, "half an hour: half the pool's cap");
        vm.prank(keeper);
        (uint256 spent,,) = deepen.run(address(token));
        assertEq(poolRouter.buyCalls(), 2, "one buy per side of the split");
        (, uint256 grown) = _reservesOf(pair);
        assertGt(grown, reserveUsdc, "the run put USDC into the pool");
        _after(1 hours);
        assertEq(_offered(token), grown * 25 / 10_000, "a full cap of the grown reserve");
        assertLe(spent, 10_000e6);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev previewRun is exactly what a run offers, on the curve or in the pool, and both follow the budget formula,
    ///      recomputed here independently. A zero preview means run reverts NothingToBuy.
    function testFuzz_previewRunIsExactlyWhatRunOffers(
        uint64 heldRaw,
        uint64 reserveRaw,
        uint32[8] memory gaps,
        bool inThePool
    ) public {
        uint256 held = bound(heldRaw, 1, 1e13);
        uint256 reserve = bound(reserveRaw, 8_333_333_333, 1e14);
        if (inThePool) {
            _graduate(token, pair, POOL_TOKENS, reserve);
        } else {
            launchpad.setVirtualUsdc(address(token), reserve);
        }
        _collect(token, held);

        for (uint256 i; i < gaps.length; ++i) {
            if (i != 0) _after(bound(gaps[i], 0, 2 hours));
            uint256 last = deepen.lastRunAt(address(token));
            uint256 cap = (_reserve(inThePool) * 25) / 10_000;
            uint256 budget = last == 0 || vm.getBlockTimestamp() - last >= HOUR
                ? cap
                : (cap * (vm.getBlockTimestamp() - last)) / HOUR;
            uint256 heldNow = deepen.usdcHeld(address(token));
            uint256 expected = heldNow < budget ? heldNow : budget;
            if (expected < 3) expected = 0; // MIN_RUN_USDC

            (uint256 offered, uint256 toBurn, uint256 toDeepen, bool graduated) = deepen.previewRun(address(token));
            assertEq(graduated, inThePool);
            assertEq(offered, expected, "preview follows the budget");
            assertEq(toBurn + toDeepen, offered, "and the two sides cover it");
            vm.prank(keeper);
            if (offered == 0) {
                vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, address(token)));
                deepen.run(address(token));
                continue;
            }
            uint256 buysBefore = poolRouter.buyCalls();
            (uint256 splitBurn, uint256 splitBuy,) = deepen.previewSplit(address(token), offered);
            uint256 expectedBuys = (splitBurn == 0 ? 0 : 1) + (splitBuy == 0 ? 0 : 1);
            (uint256 spent,,) = deepen.run(address(token));
            if (inThePool) {
                assertEq(poolRouter.lastUsdcIn(), splitBuy == 0 ? splitBurn : splitBuy, "the last buy is the split's");
                assertEq(poolRouter.buyCalls() - buysBefore, expectedBuys, "one buy per non-empty side");
            } else {
                assertEq(launchpad.lastBuyUsdcIn(), offered, "the curve run offers the whole budget");
            }
            assertLe(spent, offered, "a run never spends more than it offers");
            assertLe(offered - spent, 4, "and leaves at most rounding behind");
            assertEq(deepen.lastRunAt(address(token)), vm.getBlockTimestamp());
            assertEq(token.balanceOf(address(deepen)), 0, "no token kept");
            assertEq(pair.balanceOf(address(deepen)), 0, "no LP kept");
        }
    }

    /// @dev Random deliveries and runs at random times: the ledger always balances, every token bought is burned or
    ///      added, and spending keeps pace: one cap at once, then at most a cap per hour between the first and last run.
    function testFuzz_ledgerBalancesAndSpendingKeepsPace(uint256 seed) public {
        uint256 credited;
        uint256 spentTotal;
        uint256 firstRun;
        uint256 lastRun;
        for (uint256 i; i < 24; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            if (r % 3 == 0) {
                uint256 amount = (r >> 8) % 300e6;
                if (r % 2 == 0) _collect(token, amount);
                else _payDirect(address(deepen), address(token), alice, amount);
                credited += amount;
            }
            _after((r >> 64) % 2 hours);

            (uint256 offered,,,) = deepen.previewRun(address(token));
            if (offered == 0) {
                vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, address(token)));
                deepen.run(address(token));
                continue;
            }
            uint256 heldBefore = deepen.usdcHeld(address(token));
            uint256 spent = _run(token);
            assertLe(spent, offered);
            assertLe(spent, heldBefore);
            assertLe(spent, CAP);
            if (firstRun == 0) firstRun = vm.getBlockTimestamp();
            lastRun = vm.getBlockTimestamp();
            spentTotal += spent;
        }

        assertEq(deepen.usdcHeld(address(token)) + deepen.totalUsdcSpent(address(token)), credited);
        assertEq(deepen.totalUsdcSpent(address(token)), spentTotal);
        assertEq(usdc.balanceOf(address(deepen)), deepen.usdcHeld(address(token)));
        assertEq(deepen.totalTokensBurned(address(token)), token.totalBurned());
        assertEq(token.balanceOf(address(deepen)), 0);
        assertEq(usdc.allowance(address(deepen), address(launchpad)), 0);
        assertLe(spentTotal * HOUR, CAP * HOUR + CAP * (lastRun - firstRun), "one cap, then a cap per hour");
    }

    function _reserve(bool inThePool) internal view returns (uint256) {
        if (!inThePool) return launchpad.virtualUsdcOf(address(token));
        (, uint256 reserveUsdc) = _reservesOf(pair);
        return reserveUsdc;
    }

}
