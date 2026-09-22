// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./DeepenE2EBase.sol";

/// @notice Deepen pool against the real launchpad, curve, launch pool and router (V13-SPEC §2.3): runs burn on the
///         curve, add liquidity locked at the burn address in the pool, and leave the plugin holding nothing but the
///         USDC its books say. Every run is checked by _runDeepen; every step ends with whole-system conservation.
contract DeepenPoolE2ETest is DeepenE2EBase {
    // ─── On the curve ─────────────────────────────────────────────────────────

    function test_deepen_onCurve_firstRunSpendsAFullCapAndBurns() public {
        address token = _launchDeepen(1000, 2_000e6);
        _curveBuy(bob, token, 10_000e6);
        _collectDeepen(token);
        uint256 held = deepen.usdcHeld(token);
        uint256 cap = pad.virtualUsdcOf(token) * CAP_BPS / BPS;
        assertGt(held, cap, "more waiting than one run may spend");
        assertEq(deepen.lastRunAt(token), 0, "never ran");

        uint256 supply = IERC20(token).totalSupply();
        vm.expectCall(
            address(pad), abi.encodeCall(IArchitexLaunchpadLite.buy, (token, cap, 0, address(deepen), _now()))
        );
        (uint256 spent, uint256 burned, uint256 liquidity) = _runDeepen(token);
        assertEq(spent, cap, "a full cap, no slippage bound, the block's own time as deadline");
        assertEq(liquidity, 0, "nothing to add before graduation");
        assertEq(IERC20(token).totalSupply(), supply - burned);
        assertEq(_pairOf(token).totalSupply(), 0, "the pool stays empty until graduation");

        // The run's own creator fee (10%, rounded up) is pending and comes back on the next collection.
        assertEq(pad.pendingCreatorFees(token), _divCeil(spent * 1000, BPS));
        uint256 heldBefore = deepen.usdcHeld(token);
        uint256 back = _collectDeepen(token);
        assertEq(deepen.usdcHeld(token), heldBefore + back);

        _warp(15 minutes);
        uint256 quarter = (pad.virtualUsdcOf(token) * CAP_BPS / BPS) * 900 / 3600;
        (spent,,) = _runDeepen(token);
        assertEq(spent, quarter, "15 minutes later: a quarter of the (grown) cap");
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 2);
        _assertDeepenSystem();
    }

    /// @dev A run whose offer covers the rest of the curve makes the sell-out buy: the launchpad takes only what the
    ///      last tokens cost, graduates the token inside the run and seeds the pool; the rest of the offer stays held,
    ///      and the next run, paced from this one, deepens the pool.
    function test_deepen_runThatCrossesGraduation() public {
        address token = _launchDeepen(500);
        (,,, uint256 fullCost,) = _expCurveBuy(token, 1e15);
        _curveBuy(bob, token, fullCost - 40e6); // leaves ~40 USDC of curve
        _collectDeepen(token);
        uint256 cap = pad.virtualUsdcOf(token) * CAP_BPS / BPS;
        (,,, uint256 sellOutCost, bool graduates) = _expCurveBuy(token, cap);
        assertTrue(graduates, "one capped offer covers the rest of the curve");
        uint256 heldBefore = deepen.usdcHeld(token);
        uint256 remaining = CURVE_SUPPLY - uint256(pad.curves(token).tokensSold);

        (uint256 spent, uint256 burned,) = _runDeepen(token);
        assertTrue(pad.isGraduated(token), "graduated inside the run");
        assertEq(spent, sellOutCost, "took only what the last tokens cost");
        assertEq(burned, remaining, "bought the last curve tokens and burned them");
        assertEq(IERC20(token).balanceOf(DEAD), 0, "burned, not parked at the burn address");
        assertEq(deepen.usdcHeld(token), heldBefore - spent, "the rest of the offer stays held");

        (uint256 offered,) = deepen.previewRun(token);
        assertEq(offered, 0, "already ran this block");
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.AlreadyRanThisBlock.selector, token));
        deepen.run(token);

        _collectDeepen(token); // includes the creator fee of the sell-out buy
        _warp(10 minutes);
        (,, uint256 liquidity) = _runDeepen(token); // now in the pool, a sixth of the pool's cap
        assertGt(liquidity, 0, "the first pool run adds liquidity");
        _assertDeepenSystem();
    }

    // ─── In the pool ──────────────────────────────────────────────────────────

    /// @dev The pool run: about half buys through the router, the rest goes in with every token bought, the LP is
    ///      locked at the burn address, the pool's token reserve ends where it was and its USDC reserve grows, so k
    ///      and the price both rise; nothing sticks in the plugin.
    function test_deepen_afterGraduation_addsLiquidityWithLpToDead() public {
        address token = _launchDeepen(700);
        _curveBuy(bob, token, 6_000e6);
        _graduateVia(carol, token);
        _collectDeepen(token);
        (uint256 rt, uint256 ru) = _reserves(token);
        uint256 cap = ru * CAP_BPS / BPS;
        assertGt(deepen.usdcHeld(token), cap);
        LaunchPair pair = _pairOf(token);
        uint256 lpBefore = pair.balanceOf(DEAD);
        assertEq(lpBefore, pair.totalSupply(), "at graduation every LP token is locked");

        (uint256 toBuy,) = deepen.previewSplit(token, cap);
        assertGt(toBuy * 2, cap, "a little over half buys: the buy pays the fees");
        assertLt(toBuy * 100, cap * 53, "and never much over half (1 / (2 - fee), at most 52.8%)");
        vm.expectCall(address(router), abi.encodeCall(ILaunchRouter.buy, (token, toBuy, 0, address(deepen), _now())));
        (uint256 spent, uint256 burned, uint256 liquidity) = _runDeepen(token);

        assertEq(burned, 0, "every token bought went back into the pool");
        assertGt(liquidity, 0);
        assertLe(cap - spent, 4, "at most the split's rounding stays held");
        (uint256 rtAfter, uint256 ruAfter) = _reserves(token);
        assertEq(rtAfter, rt, "the token reserve is back where it was");
        assertGt(ruAfter, ru, "and the USDC reserve grew");
        assertGt(rtAfter * ruAfter, rt * ru, "k grows");
        assertEq(pair.balanceOf(DEAD), lpBefore + liquidity, "the LP is locked forever");
        assertEq(pair.totalSupply(), lpBefore + liquidity, "nobody else holds LP");
        assertEq(pair.balanceOf(address(deepen)), 0);

        // And again an hour later, after the creator fee of its own buy comes back.
        _collectDeepen(token);
        _warp(RUN_INTERVAL);
        (,, uint256 more) = _runDeepen(token);
        assertGt(more, 0);
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        _poolBuy(dave, token, 3_000e6);
        _assertDeepenSystem();
    }

    /// @dev The whole life of a token: curve trades, runs, graduation, pool trades, runs, collections. Nothing is ever
    ///      stuck in the plugin, and every USDC unit is accounted for after each step.
    function test_deepen_fullLifecycle_nothingStuck() public {
        address token = _launchDeepen(250, 500e6);
        _curveBuy(bob, token, 3_000e6);
        _collectDeepen(token);
        _runDeepen(token);
        _assertDeepenSystem();
        _warp(2 hours);
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 3);
        _collectDeepen(token);
        _runDeepen(token);
        _graduateVia(carol, token);
        _collectDeepen(token);
        _warp(1 hours);
        _runDeepen(token);
        _poolBuy(dave, token, 5_000e6);
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 4);
        _collectDeepen(token);
        _warp(1 hours);
        _runDeepen(token);
        _collectFees();
        _assertDeepenSystem();
        assertEq(IERC20(token).balanceOf(address(deepen)), 0);
        assertEq(_pairOf(token).balanceOf(address(deepen)), 0);
        assertEq(usdc.balanceOf(address(deepen)), deepen.usdcHeld(token));
    }

    // ─── Top-ups by anyone (the platform-fee use case) ────────────────────────

    /// @dev Anyone may deliver fees for a configured token. Architex's own fee wallet can top a token's pot up out of
    ///      the platform fees it collected; the plugin credits the token and spends it like any creator fee. A token
    ///      with a 0% creator fee can be fed this way entirely.
    function test_deepen_topUpFromThePlatformFeeWalletAndAnyone() public {
        address token = _launchDeepen(0); // no creator fee at all
        _curveBuy(bob, token, 8_000e6);
        assertEq(pad.pendingCreatorFees(token), 0, "no creator fee to collect");
        _collectFees(); // the platform fees land in Architex's fee wallet
        uint256 wallet = usdc.balanceOf(feeTo);
        assertGt(wallet, 0);

        _topUp(token, feeTo, wallet / 2);
        _topUp(token, frank, 1_000e6); // and anyone else who wants to
        assertEq(deepen.usdcHeld(token), wallet / 2 + 1_000e6);

        (uint256 spent,, uint256 liquidity) = _runDeepen(token);
        assertGt(spent, 0);
        assertEq(liquidity, 0, "still on the curve: bought and burned");
        _graduateVia(carol, token);
        _warp(RUN_INTERVAL);
        (,, liquidity) = _runDeepen(token);
        assertGt(liquidity, 0, "in the pool the top-up deepens the pool");
        _assertDeepenSystem();
    }

    // ─── As a Combo entry, next to Buyback & burn ─────────────────────────────

    /// @dev Half the creator fee to Buyback & burn, half to Deepen pool. Both are configured through the Combo at
    ///      launch, each collection gives each exactly its slice, and each keeps its own pacing clock: they run in the
    ///      same blocks and never touch each other's USDC. The creator fee of each plugin's own buys comes back
    ///      through the Combo and is split again.
    function test_deepen_comboEntryNextToBuybackFiftyFifty() public {
        bytes memory data =
            abi.encode(_addrs(address(deepen), address(buyback)), _u16s(5000, 5000), _datas("", ""));
        address token = _launchWith(alice, 1000, address(combo), data, 0);
        _trackDeepenToken(token);
        assertTrue(deepen.isConfigured(token) && buyback.isConfigured(token));

        _curveBuy(bob, token, 9_000e6);
        uint256 owed = pad.pendingCreatorFees(token);
        _collectDeepen(token);
        assertEq(deepen.usdcHeld(token), owed / 2, "exactly its slice");
        assertEq(buyback.usdcHeld(token), owed - owed / 2);
        assertEq(usdc.balanceOf(address(combo)), 0, "the Combo keeps nothing");

        // Both plugins run in the same block, each with its own budget and its own USDC.
        uint256 supply = IERC20(token).totalSupply();
        (uint256 deepenSpent,,) = _runDeepen(token);
        (uint256 buybackSpent,) = _run(token);
        // Each takes a full cap of the reserve it reads, from its own pot: two paced plugins spend twice the pace
        // of one (V13-SPEC §2.3, "Two paced plugins on one token").
        assertGt(deepenSpent, 0);
        assertGe(buybackSpent, deepenSpent, "the second run reads the reserve the first one raised");
        assertLe(buybackSpent * 100, deepenSpent * 101, "both are one cap of the same curve");
        assertLt(IERC20(token).totalSupply(), supply, "both burned");
        assertEq(usdc.balanceOf(address(deepen)), deepen.usdcHeld(token));
        assertEq(usdc.balanceOf(address(buyback)), buyback.usdcHeld(token));

        // The creator fee of both runs comes back through the Combo and is split again.
        uint256 back = pad.pendingCreatorFees(token);
        assertGt(back, 0);
        _collectDeepen(token);

        _graduateVia(carol, token);
        _collectDeepen(token);
        _warp(RUN_INTERVAL);
        (,, uint256 liquidity) = _runDeepen(token);
        assertGt(liquidity, 0, "Deepen adds liquidity");
        (, uint256 burnedByBuyback) = _run(token);
        assertGt(burnedByBuyback, 0, "Buyback & burn burns");
        _collectDeepen(token);
        _assertDeepenSystem();
    }

    // ─── Pacing on the real suite ─────────────────────────────────────────────

    /// @dev The budget refills in proportion to the time since the last run, fully after an hour, never beyond one
    ///      cap; a second block in the same second has nothing to buy; another token has its own clock.
    function test_deepen_pacing_onTheRealCurveAndPool() public {
        address a = _launchDeepen(500);
        address b = _launchDeepen(500);
        _curveBuy(bob, a, 8_000e6);
        _curveBuy(bob, b, 8_000e6);
        _topUp(a, frank, 5_000e6);
        _topUp(b, frank, 5_000e6);

        _runDeepen(a); // a full cap
        vm.roll(vm.getBlockNumber() + 1); // the next block, same second
        (uint256 offer,) = deepen.previewRun(a);
        assertEq(offer, 0, "no time has passed: no budget");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, a));
        deepen.run(a);
        _runDeepen(b); // b's clock is its own: a full cap

        _warp(15 minutes);
        (uint256 cap, uint256 budget) = _deepenBudget(a);
        assertEq(budget, cap * 900 / 3600, "a quarter of an hour: a quarter of a cap");
        _runDeepen(a);
        _warp(5 hours);
        (cap, budget) = _deepenBudget(a);
        assertEq(budget, cap, "idle time beyond an hour does not accumulate");
        _runDeepen(a);

        _graduateVia(carol, a);
        _collectDeepen(a);
        _warp(30 minutes);
        (cap, budget) = _deepenBudget(a);
        (, uint256 ru) = _reserves(a);
        assertEq(cap, ru * CAP_BPS / BPS, "in the pool the cap follows the pool's USDC reserve");
        assertEq(budget, cap / 2);
        _runDeepen(a);
        _assertDeepenSystem();
    }

    // ─── Dust ─────────────────────────────────────────────────────────────────

    /// @dev Below MIN_RUN_USDC (3 units) previewRun is 0 and run reverts NothingToBuy, at 0% and 10% creator fees, on
    ///      the curve and in the pool; exactly 3 units run, buy at least a token wei and burn it (nothing is left to
    ///      add).
    function test_deepen_dustBelowTheMinimum_previewZeroNothingToBuy() public {
        uint16[2] memory fees = [uint16(0), 1000];
        for (uint256 i; i < 2; ++i) {
            for (uint256 venue; venue < 2; ++venue) {
                uint256 snap = vm.snapshotState();
                address token = _launchDeepen(fees[i]);
                _curveBuy(bob, token, 1_000e6);
                if (venue == 1) _graduateVia(carol, token);
                assertEq(deepen.usdcHeld(token), 0);
                for (uint256 held; held < MIN_RUN_USDC; ++held) {
                    if (held == 0) {
                        _topUp(token, frank, 1);
                        continue;
                    }
                    (uint256 offer,) = deepen.previewRun(token);
                    assertEq(offer, 0, "below the minimum: previewRun 0");
                    vm.prank(keeper);
                    vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, token));
                    deepen.run(token);
                    _topUp(token, frank, 1);
                }
                assertEq(deepen.usdcHeld(token), MIN_RUN_USDC);
                (uint256 spent, uint256 burned, uint256 liquidity) = _runDeepen(token);
                assertEq(spent, MIN_RUN_USDC);
                assertGt(burned, 0, "the minimum buys and burns at least a token wei");
                assertEq(liquidity, 0, "too small to add anything");
                _assertDeepenSystem();
                vm.revertToState(snap);
            }
        }
    }

    /// @dev The creator fee a run pays flows back to the plugin, which spends it, and so on: each round returns ~10%
    ///      (at a 10% creator fee) of the buy half, so it converges, on the curve and in the pool, and never loops.
    ///      What remains is under MIN_RUN_USDC.
    function test_deepen_creatorFeeLoopConverges_onCurveAndInPool() public {
        address token = _launchDeepen(1000);
        _curveBuy(bob, token, 300e6);
        _collectDeepen(token);
        uint256 rounds = _spendDownDeepen(token);
        console2.log("hourly rounds to spend down on the curve:", rounds);

        _graduateVia(carol, token); // a ~2,700 USDC creator fee from the sell-out buy
        _collectDeepen(token);
        rounds = _spendDownDeepen(token);
        console2.log("hourly rounds to spend down in the pool:", rounds);
        _assertDeepenSystem();
    }

    /// @dev Hourly runs and collections until only dust is left.
    function _spendDownDeepen(address token) internal returns (uint256 rounds) {
        _warp(RUN_INTERVAL);
        (uint256 cap0,) = _deepenBudget(token);
        uint256 maxRounds = deepen.usdcHeld(token) * 10 / (9 * cap0) + 40;
        while (true) {
            (uint256 offer,) = deepen.previewRun(token);
            if (offer == 0) {
                assertLt(deepen.usdcHeld(token), MIN_RUN_USDC, "only dust under the minimum is left");
                vm.prank(keeper);
                vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.NothingToBuy.selector, token));
                deepen.run(token);
                return rounds;
            }
            _runDeepen(token);
            _collectDeepen(token);
            ++rounds;
            assertLe(rounds, maxRounds, "converges: no endless loop");
            _warp(RUN_INTERVAL);
        }
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev Any creator fee, any pool state (random trades first) and any pot: a pool run buys the documented share,
    ///      adds every token it bought at the pool's ratio, locks the LP at the burn address, leaves at most 4 units
    ///      behind and keeps nothing.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_deepen_poolRunAddsEverythingItBuys(uint16 bpsRaw, uint64 tradeRaw, uint64 potRaw, bool sellFirst)
        public
    {
        uint16 bps = uint16(bound(bpsRaw, 0, 1000));
        address token = _launchDeepen(bps);
        _graduateVia(carol, token);
        if (sellFirst) _poolSell(carol, token, IERC20(token).balanceOf(carol) / 3);
        _poolBuy(bob, token, bound(tradeRaw, 1e6, 200_000e6));
        _collectDeepen(token);
        _topUp(token, frank, bound(potRaw, 3, 50_000e6));

        (uint256 rt, uint256 ru) = _reserves(token);
        LaunchPair pair = _pairOf(token);
        uint256 lpDead = pair.balanceOf(DEAD);
        (uint256 offer,) = deepen.previewRun(token);
        (uint256 spent, uint256 burned, uint256 liquidity) = _runDeepen(token);

        (uint256 rtAfter, uint256 ruAfter) = _reserves(token);
        assertLe(offer - spent, 4);
        assertGt(ruAfter, ru, "the pool's USDC side grew");
        assertGe(rtAfter * ruAfter, rt * ru, "k never falls");
        assertEq(pair.balanceOf(DEAD), lpDead + liquidity);
        // Tokens that did not fit the add are burned: at most about 2 units' worth.
        assertLe(burned * ruAfter, 2 * rtAfter + rtAfter / 1e6, "at most ~2 units' worth burned");
        if (offer >= 1_000) {
            assertEq(burned, 0, "beyond dust every token bought goes into the pool");
            assertEq(rtAfter, rt, "so the token reserve is unchanged");
            assertGt(liquidity, 0);
        }
        _assertDeepenSystem();
    }
}
