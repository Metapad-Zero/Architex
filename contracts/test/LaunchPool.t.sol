// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./launchpad/LaunchpadV13Base.sol";

/// @notice The launch-pool suite (V13-SPEC §4): LaunchPairFactory, LaunchPair and LaunchRouter.
contract LaunchPoolTest is LaunchpadV13Base {
    address token;
    LaunchPair pair;

    function setUp() public override {
        super.setUp();
        token = _create(300, creatorWallet);
        pair = _pairOf(token);
    }

    function _graduateHere() internal {
        _graduate(token);
    }

    // ─── Factory ─────────────────────────────────────────────────────────────

    function test_factory_wiring() public view {
        assertEq(pairFactory.launchpad(), address(pad));
        assertEq(pairFactory.usdc(), address(usdc));
        assertEq(pairFactory.getPair(token), address(pair));
        assertEq(pairFactory.allPairsLength(), 1);
        assertEq(pairFactory.allPairs(0), address(pair));
        assertEq(pairFactory.getPair(address(0xBEEF)), address(0));
    }

    function test_factory_onlyTheLaunchpadCreatesPairs() public {
        vm.prank(mallory);
        vm.expectRevert(ILaunchPairFactory.OnlyLaunchpad.selector);
        pairFactory.createPair(address(0xBEEF));
        vm.startPrank(address(pad));
        vm.expectRevert(ILaunchPairFactory.PairExists.selector);
        pairFactory.createPair(token);
        vm.expectRevert(ILaunchPairFactory.ZeroAddress.selector);
        pairFactory.createPair(address(0));
        vm.stopPrank();
    }

    // ─── Pair basics ─────────────────────────────────────────────────────────

    function test_pair_immutables() public view {
        assertEq(pair.factory(), address(pairFactory));
        assertEq(pair.router(), address(router));
        assertEq(pair.token(), token);
        assertEq(pair.usdc(), address(usdc));
        assertEq(pair.MINIMUM_LIQUIDITY(), 1000);
        assertEq(pair.totalSupply(), 0);
        assertEq(pair.name(), "Architex Launch LP");
        assertEq(pair.symbol(), "ATX-LLP");
        (uint112 reserveToken, uint112 reserveUsdc, uint32 ts) = pair.getReserves();
        assertEq(reserveToken, 0);
        assertEq(reserveUsdc, 0);
        assertEq(ts, 0);
    }

    function test_pair_graduationMintIsTheFirstMint() public {
        _graduateHere();
        uint256 seeded = usdc.balanceOf(address(pair));
        uint256 root = _sqrt(POOL_SUPPLY * seeded);
        assertEq(pair.totalSupply(), root);
        assertEq(pair.balanceOf(DEAD), root, "MINIMUM_LIQUIDITY + graduation LP, all at DEAD");
    }

    // ─── Open mint / burn on top of the graduation liquidity (D17) ───────────

    function test_pair_anyoneCanAddAndRemoveLiquidity() public {
        _graduateHere();
        (uint112 reserveToken, uint112 reserveUsdc,) = pair.getReserves();
        uint256 supply = pair.totalSupply();
        // bob holds 800M tokens from the graduating buy; add 1% of the pool proportionally
        uint256 addToken = uint256(reserveToken) / 100;
        uint256 addUsdc = uint256(reserveUsdc) / 100;
        vm.startPrank(bob);
        IERC20(token).transfer(address(pair), addToken);
        usdc.transfer(address(pair), addUsdc);
        uint256 liquidity = pair.mint(bob);
        vm.stopPrank();
        uint256 expected = addToken * supply / reserveToken;
        uint256 expectedUsdcSide = addUsdc * supply / reserveUsdc;
        assertEq(liquidity, expected < expectedUsdcSide ? expected : expectedUsdcSide);
        assertEq(pair.balanceOf(bob), liquidity);

        // and take it back out
        uint256 tokenBefore = IERC20(token).balanceOf(bob);
        uint256 usdcBefore = usdc.balanceOf(bob);
        vm.startPrank(bob);
        pair.transfer(address(pair), liquidity);
        (uint256 outToken, uint256 outUsdc) = pair.burn(bob);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(bob) - tokenBefore, outToken);
        assertEq(usdc.balanceOf(bob) - usdcBefore, outUsdc);
        assertLe(outToken, addToken, "the pool keeps the rounding");
        assertLe(outUsdc, addUsdc);
        assertApproxEqRel(outToken, addToken, 1e10); // within 1e-8: the 6-decimal side sets the share
        (uint112 rt, uint112 ru,) = pair.getReserves();
        assertEq(rt, IERC20(token).balanceOf(address(pair)));
        assertEq(ru, usdc.balanceOf(address(pair)));
    }

    function test_pair_graduationLiquidityCannotBeBurned() public {
        _graduateHere();
        // Nothing sent in: burning zero liquidity reverts
        vm.expectRevert(ILaunchPair.InsufficientLiquidityBurned.selector);
        pair.burn(mallory);
        assertEq(pair.balanceOf(DEAD), pair.totalSupply());
    }

    function test_pair_mintWithNothingReverts() public {
        _graduateHere();
        vm.expectRevert(ILaunchPair.InsufficientLiquidityMinted.selector);
        pair.mint(mallory);
    }

    function test_pair_firstMintNeedsBothAssets() public {
        // Before graduation the token cannot enter the pair; USDC alone mints nothing
        vm.startPrank(mallory);
        usdc.transfer(address(pair), 1_000_000e6);
        vm.expectRevert(ILaunchPair.InsufficientLiquidityMinted.selector);
        pair.mint(mallory);
        vm.stopPrank();
    }

    // ─── skim / sync ─────────────────────────────────────────────────────────

    function test_pair_skimAndSync() public {
        _graduateHere();
        (uint112 reserveToken, uint112 reserveUsdc,) = pair.getReserves();
        vm.prank(mallory);
        usdc.transfer(address(pair), 123e6);
        pair.skim(carol);
        assertEq(usdc.balanceOf(carol), 100_000_000e6 + 123e6);
        (uint112 rt, uint112 ru,) = pair.getReserves();
        assertEq(rt, reserveToken);
        assertEq(ru, reserveUsdc);

        vm.prank(mallory);
        usdc.transfer(address(pair), 77e6);
        pair.sync();
        (, ru,) = pair.getReserves();
        assertEq(ru, uint256(reserveUsdc) + 77e6, "a synced donation joins the reserves");
    }

    // ─── swap: router only, no flash swaps, constant product without fee ─────

    function test_pair_swapIsRouterOnly() public {
        _graduateHere();
        vm.prank(mallory);
        vm.expectRevert(ILaunchPair.OnlyRouter.selector);
        pair.swap(0, 1, mallory);
    }

    function test_pair_noFlashSwap_outputWithoutInputReverts() public {
        _graduateHere();
        vm.prank(address(router));
        vm.expectRevert(ILaunchPair.InsufficientInputAmount.selector);
        pair.swap(1e18, 0, mallory);
    }

    function test_pair_swapChecks() public {
        _graduateHere();
        (uint112 reserveToken, uint112 reserveUsdc,) = pair.getReserves();
        vm.startPrank(address(router));
        vm.expectRevert(ILaunchPair.InsufficientOutputAmount.selector);
        pair.swap(0, 0, mallory);
        vm.expectRevert(ILaunchPair.InsufficientLiquidity.selector);
        pair.swap(reserveToken, 0, mallory);
        vm.expectRevert(ILaunchPair.InsufficientLiquidity.selector);
        pair.swap(0, reserveUsdc, mallory);
        vm.expectRevert(ILaunchPair.InvalidTo.selector);
        pair.swap(1, 0, token);
        vm.expectRevert(ILaunchPair.InvalidTo.selector);
        pair.swap(1, 0, address(usdc));
        vm.stopPrank();

        // One unit more out than constant product allows: K
        uint256 usdcIn = 1_000e6;
        uint256 fair = usdcIn * reserveToken / (uint256(reserveUsdc) + usdcIn);
        vm.prank(bob);
        usdc.transfer(address(pair), usdcIn);
        vm.startPrank(address(router));
        vm.expectRevert(ILaunchPair.K.selector);
        pair.swap(fair + 1e12, 0, bob);
        pair.swap(fair, 0, bob); // the exact constant-product output passes
        vm.stopPrank();
        (uint112 rt, uint112 ru,) = pair.getReserves();
        assertGe(uint256(rt) * uint256(ru), uint256(reserveToken) * uint256(reserveUsdc), "k never falls");
    }

    // ─── Router: quotes are the trades, fees on the USDC side ────────────────

    function testFuzz_router_buyQuoteIsExecution(uint64 rawIn) public {
        _graduateHere();
        uint256 usdcIn = bound(rawIn, 1_000, 200_000e6);
        (uint256 qOut, uint256 qPlatform, uint256 qCreator) = router.quoteBuy(token, usdcIn);
        (uint112 reserveToken, uint112 reserveUsdc,) = pair.getReserves();
        uint256 feesBefore = pad.pendingFees();
        uint256 creatorBefore = pad.pendingCreatorFees(token);
        vm.prank(carol);
        uint256 got = router.buy(token, usdcIn, qOut, carol, block.timestamp);
        assertEq(got, qOut);
        assertEq(qPlatform, _divCeil(usdcIn * FEE_BPS, BPS));
        assertEq(qCreator, _divCeil(usdcIn * 300, BPS));
        assertEq(pad.pendingFees() - feesBefore, qPlatform);
        assertEq(pad.pendingCreatorFees(token) - creatorBefore, qCreator);
        (uint112 rt, uint112 ru,) = pair.getReserves();
        assertEq(ru, uint256(reserveUsdc) + usdcIn - qPlatform - qCreator);
        assertEq(rt, uint256(reserveToken) - got);
        assertGe(uint256(rt) * uint256(ru), uint256(reserveToken) * uint256(reserveUsdc));
        _assertSolvent();
    }

    function testFuzz_router_sellQuoteIsExecution(uint96 rawIn) public {
        _graduateHere();
        uint256 tokensIn = bound(rawIn, 1e18, 100_000_000e18);
        (uint256 qOut, uint256 qPlatform, uint256 qCreator) = router.quoteSell(token, tokensIn);
        (uint112 reserveToken, uint112 reserveUsdc,) = pair.getReserves();
        uint256 gross = tokensIn * reserveUsdc / (uint256(reserveToken) + tokensIn);
        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        uint256 out = router.sell(token, tokensIn, qOut, bob, block.timestamp);
        assertEq(out, qOut);
        assertEq(out + qPlatform + qCreator, gross, "fees come out of the gross");
        assertEq(qPlatform, _divCeil(gross * FEE_BPS, BPS));
        assertEq(qCreator, _divCeil(gross * 300, BPS));
        assertEq(usdc.balanceOf(bob) - before, out);
        (uint112 rt, uint112 ru,) = pair.getReserves();
        assertEq(rt, uint256(reserveToken) + tokensIn);
        assertEq(ru, uint256(reserveUsdc) - gross);
        _assertSolvent();
    }

    function test_router_deadlineIsInclusive() public {
        _graduateHere();
        vm.prank(carol);
        router.buy(token, 1e6, 0, carol, block.timestamp);
    }

    function test_router_sellMovesOnlyTheCallersTokens() public {
        _graduateHere();
        uint256 bobTokens = IERC20(token).balanceOf(bob);
        // mallory holds nothing: her sell cannot touch bob's tokens
        vm.prank(mallory);
        vm.expectRevert();
        router.sell(token, 1e18, 0, mallory, block.timestamp);
        assertEq(IERC20(token).balanceOf(bob), bobTokens);
    }

    function test_router_buyToThePairOnlyDonates() public {
        _graduateHere();
        // A buyer who names the pair as recipient gifts the pool; nobody else is affected and accounting holds
        vm.prank(carol);
        router.buy(token, 10e6, 0, address(pair), block.timestamp);
        _assertSolvent();
        (uint112 rt,,) = pair.getReserves();
        assertEq(rt, IERC20(token).balanceOf(address(pair)));
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
