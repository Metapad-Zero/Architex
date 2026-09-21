// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 4: Buyback & burn against the real launchpad, launch pool and router (V13-SPEC §2.2, [D13], [D14]).
///         Each run (checked by _run) spends min(held, 0.25% of the USDC-side reserve), buys on the curve or through
///         the router, pays both fees like any trade, and really burns what it bought. The creator fee of its own trade
///         comes back to the plugin on the next collection; that loop converges.
contract BuybackBurnE2ETest is E2EBase {
    function test_buyback_onCurve_spendsTheCapAndBurns() public {
        address token = _launch(Kind.Buyback, 1000, 2_000e6);
        _curveBuy(bob, token, 10_000e6);
        _collect(token);
        uint256 held = buyback.usdcHeld(token);
        uint256 cap = pad.virtualUsdcOf(token) * CAP_BPS / BPS;
        assertGt(held, cap, "more waiting than one run may spend");

        uint256 supply = IERC20(token).totalSupply();
        vm.expectCall(address(pad), abi.encodeCall(IArchitexLaunchpadLite.buy, (token, cap, 0, address(buyback))));
        (uint256 spent, uint256 burned) = _run(token);
        assertEq(spent, cap, "spent exactly the cap, with no slippage bound (minTokensOut 0), as documented");
        assertEq(IERC20(token).totalSupply(), supply - burned);

        // The run's own creator fee (10%, rounded up) is pending and comes back on the next collection.
        assertEq(pad.pendingCreatorFees(token), _divCeil(spent * 1000, BPS));
        uint256 heldBefore = buyback.usdcHeld(token);
        uint256 back = _collect(token);
        assertEq(buyback.usdcHeld(token), heldBefore + back);

        _nextBlock();
        _run(token); // the cap follows the curve's virtual USDC
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 2);
        _assertSystem();
    }

    function test_buyback_onCurve_spendsEverythingHeldBelowTheCap() public {
        address token = _launch(Kind.Buyback, 100, 0);
        _curveBuy(bob, token, 1_000e6); // 10 USDC of creator fees, below the 20.8 USDC cap
        _collect(token);
        (uint256 spent,) = _run(token);
        assertEq(spent, _divCeil(1_000e6 * 100, BPS));
        assertEq(buyback.usdcHeld(token), 0);
        _nextBlock();
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

        vm.expectCall(
            address(router), abi.encodeCall(ILaunchRouter.buy, (token, cap, 0, address(buyback), _now()))
        );
        (uint256 spent, uint256 burned) = _run(token);
        assertEq(spent, cap);
        (uint256 rtAfter, uint256 ruAfter) = _reserves(token);
        assertEq(rt - rtAfter, burned, "the burned tokens came out of the pool");
        assertEq(ruAfter - ru, spent - _divCeil(spent * 50, BPS) - _divCeil(spent * 700, BPS), "only the net went in");
        _collect(token);
        _nextBlock();
        _run(token);
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        _assertSystem();
    }

    /// @dev A run whose capped offer covers the rest of the curve makes the sell-out buy: the launchpad takes only what
    ///      the last tokens cost, graduates the token inside the run, and the rest of the offer stays held for the next
    ///      run, which (a block later) buys in the pool (IBuybackBurnPlugin NatSpec).
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
        assertLt(spent, cap);
        assertEq(burned, remaining, "bought the last curve tokens and burned them");
        assertEq(IERC20(token).balanceOf(DEAD), 0, "burned, not parked at the burn address");
        assertEq(buyback.usdcHeld(token), heldBefore - spent, "the rest of the offer stays held");

        // Same block: no second run.
        (uint256 offered, bool grad) = buyback.previewRun(token);
        assertEq(offered, 0);
        assertTrue(grad);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.AlreadyRanThisBlock.selector, token));
        buyback.run(token);

        _collect(token); // includes the creator fee of the sell-out buy
        _nextBlock();
        _run(token); // now in the pool, through the router
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
        _nextBlock();
        _run(a);
        _assertSystem();
    }

    /// @dev The creator fee a run pays flows back to the plugin, which spends it, and so on: each round returns ~10%
    ///      (at a 10% creator fee) of the last, so it converges in a few rounds, on the curve and in the pool, and never
    ///      loops. What finally remains is at most 2 USDC units, which a trade's two rounded-up fees would eat whole:
    ///      that run reverts with the launchpad's (or router's) ZeroAmount and the dust waits for the next fees.
    function test_buyback_creatorFeeLoopConverges_onCurveAndInPool() public {
        address token = _launch(Kind.Buyback, 1000, 0);
        _curveBuy(bob, token, 300e6);
        _collect(token);
        uint256 rounds = _spendDown(token, IArchitexLaunchpad.ZeroAmount.selector);
        console2.log("rounds to spend down on the curve:", rounds);

        _graduateVia(carol, token); // a ~2,700 USDC creator fee from the sell-out buy
        _collect(token);
        rounds = _spendDown(token, ILaunchRouter.ZeroAmount.selector);
        console2.log("rounds to spend down in the pool:", rounds);
        _assertSystem();
    }

    /// @dev Runs and collects until only dust is left. Bound: each unit spent returns at most 10% (+1 unit of rounding),
    ///      so at most held0 / 0.9 is ever spent; every capped run spends at least the starting cap (the USDC-side
    ///      reserve only grows as the buyback buys); below the cap each round shrinks what is held ~10x.
    function _spendDown(address token, bytes4 dustError) internal returns (uint256 rounds) {
        uint256 held0 = buyback.usdcHeld(token);
        uint256 reserve0;
        if (pad.isGraduated(token)) (, reserve0) = _reserves(token);
        else reserve0 = pad.virtualUsdcOf(token);
        uint256 maxRounds = held0 * 10 / (9 * (reserve0 * CAP_BPS / BPS)) + 20;
        while (true) {
            uint256 held = buyback.usdcHeld(token);
            if (held == 0) return rounds;
            if (_divCeil(held * FEE_BPS, BPS) + _divCeil(held * pad.creatorFeeBpsOf(token), BPS) >= held) {
                // dust: its fees would be all of it
                assertLe(held, 2, "only a unit or two of dust can be left");
                _nextBlock();
                vm.prank(keeper);
                vm.expectRevert(dustError);
                buyback.run(token);
                return rounds;
            }
            _nextBlock();
            _run(token);
            _collect(token);
            ++rounds;
            assertLe(rounds, maxRounds, "converges: no endless loop");
        }
    }

    // ─── Sandwiching one run (V13-SPEC §2.2 buyback chunking) ─────────────────

    /// @dev Front-run a single capped run with a buy of any size, back-run with the sell: always a loss, even at a 0%
    ///      creator fee (the plugin is funded by a direct delivery). The run's cap is computed after the front-run.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_buyback_sandwichingOneRunLoses_onCurve(uint64 xRaw, uint16 bpsRaw) public {
        uint16 bps = uint16(bound(bpsRaw, 0, 1000));
        address token = _launch(Kind.Buyback, bps, 0);
        _curveBuy(bob, token, 2_000e6);
        _donate(address(buyback), token, frank, 100_000e6); // far more than one cap: the run spends a full cap
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

    /// @dev DESIGN LIMIT (reported; the spec only claims a single run cannot be sandwiched profitably). Runs are
    ///      permissionless, capped and one per block, so a pile worth many caps is spent over many consecutive blocks,
    ///      predictably. A trader who buys first, lets (or makes) several runs happen, then sells, captures the price
    ///      rise the buyback pays for. At a 0% creator fee four runs are enough; at 1%, sixteen; at 10% the fees keep it
    ///      unprofitable within 64 runs. Measured here in the pool (~25,000 USDC reserve) with a 25,000 USDC position.
    function test_designLimit_holdingThroughSeveralRunsCanProfit() public {
        int256 oneRunZeroFee = _frontRun(0, 25_000e6, 1);
        int256 fourRunsZeroFee = _frontRun(0, 25_000e6, 4);
        int256 sixteenRunsOnePercent = _frontRun(100, 25_000e6, 16);
        int256 sixtyFourRunsTenPercent = _frontRun(1000, 25_000e6, 64);
        console2.log("front-run PnL, USDC units (0% fee, 1 run):", oneRunZeroFee);
        console2.log("front-run PnL, USDC units (0% fee, 4 runs):", fourRunsZeroFee);
        console2.log("front-run PnL, USDC units (1% fee, 16 runs):", sixteenRunsOnePercent);
        console2.log("front-run PnL, USDC units (10% fee, 64 runs):", sixtyFourRunsTenPercent);
        assertLt(oneRunZeroFee, 0, "one run: the spec's claim holds");
        assertGt(fourRunsZeroFee, 0, "four runs at 0%: profitable");
        assertGt(sixteenRunsOnePercent, 0, "sixteen runs at 1%: profitable");
        assertLt(sixtyFourRunsTenPercent, 0, "at 10% the fees still win");
    }

    function _frontRun(uint16 bps, uint256 x, uint256 runs) internal returns (int256 pnl) {
        uint256 snap = vm.snapshotState();
        address token = _launch(Kind.Buyback, bps, 0);
        _curveBuy(bob, token, 1_000e6);
        _graduateVia(carol, token);
        _collect(token);
        _donate(address(buyback), token, frank, 1_000_000e6); // a large pile, as accrues when nobody runs it for a while
        uint256 before = usdc.balanceOf(mallory);
        _poolBuy(mallory, token, x);
        for (uint256 i; i < runs; ++i) {
            _run(token);
            _nextBlock();
        }
        _poolSell(mallory, token, IERC20(token).balanceOf(mallory));
        pnl = int256(usdc.balanceOf(mallory)) - int256(before);
        vm.revertToState(snap);
    }
}
