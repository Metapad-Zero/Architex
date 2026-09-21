// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBuybackBurnPlugin} from "../../../interfaces/plugins/IBuybackBurnPlugin.sol";
import {BuybackBurnPlugin} from "../../../plugins/launch/BuybackBurnPlugin.sol";
import {MockLaunchToken} from "./LaunchPluginMocks.sol";
import {LaunchPluginTestBase} from "./LaunchPluginTestBase.sol";

/// @notice Buyback & burn pacing (V13-SPEC §2.2), against the mock launchpad: a run offers
///         min(held, cap * min(now - lastRunAt, RUN_INTERVAL) / RUN_INTERVAL), rounded down, and a full cap for a
///         token's first run; still at most one run per token per block. The economics against the real curve and
///         pool are in BuybackBurnFrontRun.t.sol.
contract BuybackBurnPacingTest is LaunchPluginTestBase {
    uint256 internal constant HOUR = 3600;
    /// @dev A reserve whose cap is a round 100 USDC. The mock's buy raises the curve's virtual USDC by what it
    ///      spends, so the helpers put it back after each run to keep the cap fixed.
    uint256 internal constant RESERVE = 40_000e6;
    uint256 internal constant CAP = 100e6;
    uint256 internal constant START = 1_700_000_000;

    BuybackBurnPlugin internal buyback;
    MockLaunchToken internal token;

    function setUp() public override {
        super.setUp();
        buyback = new BuybackBurnPlugin(address(launchpad));
        token = _launch(address(buyback), "");
        vm.warp(START);
        launchpad.setVirtualUsdc(address(token), RESERVE);
    }

    function _run(MockLaunchToken t) internal returns (uint256 spent) {
        vm.prank(keeper);
        (spent,) = buyback.run(address(t));
        launchpad.setVirtualUsdc(address(t), RESERVE);
    }

    /// @dev The next block, `secs` seconds later.
    function _after(uint256 secs) internal {
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + secs);
    }

    function _offered(MockLaunchToken t) internal view returns (uint256 offered) {
        (offered,) = buyback.previewRun(address(t));
    }

    // ─── The budget ───────────────────────────────────────────────────────────

    function test_views() public {
        assertEq(buyback.RUN_INTERVAL(), 1 hours);
        assertEq(buyback.CAP_BPS(), 25);
        assertEq(buyback.lastRunAt(address(token)), 0, "never ran");
        _collect(token, 1_000e6);
        _run(token);
        assertEq(buyback.lastRunAt(address(token)), START);
        assertEq(buyback.nextRunBlock(address(token)), vm.getBlockNumber() + 1, "the block rule stays");
        _after(600);
        _run(token);
        assertEq(buyback.lastRunAt(address(token)), START + 600);
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
        (uint256 first,) = buyback.run(address(token));
        assertEq(first, 20_833_333);
        launchpad.setVirtualUsdc(address(token), 8_333_333_333);
        _after(1800);
        assertEq(_offered(token), 10_416_666, "20,833,333 / 2 = 10,416,666.5");
        vm.prank(keeper);
        (uint256 second,) = buyback.run(address(token));
        assertEq(second, 10_416_666);
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

    /// @dev The block rule is independent of the clock: a second run in the same block reverts even if time moved.
    function test_sameBlockSecondRunReverts() public {
        _collect(token, 1_000e6);
        _run(token);
        vm.warp(vm.getBlockTimestamp() + 2 hours); // same block
        assertEq(_offered(token), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.AlreadyRanThisBlock.selector, address(token)));
        buyback.run(address(token));
    }

    /// @dev Arc makes several blocks a second and timestamps are whole seconds: a run in a later block of the same
    ///      second has a zero budget.
    function test_nextBlockInTheSameSecondHasNothingToBuy() public {
        _collect(token, 1_000e6);
        _run(token);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(_offered(token), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, address(token)));
        buyback.run(address(token));
        assertEq(buyback.lastRunAt(address(token)), START);
        assertEq(buyback.usdcHeld(address(token)), 1_000e6 - CAP);
    }

    /// @dev A run that reverts spends none of the budget: the pacing state is only written by a run that succeeds.
    function test_aRevertedRunLeavesThePacingUntouched() public {
        _collect(token, 1_000e6);
        launchpad.setWithholdTokens(true);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingBought.selector, address(token)));
        buyback.run(address(token));
        assertEq(buyback.lastRunAt(address(token)), 0);
        assertEq(buyback.nextRunBlock(address(token)), 0);

        launchpad.setWithholdTokens(false);
        assertEq(_run(token), CAP, "still a full cap, in the same block");
    }

    function test_eachTokenHasItsOwnClock() public {
        MockLaunchToken other = _launch(address(buyback), "");
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

    // ─── Sell-out and the pool ────────────────────────────────────────────────

    /// @dev The curve's sell-out buy takes less than offered and graduates the token; the run still counts, and the
    ///      first run in the pool is prorated from it against the pool's reserve.
    function test_sellOutRunThenPoolRunsArePacedFromIt() public {
        launchpad.setSellOutCost(address(token), 7e6);
        _collect(token, 100e6);
        assertEq(_run(token), 7e6, "the sell-out took less than the cap it was offered");
        assertEq(launchpad.lastBuyUsdcIn(), CAP);
        assertTrue(launchpad.isGraduated(address(token)));
        assertEq(buyback.lastRunAt(address(token)), START);

        _pairOf(token).setReserves(200_000_000e18, uint112(RESERVE)); // pool cap 100e6
        _after(1800);
        (uint256 offered, bool graduated) = buyback.previewRun(address(token));
        assertTrue(graduated);
        assertEq(offered, 50e6);
        vm.prank(keeper);
        (uint256 spent,) = buyback.run(address(token));
        assertEq(spent, 50e6);
        assertEq(router.lastUsdcIn(), 50e6, "through the router");

        _pairOf(token).setReserves(200_000_000e18, uint112(RESERVE));
        _after(1 hours);
        vm.prank(keeper);
        (spent,) = buyback.run(address(token));
        assertEq(spent, 43e6, "the rest of the pile, under a full cap");
        assertEq(buyback.usdcHeld(address(token)), 0);
        assertEq(buyback.totalUsdcSpent(address(token)), 100e6);
        assertEq(token.totalSupply(), 0, "everything bought was burned");
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev previewRun is exactly what run offers, on the curve or in the pool, and both follow the budget formula,
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
            launchpad.setGraduated(address(token), true);
            _pairOf(token).setReserves(200_000_000e18, uint112(reserve));
        } else {
            launchpad.setVirtualUsdc(address(token), reserve);
        }
        _collect(token, held);

        for (uint256 i; i < gaps.length; ++i) {
            if (i != 0) _after(bound(gaps[i], 0, 2 hours));
            uint256 last = buyback.lastRunAt(address(token));
            uint256 cap = (_reserve(inThePool) * 25) / 10_000;
            uint256 budget = last == 0 || vm.getBlockTimestamp() - last >= HOUR
                ? cap
                : (cap * (vm.getBlockTimestamp() - last)) / HOUR;
            uint256 heldNow = buyback.usdcHeld(address(token));
            uint256 expected = heldNow < budget ? heldNow : budget;
            if (expected < 3) expected = 0; // MIN_RUN_USDC

            (uint256 offered, bool graduated) = buyback.previewRun(address(token));
            assertEq(graduated, inThePool);
            assertEq(offered, expected, "preview follows the budget");
            vm.prank(keeper);
            if (offered == 0) {
                vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, address(token)));
                buyback.run(address(token));
                continue;
            }
            (uint256 spent,) = buyback.run(address(token));
            assertEq(inThePool ? router.lastUsdcIn() : launchpad.lastBuyUsdcIn(), offered, "run offered the preview");
            assertEq(spent, offered);
            assertEq(buyback.lastRunAt(address(token)), vm.getBlockTimestamp());
        }
    }

    /// @dev Random deliveries and runs at random times: the ledger always balances, every bought token is burned,
    ///      and spending keeps pace: one cap at once, then at most a cap per hour between the first and last run.
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
                else _payDirect(address(buyback), address(token), alice, amount);
                credited += amount;
            }
            _after((r >> 64) % 2 hours);

            (uint256 offered,) = buyback.previewRun(address(token));
            if (offered == 0) {
                vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, address(token)));
                buyback.run(address(token));
                continue;
            }
            uint256 heldBefore = buyback.usdcHeld(address(token));
            uint256 spent = _run(token);
            assertEq(spent, offered);
            assertLe(spent, heldBefore);
            assertLe(spent, CAP);
            if (firstRun == 0) firstRun = vm.getBlockTimestamp();
            lastRun = vm.getBlockTimestamp();
            spentTotal += spent;
        }

        assertEq(buyback.usdcHeld(address(token)) + buyback.totalUsdcSpent(address(token)), credited);
        assertEq(buyback.totalUsdcSpent(address(token)), spentTotal);
        assertEq(usdc.balanceOf(address(buyback)), buyback.usdcHeld(address(token)));
        assertEq(buyback.totalTokensBurned(address(token)), token.totalBurned());
        assertEq(token.balanceOf(address(buyback)), 0);
        assertEq(usdc.allowance(address(buyback), address(launchpad)), 0);
        assertLe(spentTotal * HOUR, CAP * HOUR + CAP * (lastRun - firstRun), "one cap, then a cap per hour");
    }

    function _reserve(bool inThePool) internal view returns (uint256) {
        if (!inThePool) return launchpad.virtualUsdcOf(address(token));
        (, uint112 reserveUsdc,) = _pairOf(token).getReserves();
        return reserveUsdc;
    }
}
