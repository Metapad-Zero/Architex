// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 2: graduation with each plugin (V13-SPEC §4, §5). Buying the curve out raises ~25,000 USDC and seeds
///         the token's launch pair with exactly that and POOL_SUPPLY tokens, LP locked at the burn address; creator
///         fees pending at graduation still collect to the token's plugin; the pool then trades only through the
///         LaunchRouter, whose quotes equal its trades, and its creator fees collect to the same plugin.
contract GraduationE2ETest is E2EBase {
    /// @dev Curve trading, the graduating buy (checked by _curveBuy: exact fill, Graduated event, seeding, LP, price
    ///      continuity), collection of what was pending at graduation, then router trades and another collection.
    function _graduationScenario(Kind kind, uint16 bps) internal returns (address token) {
        (address plugin, bytes memory data) = _pluginFor(kind);
        token = _launchWith(alice, bps, plugin, data, 0);
        // V13-SPEC §1 / VIRTUAL_USDC_0: every curve opens at a 6,250 USDC market cap...
        assertApproxEqAbs(pad.marketCap(token), 6_250e6, 1e6, "opens at 6,250 USDC");
        _curveBuy(alice, token, 1_000e6);
        _curveBuy(bob, token, 5_000e6);
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 3);
        _curveBuy(carol, token, 9_000e6);

        // Before graduation: the pool is empty and locked, the router refuses the token.
        LaunchPair pair = _pairOf(token);
        assertEq(pair.totalSupply(), 0);
        vm.prank(carol);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        IERC20(token).transfer(address(pair), 1);
        vm.expectRevert(ILaunchRouter.NotGraduated.selector);
        router.quoteBuy(token, 1e6);
        vm.prank(carol);
        vm.expectRevert(ILaunchRouter.NotGraduated.selector);
        router.sell(token, 1e18, 0, carol, _now());

        uint256 pendingBefore = pad.pendingCreatorFees(token);
        _graduateVia(dave, token);
        assertEq(pad.progressBps(token), BPS);
        // ...and closes 16x higher, at 100,000 USDC.
        assertApproxEqAbs(pad.marketCap(token), 100_000e6, 1e6, "closes at 100,000 USDC");
        _assertSolvent(); // the curve's float left with the seed; nothing else moved
        if (bps != 0) assertGt(pad.pendingCreatorFees(token), pendingBefore, "the graduating buy paid its creator fee");

        // The curve is closed for good.
        vm.startPrank(bob);
        vm.expectRevert(IArchitexLaunchpad.CurveGraduated.selector);
        pad.buy(token, 1e6, 0, bob, _now());
        vm.expectRevert(IArchitexLaunchpad.CurveGraduated.selector);
        pad.sell(token, 1e18, 0, bob, _now());
        vm.stopPrank();
        // A direct swap is refused: only the router trades the pool (V13-SPEC §6.5).
        vm.prank(bob);
        vm.expectRevert(ILaunchPair.OnlyRouter.selector);
        pair.swap(1e18, 0, bob);

        // Everything pending at graduation goes to this token's plugin.
        _collect(token);

        // The pool through the router: quotes are executions (checked by the helpers), fees accrue per token.
        _poolBuy(erin, token, 2_500e6);
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        _poolBuy(frank, token, 777_777);
        _poolSell(dave, token, IERC20(token).balanceOf(dave) / 5);
        _collect(token);
        _collectFees();
        _assertSystem();
    }

    function test_graduation_creatorWallet() public {
        _graduationScenario(Kind.Eoa, 300);
    }

    function test_graduation_plainContract() public {
        _graduationScenario(Kind.Plain, 450);
        assertEq(plainWallet.calls(), 0);
    }

    function test_graduation_safeLikeWallet() public {
        _graduationScenario(Kind.SafeLike, 1000);
        assertEq(safeWallet.calls(), 0);
    }

    function test_graduation_split() public {
        address token = _graduationScenario(Kind.Split, 500);
        _releaseAll(token);
        // carol 5, dave 3, erin 2: everyone paid their share of everything, curve and pool alike
        uint256 received = split.totalReceived(token);
        assertEq(split.released(token, carol), received * 5 / 10);
        assertEq(split.released(token, dave), received * 3 / 10);
        assertEq(split.released(token, erin), received * 2 / 10);
        _assertSystem();
    }

    function test_graduation_buyback() public {
        address token = _graduationScenario(Kind.Buyback, 700);
        _nextBlock();
        _run(token); // in the pool, through the router
        _collect(token); // the run's own creator fee comes back
        _assertSystem();
    }

    function test_graduation_holders() public {
        address token = _graduationScenario(Kind.Holder, 250);
        _finishStream(token); // past the stream's end, everything delivered is claimable
        _claim(token, bob);
        _claim(token, erin);
        _assertSystem();
    }

    function test_graduation_combo() public {
        address token = _graduationScenario(Kind.Combo, 1000);
        _nextBlock();
        _run(token);
        _collect(token);
        _finishStream(token);
        _releaseAll(token);
        _assertSystem();
    }

    /// @dev The creator's first buy sells the whole curve out inside createToken: the plugin is configured first
    ///      (onLaunch runs before the first buy), the token graduates atomically, and the exact-fill creator fee
    ///      collects to the plugin. Then the pool trades.
    function test_graduation_insideCreateToken_everyHookPlugin() public {
        for (uint256 k = uint256(Kind.Split); k <= uint256(Kind.Combo); ++k) {
            (address plugin, bytes memory data) = _pluginFor(Kind(k));
            (, uint256 ePlatform, uint256 eCreator, uint256 eSpent, bool eGrad) =
                _calcCurveBuy(VIRTUAL_USDC_0, VIRTUAL_TOKENS_0, CURVE_SUPPLY, 40_000e6, 600);
            assertTrue(eGrad, "40,000 USDC sells the whole curve out");
            address token = _launchWith(alice, 600, plugin, data, 40_000e6);
            assertTrue(ILaunchFeePlugin(plugin).isConfigured(token), "configured before the first buy");
            // A fresh curve starts at VIRTUAL_USDC_0, so the seed is the exact-fill net.
            _assertGraduated(token, eSpent - ePlatform - eCreator);
            assertEq(IERC20(token).balanceOf(alice), CURVE_SUPPLY, "the creator bought the whole curve");
            _collect(token);
            _poolBuy(bob, token, 1_000e6);
            _poolSell(alice, token, 10_000_000e18);
            _collect(token);
        }
        _assertSystem();
    }

    /// @dev [D17]: anyone can add liquidity on top of the graduation liquidity and remove their own; the graduation LP
    ///      stays at the burn address; the pair stays excluded from dividends; the router's quotes still execute.
    function test_graduation_liquidityOnTopIsOpen_graduationLpStaysLocked() public {
        address token = _graduationScenario(Kind.Holder, 500);
        LaunchPair pair = _pairOf(token);
        uint256 lockedLp = pair.balanceOf(DEAD);
        (uint256 rt, uint256 ru) = _reserves(token);

        // frank adds 1% of the pool, both sides, atomically (V13-SPEC §9: no router helper)
        uint256 addTokens = rt / 100;
        uint256 addUsdc = ru / 100 + 1;
        _poolBuy(frank, token, addUsdc * 2);
        vm.startPrank(frank);
        IERC20(token).transfer(address(pair), addTokens);
        usdc.transfer(address(pair), addUsdc);
        uint256 minted = pair.mint(frank);
        vm.stopPrank();
        assertGt(minted, 0);
        assertEq(pair.balanceOf(DEAD), lockedLp, "graduation LP untouched");
        assertEq(ILaunchToken(token).eligibleSupply(), _eligible(token), "the pair's new tokens are excluded");

        _poolBuy(erin, token, 1_234e6);
        _poolSell(erin, token, IERC20(token).balanceOf(erin) / 2);

        // frank removes exactly his own liquidity
        vm.startPrank(frank);
        pair.transfer(address(pair), minted);
        (uint256 outToken, uint256 outUsdc) = pair.burn(frank);
        vm.stopPrank();
        assertGt(outToken, 0);
        assertGt(outUsdc, 0);
        assertEq(pair.balanceOf(frank), 0);
        assertEq(pair.balanceOf(DEAD), lockedLp, "graduation LP still locked");
        assertEq(pair.totalSupply(), lockedLp);
        _collect(token);
        _assertSystem();
    }

    /// @dev Router quotes equal router trades, for any plugin, creator fee and size.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_graduation_routerQuoteIsExecution(uint8 kindRaw, uint16 bpsRaw, uint64 buyRaw, uint96 sellRaw)
        public
    {
        Kind kind = Kind(bound(kindRaw, 0, uint256(Kind.Combo)));
        address token = _launch(kind, uint16(bound(bpsRaw, 0, 1000)), 0);
        _curveBuy(bob, token, 10_000e6);
        _graduateVia(carol, token);
        _collect(token);
        _poolBuy(dave, token, bound(buyRaw, 1_000, 80_000e6));
        uint256 tokensIn = bound(sellRaw, 1e12, IERC20(token).balanceOf(carol));
        (uint256 rt, uint256 ru) = _reserves(token);
        uint256 gross = tokensIn * ru / (rt + tokensIn);
        if (_divCeil(gross * FEE_BPS, BPS) + _divCeil(gross * pad.creatorFeeBpsOf(token), BPS) < gross) {
            _poolSell(carol, token, tokensIn);
        }
        _collect(token);
        _assertSystem();
    }
}
