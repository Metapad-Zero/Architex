// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 4: Buyback & burn against the real launchpad, launch pool and router (V13-SPEC §2.2, [D13], [D14]).
///         Each run (checked by _run) offers min(held, budget), the budget being 0.25% of the USDC-side reserve
///         prorated by the time since the token's last run (a full cap for its first run); it buys on the curve or
///         through the router, pays both fees like any trade, and really burns what it bought. The creator fee of its
///         own trade comes back to the plugin on the next collection; that loop converges to under MIN_RUN_USDC.
contract BuybackBurnE2ETest is E2EBase {
    function test_buyback_onCurve_firstRunSpendsAFullCapAndBurns() public {
        address token = _launch(Kind.Buyback, 1000, 2_000e6);
        _curveBuy(bob, token, 10_000e6);
        _collect(token);
        uint256 held = buyback.usdcHeld(token);
        uint256 cap = pad.virtualUsdcOf(token) * CAP_BPS / BPS;
        assertGt(held, cap, "more waiting than one run may spend");
        assertEq(buyback.lastRunAt(token), 0, "never ran");

        uint256 supply = IERC20(token).totalSupply();
        vm.expectCall(
            address(pad), abi.encodeCall(IArchitexLaunchpadLite.buy, (token, cap, 0, address(buyback), _now()))
        );
        (uint256 spent, uint256 burned) = _run(token);
        assertEq(spent, cap, "a full cap, no slippage bound, the block's own time as deadline");
        assertEq(IERC20(token).totalSupply(), supply - burned);

        // The run's own creator fee (10%, rounded up) is pending and comes back on the next collection.
        assertEq(pad.pendingCreatorFees(token), _divCeil(spent * 1000, BPS));
        uint256 heldBefore = buyback.usdcHeld(token);
        uint256 back = _collect(token);
        assertEq(buyback.usdcHeld(token), heldBefore + back);

        _warp(15 minutes);
        uint256 quarter = (pad.virtualUsdcOf(token) * CAP_BPS / BPS) * 900 / 3600;
        (spent,) = _run(token);
        assertEq(spent, quarter, "15 minutes later: a quarter of the (grown) cap");
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 2);
        _assertSystem();
    }

    /// @dev The budget refills in proportion to the time since the last run, fully after an hour, never beyond one
    ///      cap; a second block in the same second has nothing to buy; another token has its own clock.
    function test_buyback_pacing_onTheRealCurveAndPool() public {
        address a = _launch(Kind.Buyback, 500, 0);
        address b = _launch(Kind.Buyback, 500, 0);
        _curveBuy(bob, a, 8_000e6);
        _curveBuy(bob, b, 8_000e6);
        _donate(address(buyback), a, frank, 5_000e6);
        _donate(address(buyback), b, frank, 5_000e6);

        _run(a); // a full cap
        vm.roll(vm.getBlockNumber() + 1); // the next block, same second
        (uint256 offer,) = buyback.previewRun(a);
        assertEq(offer, 0, "no time has passed: no budget");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, a));
        buyback.run(a);
        _run(b); // b's clock is its own: a full cap

        _warp(15 minutes);
        (uint256 cap, uint256 budget) = _budgetOf(a);
        assertEq(budget, cap * 900 / 3600, "a quarter of an hour: a quarter of a cap");
        _run(a);
        _warp(5 hours);
        (cap, budget) = _budgetOf(a);
        assertEq(budget, cap, "idle time beyond an hour does not accumulate");
        _run(a);

        _graduateVia(carol, a);
        _collect(a);
        _warp(30 minutes);
        (cap, budget) = _budgetOf(a);
        (, uint256 ru) = _reserves(a);
        assertEq(cap, ru * CAP_BPS / BPS, "in the pool the cap follows the pool's USDC reserve");
        assertEq(budget, cap / 2);
        _run(a);
        _assertSystem();
    }

    function test_buyback_onCurve_spendsEverythingHeldBelowTheBudget() public {
        address token = _launch(Kind.Buyback, 100, 0);
        _curveBuy(bob, token, 1_000e6); // 10 USDC of creator fees, below the 20.8 USDC cap
        _collect(token);
        (uint256 spent,) = _run(token);
        assertEq(spent, _divCeil(1_000e6 * 100, BPS));
        assertEq(buyback.usdcHeld(token), 0);
        _warp(RUN_INTERVAL);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, token));
        buyback.run(token);
        _assertSystem();
    }

    function test_buyback_afterGraduation_buysThroughTheRouterAndBurns() public {
        address token = _launch(Kind.Buyback, 700, 0);
        _curveBuy(bob, token, 6_000e6);
        _graduateVia(carol, token);
        _collect(token);
        (uint256 rt, uint256 ru) = _reserves(token);
        uint256 cap = ru * CAP_BPS / BPS;
        assertGt(buyback.usdcHeld(token), cap);

        vm.expectCall(address(router), abi.encodeCall(ILaunchRouter.buy, (token, cap, 0, address(buyback), _now())));
        (uint256 spent, uint256 burned) = _run(token);
        assertEq(spent, cap);
        (uint256 rtAfter, uint256 ruAfter) = _reserves(token);
        assertEq(rt - rtAfter, burned, "the burned tokens came out of the pool");
        assertEq(ruAfter - ru, spent - _divCeil(spent * 50, BPS) - _divCeil(spent * 700, BPS), "only the net went in");
        _collect(token);
        _warp(RUN_INTERVAL);
        _run(token);
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        _assertSystem();
    }

    /// @dev A run whose offer covers the rest of the curve makes the sell-out buy: the launchpad takes only what the
    ///      last tokens cost, graduates the token inside the run, the rest stays held, and the next run, paced from
    ///      this one, buys in the pool (IBuybackBurnPlugin NatSpec).
    function test_buyback_runThatCrossesGraduation() public {
        address token = _launch(Kind.Buyback, 500, 0);
        (,,, uint256 fullCost,) = _expCurveBuy(token, 1e15);
        _curveBuy(bob, token, fullCost - 40e6); // leaves ~40 USDC of curve
        _collect(token);
        uint256 cap = pad.virtualUsdcOf(token) * CAP_BPS / BPS;
        (,,, uint256 sellOutCost, bool graduates) = _expCurveBuy(token, cap);
        assertTrue(graduates, "one capped offer covers the rest of the curve");
        assertLt(sellOutCost, cap);
        uint256 heldBefore = buyback.usdcHeld(token);
        assertGt(heldBefore, cap);
        uint256 remaining = CURVE_SUPPLY - uint256(pad.curves(token).tokensSold);

        (uint256 spent, uint256 burned) = _run(token); // checks the exact fill and the graduation
        assertTrue(pad.isGraduated(token), "graduated inside the run");
        assertEq(spent, sellOutCost, "took only what the last tokens cost");
        assertEq(burned, remaining, "bought the last curve tokens and burned them");
        assertEq(IERC20(token).balanceOf(DEAD), 0, "burned, not parked at the burn address");
        assertEq(buyback.usdcHeld(token), heldBefore - spent, "the rest of the offer stays held");

        (uint256 offered, bool grad) = buyback.previewRun(token);
        assertEq(offered, 0);
        assertTrue(grad);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.AlreadyRanThisBlock.selector, token));
        buyback.run(token);

        _collect(token); // includes the creator fee of the sell-out buy
        _warp(10 minutes);
        _run(token); // now in the pool, a sixth of the pool's cap
        _assertSystem();
    }

    function test_buyback_oncePerTokenPerBlock_otherTokensUnaffected() public {
        address a = _launch(Kind.Buyback, 500, 0);
        address b = _launch(Kind.Buyback, 500, 0);
        _curveBuy(bob, a, 5_000e6);
        _curveBuy(bob, b, 5_000e6);
        _collect(a);
        _collect(b);
        _run(a);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.AlreadyRanThisBlock.selector, a));
        buyback.run(a);
        _run(b); // another token, same block
        assertEq(buyback.usdcHeld(a) + buyback.usdcHeld(b), usdc.balanceOf(address(buyback)), "each token's USDC apart");
        _warp(RUN_INTERVAL);
        _run(a);
        _assertSystem();
    }

    // ─── Dust and convergence ─────────────────────────────────────────────────

    /// @dev Below MIN_RUN_USDC (3 units) previewRun is 0 and run reverts NothingToBuy, at 0% and 10% creator fees,
    ///      on the curve and in the pool; exactly 3 units run, buy at least a token wei and burn it.
    function test_buyback_dustBelowTheMinimum_previewZeroNothingToBuy() public {
        uint16[2] memory fees = [uint16(0), 1000];
        for (uint256 i; i < 2; ++i) {
            for (uint256 venue; venue < 2; ++venue) {
                uint256 snap = vm.snapshotState();
                address token = _launch(Kind.Buyback, fees[i], 0);
                _curveBuy(bob, token, 1_000e6);
                if (venue == 1) _graduateVia(carol, token);
                // Nothing collected: the plugin starts empty and gets one unit at a time.
                assertEq(buyback.usdcHeld(token), 0);
                uint256 offer;
                for (uint256 held; held < MIN_RUN_USDC; ++held) {
                    if (held == 0) {
                        _donate(address(buyback), token, frank, 1);
                        continue;
                    }
                    (offer,) = buyback.previewRun(token);
                    assertEq(offer, 0, "below the minimum: previewRun 0");
                    vm.prank(keeper);
                    vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, token));
                    buyback.run(token);
                    _donate(address(buyback), token, frank, 1);
                }
                assertEq(buyback.usdcHeld(token), MIN_RUN_USDC);
                (uint256 spent, uint256 burned) = _run(token); // the minimum runs
                assertEq(spent, MIN_RUN_USDC);
                assertGt(burned, 0, "and buys at least a token wei");
                _assertSystem();
                vm.revertToState(snap);
            }
        }
    }

    /// @dev The creator fee a run pays flows back to the plugin, which spends it, and so on: each round returns ~10%
    ///      (at a 10% creator fee) of the last, so it converges, on the curve and in the pool, and never loops. A run
    ///      an hour after the last gets a full cap. What remains is under MIN_RUN_USDC: previewRun says 0 and run
    ///      reverts NothingToBuy (never the launchpad's or router's ZeroAmount).
    function test_buyback_creatorFeeLoopConverges_onCurveAndInPool() public {
        address token = _launch(Kind.Buyback, 1000, 0);
        _curveBuy(bob, token, 300e6);
        _collect(token);
        uint256 rounds = _spendDown(token);
        console2.log("hourly rounds to spend down on the curve:", rounds);

        _graduateVia(carol, token); // a ~2,700 USDC creator fee from the sell-out buy
        _collect(token);
        rounds = _spendDown(token);
        console2.log("hourly rounds to spend down in the pool:", rounds);
        _assertSystem();
    }

    /// @dev Hourly runs and collections until only dust is left. Bound: each unit spent returns at most 10% (+1 unit of
    ///      rounding), so at most held0 / 0.9 is ever spent, and every hourly run spends a full cap of at least the
    ///      starting reserve's (the reserve only grows as the buyback buys) until less than that is held.
    function _spendDown(address token) internal returns (uint256 rounds) {
        _warp(RUN_INTERVAL);
        (uint256 cap0,) = _budgetOf(token);
        uint256 maxRounds = buyback.usdcHeld(token) * 10 / (9 * cap0) + 20;
        while (true) {
            (uint256 offer,) = buyback.previewRun(token);
            if (offer == 0) {
                assertLt(buyback.usdcHeld(token), MIN_RUN_USDC, "only dust under the minimum is left");
                vm.prank(keeper);
                vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, token));
                buyback.run(token);
                return rounds;
            }
            _run(token);
            _collect(token);
            ++rounds;
            assertLe(rounds, maxRounds, "converges: no endless loop");
            _warp(RUN_INTERVAL);
        }
    }

    // ─── Sandwiching one run ──────────────────────────────────────────────────

    /// @dev Front-run a single run (a full cap: the token's first) with a buy of any size, back-run with the sell:
    ///      always a loss, at any creator fee. The run's cap is computed after the front-run.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_buyback_sandwichingOneRunLoses_onCurve(uint64 xRaw, uint16 bpsRaw) public {
        uint16 bps = uint16(bound(bpsRaw, 0, 1000));
        address token = _launch(Kind.Buyback, bps, 0);
        _curveBuy(bob, token, 2_000e6);
        _donate(address(buyback), token, frank, 100_000e6);
        uint256 x = bound(xRaw, 1e6, 15_000e6);

        uint256 before = usdc.balanceOf(mallory);
        _curveBuy(mallory, token, x);
        _run(token);
        _curveSell(mallory, token, IERC20(token).balanceOf(mallory));
        assertLt(usdc.balanceOf(mallory), before, "sandwiching one run loses money");
        _assertSystem();
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_buyback_sandwichingOneRunLoses_inPool(uint64 xRaw, uint16 bpsRaw) public {
        uint16 bps = uint16(bound(bpsRaw, 0, 1000));
        address token = _launch(Kind.Buyback, bps, 0);
        _curveBuy(bob, token, 1_000e6);
        _graduateVia(carol, token);
        _collect(token);
        _donate(address(buyback), token, frank, 100_000e6);
        uint256 x = bound(xRaw, 1e6, 500_000e6);

        uint256 before = usdc.balanceOf(mallory);
        _poolBuy(mallory, token, x);
        _run(token);
        _poolSell(mallory, token, IERC20(token).balanceOf(mallory));
        assertLt(usdc.balanceOf(mallory), before, "sandwiching one run loses money");
        _assertSystem();
    }

    // ─── Front-running the paced runs (V13-SPEC §2.2) ─────────────────────────

    /// @dev A token whose buyback holds `pile` (delivered straight to onFees, which anyone may do), with `pre` USDC
    ///      already bought on its curve, graduated first if `inPool`.
    function _frontRunTarget(uint16 c, uint256 pre, uint256 pile, bool inPool) internal returns (address token) {
        token = _launch(Kind.Buyback, c, 0);
        _curveBuy(carol, token, pre);
        if (inPool) {
            _graduateVia(carol, token);
            _collect(token);
        }
        _donate(address(buyback), token, frank, pile);
    }

    /// @dev mallory buys `size`, then runs happen at `gaps` (the first at once), then she sells everything she bought.
    ///      Every run is checked (budget, spend, burn, fees) by _run. Returns her profit or loss in USDC units.
    function _frontRun(address token, uint256 size, uint256[] memory gaps) internal returns (int256 pnl) {
        uint256 before = usdc.balanceOf(mallory);
        uint256 got = _buy(mallory, token, size);
        _run(token);
        for (uint256 i; i < gaps.length; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + gaps[i]);
            (uint256 offer,) = buyback.previewRun(token);
            if (offer != 0) _run(token);
        }
        _sell(mallory, token, got);
        pnl = int256(usdc.balanceOf(mallory)) - int256(before);
        _assertSystem();
    }

    function _gaps(uint256 count, uint256 secs) internal pure returns (uint256[] memory gaps) {
        gaps = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            gaps[i] = secs;
        }
    }

    /// @dev Runs every `every` seconds over `hold` seconds, the last one at exactly `hold`.
    function _over(uint256 hold, uint256 every) internal pure returns (uint256[] memory gaps) {
        uint256 n = (hold + every - 1) / every;
        gaps = _gaps(n, every);
        if (n != 0) gaps[n - 1] = hold - every * (n - 1);
    }

    /// @dev The per-block chain the pacing replaced: buy, run in each of the next 50 blocks (a second apart, the most
    ///      whole-second timestamps allow), sell. It loses at every creator fee, on the curve and in the pool, with
    ///      a pile far larger than the runs can spend.
    function test_buyback_chainingRunsBlockAfterBlockLoses_everyCreatorFee() public {
        uint16[6] memory fees = [uint16(0), 50, 100, 200, 500, 1000];
        uint256[3] memory sizes = [uint256(2_000e6), 8_000e6, 20_000e6];
        for (uint256 i; i < fees.length; ++i) {
            for (uint256 j; j < sizes.length; ++j) {
                for (uint256 venue; venue < 2; ++venue) {
                    if (venue == 0 && sizes[j] > 8_000e6) continue; // stay on the curve
                    uint256 snap = vm.snapshotState();
                    address token = _frontRunTarget(fees[i], 1_700e6, 10_000e6, venue == 1);
                    int256 pnl = _frontRun(token, sizes[j], _gaps(49, 1));
                    assertLt(pnl, 0, "chaining runs block after block loses");
                    assertFalse(venue == 0 && pad.isGraduated(token));
                    vm.revertToState(snap);
                }
            }
        }
    }

    /// @dev V13-SPEC §2.2: the shortest profitable hold is 3.1 h at c = 0.5%, 5.2 h at 1%, 9.4 h at 2%, 23 h at 5%,
    ///      48.6 h at 10%. Holding for 90% of that, with a run every 30 minutes and one just before the sell, loses at
    ///      every size, on the curve and in the pool.
    function test_buyback_holdingUnderTheDocumentedBoundLoses() public {
        uint16[5] memory fees = [uint16(50), 100, 200, 500, 1000];
        uint256[5] memory boundMinutes = [uint256(186), 312, 564, 1380, 2916]; // 3.1 h, 5.2 h, 9.4 h, 23 h, 48.6 h
        uint256[3] memory sizes = [uint256(2_000e6), 8_000e6, 20_000e6];
        for (uint256 i; i < fees.length; ++i) {
            uint256 hold = boundMinutes[i] * 60 * 9 / 10;
            for (uint256 j; j < sizes.length; ++j) {
                for (uint256 venue; venue < 2; ++venue) {
                    if (venue == 0 && sizes[j] > 8_000e6) continue;
                    uint256 snap = vm.snapshotState();
                    address token = _frontRunTarget(fees[i], 1_700e6, 20_000e6, venue == 1);
                    int256 pnl = _frontRun(token, sizes[j], _over(hold, 30 minutes));
                    assertLe(pnl, 0, "no profit under the documented bound");
                    vm.revertToState(snap);
                }
            }
        }
    }

    /// @dev So the losses above are not vacuous: past the bound a trader profits, like any holder of a token whose fees
    ///      buy it back (at 1%, twice the 5.2 h bound).
    function test_buyback_holdingWellPastTheBoundProfits() public {
        address token = _frontRunTarget(100, 1_700e6, 20_000e6, false);
        int256 pnl = _frontRun(token, 2_000e6, _over(2 * 312 minutes, 30 minutes));
        console2.log("PnL holding 10.4 h at a 1% creator fee, 2,000 USDC (USDC units):", pnl);
        assertGt(pnl, 0);
    }
}
