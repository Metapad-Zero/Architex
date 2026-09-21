// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./launchpad/LaunchpadV13Base.sol";

/// @notice V13-SPEC: creator fees, plugins, initialize, and graduation into the separate launch-pool suite.
contract ArchitexLaunchpadV13Test is LaunchpadV13Base {
    event CreatorFeesCollected(address indexed token, address indexed plugin, uint256 amount);
    event PoolFeesAccrued(address indexed token, uint256 platformFee, uint256 creatorFee);
    event Initialized(address indexed pairFactory, address indexed router);
    event TokenCreated(
        address indexed token,
        address indexed creator,
        address indexed plugin,
        address pair,
        uint16 creatorFeeBps,
        string name,
        string symbol,
        string metadataURI
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // 1 — Creator-fee math on the curve
    // ═══════════════════════════════════════════════════════════════════════════

    function testFuzz_buyFees_matchTheSpecAndNeverFavourTheTrader(uint64 rawUsdcIn, uint16 rawBps, uint64 rawPre) public {
        uint16 bps = uint16(bound(rawBps, 0, 1000));
        address token = _create(bps, creatorWallet);
        // Move the curve to a random point first
        uint256 pre = bound(rawPre, 0, 20_000e6);
        if (pre > 300) {
            vm.prank(carol);
            pad.buy(token, pre, 0, carol, type(uint256).max);
        }
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 usdcIn = bound(rawUsdcIn, 1, 3_000e6);

        uint256 expPlatform = _divCeil(usdcIn * FEE_BPS, BPS);
        uint256 expCreator = _divCeil(usdcIn * bps, BPS);
        if (expPlatform + expCreator >= usdcIn) {
            vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
            pad.quoteBuy(token, usdcIn);
            return;
        }
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 net = usdcIn - expPlatform - expCreator;
        uint256 expTokens = uint256(c.virtualTokens) - _divCeil(k, uint256(c.virtualUsdc) + net);
        if (expTokens == 0 || expTokens >= CURVE_SUPPLY - c.tokensSold) return; // dust or sell-out: covered elsewhere

        uint256 feesBefore = pad.pendingFees();
        uint256 creatorBefore = pad.pendingCreatorFees(token);
        vm.prank(alice);
        (uint256 tokensOut, uint256 spent) = pad.buy(token, usdcIn, 0, alice, type(uint256).max);

        uint256 platformFee = pad.pendingFees() - feesBefore;
        uint256 creatorFee = pad.pendingCreatorFees(token) - creatorBefore;
        assertEq(spent, usdcIn);
        assertEq(tokensOut, expTokens);
        assertEq(platformFee, expPlatform, "platform = ceil(usdcIn*50/1e4)");
        assertEq(creatorFee, expCreator, "creator = ceil(usdcIn*c/1e4)");
        assertEq(uint256(pad.curves(token).virtualUsdc), uint256(c.virtualUsdc) + net, "net reaches the curve");
        // Rounding never favours the trader: each fee is at least its exact share
        assertGe(platformFee * BPS, usdcIn * FEE_BPS);
        assertGe(creatorFee * BPS, usdcIn * bps);
        if (bps == 0) assertEq(creatorFee, 0);
        _assertSolvent();
    }

    function testFuzz_sellFees_matchTheSpecAndNeverFavourTheTrader(uint64 rawBuy, uint96 rawSell, uint16 rawBps) public {
        uint16 bps = uint16(bound(rawBps, 0, 1000));
        address token = _create(bps, creatorWallet);
        vm.prank(alice);
        (uint256 bought,) = pad.buy(token, bound(rawBuy, 1e6, 20_000e6), 0, alice, type(uint256).max);
        uint256 tokensIn = bound(rawSell, 1, bought);

        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 gross = uint256(c.virtualUsdc) - _divCeil(k, uint256(c.virtualTokens) + tokensIn);
        uint256 expPlatform = _divCeil(gross * FEE_BPS, BPS);
        uint256 expCreator = _divCeil(gross * bps, BPS);
        if (expPlatform + expCreator >= gross) {
            vm.prank(alice);
            vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
            pad.sell(token, tokensIn, 0, alice, type(uint256).max);
            return;
        }

        uint256 feesBefore = pad.pendingFees();
        uint256 creatorBefore = pad.pendingCreatorFees(token);
        uint256 usdcBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 out = pad.sell(token, tokensIn, 0, alice, type(uint256).max);

        uint256 platformFee = pad.pendingFees() - feesBefore;
        uint256 creatorFee = pad.pendingCreatorFees(token) - creatorBefore;
        assertEq(platformFee, expPlatform);
        assertEq(creatorFee, expCreator);
        assertEq(out, gross - platformFee - creatorFee, "fees sum exactly");
        assertEq(usdc.balanceOf(alice) - usdcBefore, out);
        assertEq(uint256(pad.curves(token).virtualUsdc), uint256(c.virtualUsdc) - gross);
        assertGe(platformFee * BPS, gross * FEE_BPS);
        assertGe(creatorFee * BPS, gross * bps);
        _assertSolvent();
    }

    /// @dev The sell-out buy: exact-fill gross, the cap, and the fee split (V13-SPEC §5).
    function testFuzz_exactFillFees(uint64 rawPre, uint64 rawOffer, uint16 rawBps) public {
        uint16 bps = uint16(bound(rawBps, 0, 1000));
        address token = _create(bps, creatorWallet);
        uint256 pre = bound(rawPre, 0, 24_000e6);
        if (pre > 300) {
            vm.prank(carol);
            pad.buy(token, pre, 0, carol, type(uint256).max);
        }
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        if (c.graduated) return;
        uint256 remaining = CURVE_SUPPLY - c.tokensSold;
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 net = _divCeil(k, uint256(c.virtualTokens) - remaining) - uint256(c.virtualUsdc);
        uint256 feeBps = FEE_BPS + bps;
        uint256 uncapped = net + _divCeil(net * feeBps, BPS - feeBps);
        // Offers from a little below the uncapped gross (the cap may bite) to far above it
        uint256 offer = bound(rawOffer, uncapped - uncapped / 50, uncapped * 3);

        (uint256 qTokens, uint256 qPlatform, uint256 qCreator, uint256 qSpent, bool qGraduates) = pad.quoteBuy(token, offer);
        if (!qGraduates) return;

        uint256 feesBefore = pad.pendingFees();
        uint256 creatorBefore = pad.pendingCreatorFees(token);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        (uint256 tokensOut, uint256 spent) = pad.buy(token, offer, 0, bob, type(uint256).max);

        // Whenever the offer sells out, the uncapped exact-fill gross fits in it: the cap never binds (see
        // testFuzz_sellOutNeedsExactlyTheExactFillGross); the contract keeps the min() as the spec's belt and braces.
        assertLe(uncapped, offer, "the exact-fill gross never exceeds a sell-out offer");
        uint256 expSpent = uncapped < offer ? uncapped : offer;
        uint256 totalFee = expSpent - net;
        uint256 expPlatform = _divCeil(totalFee * FEE_BPS, feeBps);
        uint256 platformFee = pad.pendingFees() - feesBefore;
        uint256 creatorFee = pad.pendingCreatorFees(token) - creatorBefore;
        assertEq(tokensOut, remaining, "fills exactly the remainder");
        assertEq(spent, expSpent, "min(offer, net + ceil(net*f/(1e4-f)))");
        assertLe(spent, offer, "never more than offered");
        assertEq(bobBefore - usdc.balanceOf(bob), spent, "pulled exactly usdcSpent");
        assertEq(platformFee, expPlatform, "platform = ceil(totalFee*50/(50+c))");
        assertEq(creatorFee, totalFee - expPlatform, "creator = the rest");
        assertEq(platformFee + creatorFee, spent - net, "fees sum exactly");
        assertEq(usdc.balanceOf(pad.pairOf(token)), uint256(c.virtualUsdc) + net - VIRTUAL_USDC_0, "seed = float + net");
        // Not in the trader's favour: the total fee is at least the proportional fee on what was paid
        assertGe((spent - net) * BPS, spent * feeBps);
        // The quote is the same path
        assertEq(qTokens, tokensOut);
        assertEq(qSpent, spent);
        assertEq(qPlatform, expPlatform);
        assertEq(qCreator, totalFee - expPlatform);
        assertTrue(pad.isGraduated(token));
        _assertSolvent();
    }

    function test_creatorFee_zeroEdge_reproducesTheV12Vectors() public {
        address token = _create(0, creatorWallet);
        vm.prank(alice);
        (uint256 tokensOut, uint256 spent) = pad.buy(token, 1_000_000_000_000, 0, alice, type(uint256).max);
        assertEq(tokensOut, CURVE_SUPPLY);
        assertEq(spent, 25125628109);
        assertEq(pad.pendingFees(), 125628141);
        assertEq(pad.pendingCreatorFees(token), 0);
        assertEq(usdc.balanceOf(pad.pairOf(token)), 24999999968);
    }

    function test_creatorFee_maxEdge() public {
        address token = _create(1000, creatorWallet);
        // 100 USDC buy: 0.5 USDC platform, 10 USDC creator, 89.5 net
        (uint256 qTokens, uint256 qPlatform, uint256 qCreator, uint256 qSpent,) = pad.quoteBuy(token, 100e6);
        assertEq(qPlatform, 500_000);
        assertEq(qCreator, 10_000_000);
        assertEq(qSpent, 100e6);
        vm.prank(alice);
        (uint256 tokensOut,) = pad.buy(token, 100e6, 0, alice, type(uint256).max);
        assertEq(tokensOut, qTokens);
        assertEq(pad.curves(token).virtualUsdc, VIRTUAL_USDC_0 + 89_500_000);
        assertEq(pad.pendingCreatorFees(token), 10_000_000);

        // The sell-out at 10.5% total: gross = net + ceil(net*1050/8950)
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 remaining = CURVE_SUPPLY - c.tokensSold;
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 net = _divCeil(k, uint256(c.virtualTokens) - remaining) - uint256(c.virtualUsdc);
        uint256 gross = net + _divCeil(net * 1050, 8950);
        vm.prank(bob);
        (, uint256 spent) = pad.buy(token, 1_000_000e6, 0, bob, type(uint256).max);
        assertEq(spent, gross);
        uint256 totalFee = gross - net;
        assertEq(pad.pendingCreatorFees(token), 10_000_000 + totalFee - _divCeil(totalFee * 50, 1050));
        _assertSolvent();
    }

    function test_creatorFee_aboveMaxReverts() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.CreatorFeeTooHigh.selector);
        pad.createToken("Greedy", "GRDY", "", 1001, alice, "", 0, 0, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.CreatorFeeTooHigh.selector);
        pad.createToken("Greedy", "GRDY", "", type(uint16).max, alice, "", 0, 0, type(uint256).max);
        vm.prank(alice);
        pad.createToken("Fair", "FAIR", "", 1000, alice, "", 0, 0, type(uint256).max); // the edge is allowed
    }

    function test_creatorFee_dustBuysAndSellsRevertCleanly() public {
        address token = _create(1000, creatorWallet);
        // usdcIn 2: 1 platform + 1 creator = everything → ZeroAmount, not a panic
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.quoteBuy(token, 2);
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.buy(token, 2, 0, alice, type(uint256).max);
        vm.prank(alice);
        (uint256 tokensOut,) = pad.buy(token, 100e6, 0, alice, type(uint256).max);
        // A sell grossing 1 or 2 units: the two rounded-up fees (1 + 1) eat it all → ZeroAmount, not an underflow
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 tokensIn = uint256(c.virtualTokens) * 3 / (2 * uint256(c.virtualUsdc));
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 gross = uint256(c.virtualUsdc) - _divCeil(k, uint256(c.virtualTokens) + tokensIn);
        assertTrue(gross == 1 || gross == 2, "grosses a unit or two");
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.quoteSell(token, tokensIn);
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.sell(token, tokensIn, 0, alice, type(uint256).max);
        assertGt(tokensOut, tokensIn);
    }

    function test_creatorsOwnFirstBuyPaysTheCreatorFee() public {
        vm.prank(alice);
        address token = pad.createToken("Mine", "MINE", "", 700, alice, "", 1_000e6, 0, type(uint256).max);
        assertEq(pad.pendingCreatorFees(token), _divCeil(1_000e6 * 700, BPS));
        assertEq(pad.pendingFees(), _divCeil(1_000e6 * 50, BPS));
    }

    function testFuzz_roundTripWithCreatorFeeNeverProfits(uint64 rawIn, uint16 rawBps) public {
        address token = _create(uint16(bound(rawBps, 0, 1000)), creatorWallet);
        uint256 usdcIn = bound(rawIn, 1e4, 5_000e6);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        (uint256 tokensOut,) = pad.buy(token, usdcIn, 0, alice, type(uint256).max);
        vm.prank(alice);
        try pad.sell(token, tokensOut, 0, alice, type(uint256).max) {} catch {}
        assertLe(usdc.balanceOf(alice), before, "a buy followed by a sell never returns more than was paid");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 2 — Accrual and collection (V13-SPEC §2.1)
    // ═══════════════════════════════════════════════════════════════════════════

    function _accrue(address token, uint256 usdcIn) internal returns (uint256 owed) {
        vm.prank(carol);
        pad.buy(token, usdcIn, 0, carol, type(uint256).max);
        owed = pad.pendingCreatorFees(token);
        assertGt(owed, 0);
    }

    function test_collect_eoaPluginGetsAPlainTransfer() public {
        address token = _create(500, creatorWallet);
        uint256 owed = _accrue(token, 1_000e6);
        vm.expectEmit(true, true, false, true, address(pad));
        emit CreatorFeesCollected(token, creatorWallet, owed);
        vm.prank(mallory); // permissionless
        assertEq(pad.collectCreatorFees(token), owed);
        assertEq(usdc.balanceOf(creatorWallet), owed);
        assertEq(pad.pendingCreatorFees(token), 0);
        assertEq(pad.collectCreatorFees(token), 0, "nothing left");
        _assertSolvent();
    }

    function test_collect_contractWithoutErc165GetsAPlainTransferAndNoHooks() public {
        HooklessRecorder wallet = new HooklessRecorder();
        vm.prank(alice);
        address token = pad.createToken("Safe", "SAFE", "", 300, address(wallet), "", 50e6, 0, type(uint256).max);
        uint256 owed = _accrue(token, 1_000e6);
        pad.collectCreatorFees(token);
        assertEq(usdc.balanceOf(address(wallet)), owed);
        assertEq(wallet.hookCalls(), 0, "neither onLaunch nor onFees is called");
        _assertSolvent();
    }

    function test_collect_lyingErc165IsTreatedAsAPlainAddress() public {
        LyingPlugin liar = new LyingPlugin();
        vm.prank(alice);
        address token = pad.createToken("Liar", "LIE", "", 300, address(liar), "", 0, 0, type(uint256).max);
        uint256 owed = _accrue(token, 1_000e6);
        pad.collectCreatorFees(token);
        assertEq(usdc.balanceOf(address(liar)), owed);
        assertEq(liar.hookCalls(), 0);
    }

    function test_collect_gasBurningErc165ProbeIsTreatedAsAPlainAddress() public {
        GasGuzzlerPlugin guzzler = new GasGuzzlerPlugin();
        vm.prank(alice);
        address token = pad.createToken("Guzzle", "GUZ", "", 300, address(guzzler), "", 10e6, 0, type(uint256).max);
        uint256 owed = _accrue(token, 1_000e6);
        pad.collectCreatorFees(token);
        assertEq(usdc.balanceOf(address(guzzler)), owed);
        assertEq(guzzler.hookCalls(), 0);
        _assertSolvent();
    }

    function test_collect_exactPullPluginWorks() public {
        ExactPlugin plugin = new ExactPlugin(pad);
        address token = _create(250, address(plugin));
        uint256 owed = _accrue(token, 2_000e6);
        uint256 padBefore = usdc.balanceOf(address(pad));
        assertEq(pad.collectCreatorFees(token), owed);
        assertEq(plugin.received(token), owed);
        assertEq(plugin.feeCalls(), 1);
        assertEq(usdc.balanceOf(address(plugin)), owed);
        assertEq(padBefore - usdc.balanceOf(address(pad)), owed);
        assertEq(usdc.allowance(address(pad), address(plugin)), 0, "no allowance left behind");
        _assertSolvent();
    }

    function test_collect_pullToAThirdPartyIsStillExact() public {
        MisbehavingPlugin plugin = new MisbehavingPlugin(IERC20(address(usdc)));
        plugin.setMode(MisbehavingPlugin.Mode.PullToThirdParty);
        address token = _create(250, address(plugin));
        uint256 owed = _accrue(token, 2_000e6);
        pad.collectCreatorFees(token);
        assertEq(usdc.balanceOf(plugin.THIRD_PARTY()), owed);
        _assertSolvent();
    }

    function _assertCollectionRevertsAndKeepsFees(MisbehavingPlugin.Mode mode, bytes memory expected) internal {
        MisbehavingPlugin plugin = new MisbehavingPlugin(IERC20(address(usdc)));
        address token = _create(400, address(plugin));
        uint256 owed = _accrue(token, 1_000e6);
        plugin.setMode(mode);
        uint256 padBefore = usdc.balanceOf(address(pad));
        if (expected.length == 0) vm.expectRevert();
        else vm.expectRevert(expected);
        pad.collectCreatorFees(token);
        assertEq(pad.pendingCreatorFees(token), owed, "fees stay accrued");
        assertEq(usdc.balanceOf(address(pad)), padBefore, "nothing left the launchpad");
        assertEq(usdc.allowance(address(pad), address(plugin)), 0);
        _assertSolvent();

        // Trading is unaffected by the broken plugin
        vm.prank(alice);
        (uint256 got,) = pad.buy(token, 100e6, 0, alice, type(uint256).max);
        vm.prank(alice);
        pad.sell(token, got, 0, alice, type(uint256).max);
        assertGt(pad.pendingCreatorFees(token), owed);

        // Fixing the plugin's behaviour lets the same fees through, exactly
        plugin.setMode(MisbehavingPlugin.Mode.Exact);
        uint256 all = pad.pendingCreatorFees(token);
        assertEq(pad.collectCreatorFees(token), all);
        assertEq(usdc.balanceOf(address(plugin)), all);
        _assertSolvent();
    }

    function test_collect_pluginPullingLessReverts() public {
        _assertCollectionRevertsAndKeepsFees(
            MisbehavingPlugin.Mode.PullLess, abi.encodeWithSelector(IArchitexLaunchpad.PluginPullMismatch.selector)
        );
    }

    function test_collect_pluginPullingNothingReverts() public {
        _assertCollectionRevertsAndKeepsFees(
            MisbehavingPlugin.Mode.PullNone, abi.encodeWithSelector(IArchitexLaunchpad.PluginPullMismatch.selector)
        );
    }

    function test_collect_pluginPullingMoreReverts() public {
        // USDC itself refuses: the allowance is exactly the amount
        _assertCollectionRevertsAndKeepsFees(MisbehavingPlugin.Mode.PullMore, "");
    }

    function test_collect_pluginRefundingPartOfThePullReverts() public {
        _assertCollectionRevertsAndKeepsFees(
            MisbehavingPlugin.Mode.PullThenRefundOne, abi.encodeWithSelector(IArchitexLaunchpad.PluginPullMismatch.selector)
        );
    }

    function test_collect_revertingPluginReverts() public {
        _assertCollectionRevertsAndKeepsFees(MisbehavingPlugin.Mode.Revert, bytes("plugin broken"));
    }

    function test_collect_blocklistedPlainPluginKeepsFeesAccrued() public {
        address token = _create(400, creatorWallet);
        uint256 owed = _accrue(token, 1_000e6);
        usdc.setBlocked(creatorWallet, true);
        vm.expectRevert(bytes("blocklisted"));
        pad.collectCreatorFees(token);
        assertEq(pad.pendingCreatorFees(token), owed);
        usdc.setBlocked(creatorWallet, false);
        assertEq(pad.collectCreatorFees(token), owed);
    }

    /// @dev V13-SPEC §6.3: a broken plugin never blocks a buy, a sell, a graduation or another token's collection.
    function test_brokenPluginNeverBlocksTradingGraduationOrOtherTokens() public {
        MisbehavingPlugin broken = new MisbehavingPlugin(IERC20(address(usdc)));
        broken.setMode(MisbehavingPlugin.Mode.Revert);
        ExactPlugin good = new ExactPlugin(pad);
        address bad = _create(1000, address(broken));
        address fine = _create(1000, address(good));

        // Trade both, collect the good one while the bad one is stuck
        vm.prank(alice);
        (uint256 got,) = pad.buy(bad, 500e6, 0, alice, type(uint256).max);
        vm.prank(alice);
        pad.sell(bad, got / 2, 0, alice, type(uint256).max);
        vm.prank(alice);
        pad.buy(fine, 500e6, 0, alice, type(uint256).max);
        vm.expectRevert(bytes("plugin broken"));
        pad.collectCreatorFees(bad);
        uint256 fineOwed = pad.pendingCreatorFees(fine);
        assertEq(pad.collectCreatorFees(fine), fineOwed);
        assertEq(good.received(fine), fineOwed);

        // The bad token graduates and trades in its pool regardless
        _graduate(bad);
        vm.prank(bob);
        router.buy(bad, 1_000e6, 0, bob, block.timestamp);
        vm.prank(bob);
        router.sell(bad, 1_000e18, 0, bob, block.timestamp);
        vm.expectRevert(bytes("plugin broken"));
        pad.collectCreatorFees(bad);
        assertGt(pad.pendingCreatorFees(bad), 0);
        _assertSolvent();
    }

    function test_collect_unknownTokenReverts() public {
        vm.expectRevert(IArchitexLaunchpad.UnknownToken.selector);
        pad.collectCreatorFees(address(0x1234));
    }

    function test_collect_zeroFeeTokenReturnsZero() public {
        address token = _create(0, creatorWallet);
        vm.prank(alice);
        pad.buy(token, 100e6, 0, alice, type(uint256).max);
        assertEq(pad.collectCreatorFees(token), 0);
    }

    function test_plugin_cannotBeZeroOrTheLaunchpad() public {
        vm.startPrank(alice);
        vm.expectRevert(IArchitexLaunchpad.InvalidPlugin.selector);
        pad.createToken("Zero", "ZERO", "", 100, address(0), "", 0, 0, type(uint256).max);
        vm.expectRevert(IArchitexLaunchpad.InvalidPlugin.selector);
        pad.createToken("Self", "SELF", "", 100, address(pad), "", 0, 0, type(uint256).max);
        vm.stopPrank();
    }

    function test_creatorFeesAccrueToTheirOwnTokenOnly() public {
        address a = _create(100, creatorWallet);
        address b = _create(900, alice);
        vm.prank(carol);
        pad.buy(a, 1_000e6, 0, carol, type(uint256).max);
        assertEq(pad.pendingCreatorFees(a), 1_000e6 * 100 / BPS);
        assertEq(pad.pendingCreatorFees(b), 0);
        vm.prank(carol);
        pad.buy(b, 1_000e6, 0, carol, type(uint256).max);
        assertEq(pad.pendingCreatorFees(a), 1_000e6 * 100 / BPS);
        assertEq(pad.pendingCreatorFees(b), 1_000e6 * 900 / BPS);
        _assertSolvent();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 3 — onLaunch
    // ═══════════════════════════════════════════════════════════════════════════

    function test_onLaunch_runsAfterRegistrationAndBeforeTheFirstBuy() public {
        ExactPlugin plugin = new ExactPlugin(pad);
        vm.prank(alice);
        address token = pad.createToken("Hooked", "HOOK", "", 300, address(plugin), hex"c0ffee", 500e6, 0, type(uint256).max);
        assertEq(plugin.launches(), 1);
        assertEq(plugin.lastToken(), token);
        assertEq(plugin.lastCreator(), alice);
        assertEq(plugin.lastData(), hex"c0ffee");
        assertTrue(plugin.curveRegisteredAtLaunch(), "the curve (plugin, creator, pair) was registered");
        assertEq(plugin.soldAtLaunch(), 0, "the first buy had not run");
        assertEq(plugin.creatorBalanceAtLaunch(), 0, "the creator held nothing yet");
        assertGt(IERC20(token).balanceOf(alice), 0, "then the first buy ran");
    }

    function test_onLaunch_revertRevertsTheLaunch() public {
        MisbehavingPlugin plugin = new MisbehavingPlugin(IERC20(address(usdc)));
        plugin.setRevertOnLaunch(true);
        uint256 before = pad.tokensLength();
        vm.prank(alice);
        vm.expectRevert(bytes("onLaunch refuses"));
        pad.createToken("No", "NO", "", 300, address(plugin), "", 0, 0, type(uint256).max);
        assertEq(pad.tokensLength(), before);
    }

    /// @dev A plugin that does not declare the interface gets no onLaunch, so it takes no pluginData: with empty data it
    ///      launches with no hooks, and any data reverts DataForNonPlugin (it would be dropped: a mistyped address).
    function test_onLaunch_skippedForPluginsThatDoNotDeclareTheInterface() public {
        HooklessRecorder hookless = new HooklessRecorder();
        LyingPlugin liar = new LyingPlugin();
        vm.startPrank(alice);
        pad.createToken("A", "A", "", 100, address(hookless), "", 10e6, 0, type(uint256).max);
        pad.createToken("B", "B", "", 100, address(liar), "", 10e6, 0, type(uint256).max);
        pad.createToken("C", "C", "", 100, bob, "", 10e6, 0, type(uint256).max); // an EOA
        vm.expectRevert(IArchitexLaunchpad.DataForNonPlugin.selector);
        pad.createToken("A", "A", "", 100, address(hookless), "data", 10e6, 0, type(uint256).max);
        vm.expectRevert(IArchitexLaunchpad.DataForNonPlugin.selector);
        pad.createToken("B", "B", "", 100, address(liar), "data", 10e6, 0, type(uint256).max);
        vm.expectRevert(IArchitexLaunchpad.DataForNonPlugin.selector);
        pad.createToken("C", "C", "", 100, bob, "data", 10e6, 0, type(uint256).max);
        vm.stopPrank();
        assertEq(hookless.hookCalls(), 0);
        assertEq(liar.hookCalls(), 0);
    }

    function test_tokenCreatedEvent() public {
        address predicted = vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
        address predictedPair = vm.computeCreateAddress(address(pairFactory), vm.getNonce(address(pairFactory)));
        vm.expectEmit(true, true, true, true, address(pad));
        emit TokenCreated(predicted, alice, creatorWallet, predictedPair, 420, "Evt", "EVT", "ipfs://e");
        vm.prank(alice);
        pad.createToken("Evt", "EVT", "ipfs://e", 420, creatorWallet, "", 0, 0, type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 4 — initialize
    // ═══════════════════════════════════════════════════════════════════════════

    function test_initialize_onceAndDeployerOnly() public {
        ArchitexLaunchpad p = new ArchitexLaunchpad(address(usdc), feeTo, setter, 0);
        LaunchPairFactory f = new LaunchPairFactory(address(p));
        LaunchRouter r = new LaunchRouter(address(p), address(f), address(usdc));

        // createToken reverts until initialize has run
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.NotInitialized.selector);
        p.createToken("Early", "EARLY", "", 0, alice, "", 0, 0, type(uint256).max);

        vm.prank(mallory);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        p.initialize(address(f), address(r));
        vm.prank(setter); // not even the fee admin
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        p.initialize(address(f), address(r));

        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        p.initialize(address(0), address(r));
        vm.expectRevert(IArchitexLaunchpad.ZeroAddress.selector);
        p.initialize(address(f), address(0));

        vm.expectEmit(true, true, false, false, address(p));
        emit Initialized(address(f), address(r));
        p.initialize(address(f), address(r));
        assertEq(p.pairFactory(), address(f));
        assertEq(p.router(), address(r));

        vm.expectRevert(IArchitexLaunchpad.AlreadyInitialized.selector);
        p.initialize(address(f), address(r));
        vm.prank(mallory);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        p.initialize(address(f), address(r));

        // and now it launches
        vm.startPrank(alice);
        usdc.approve(address(p), type(uint256).max);
        p.createToken("Now", "NOW", "", 0, alice, "", 1e6, 0, type(uint256).max);
        vm.stopPrank();
    }

    function test_initialize_refusesMiswiring() public {
        ArchitexLaunchpad p = new ArchitexLaunchpad(address(usdc), feeTo, setter, 0);
        LaunchPairFactory f = new LaunchPairFactory(address(p));
        LaunchRouter r = new LaunchRouter(address(p), address(f), address(usdc));

        // The suite's own factory and router belong to `pad`, not `p`
        vm.expectRevert(IArchitexLaunchpad.InvalidWiring.selector);
        p.initialize(address(pairFactory), address(r));
        vm.expectRevert(IArchitexLaunchpad.InvalidWiring.selector);
        p.initialize(address(f), address(router));
        // A router for p but a different factory for p
        LaunchPairFactory f2 = new LaunchPairFactory(address(p));
        vm.expectRevert(IArchitexLaunchpad.InvalidWiring.selector);
        p.initialize(address(f2), address(r));
        // Nothing was stored by the failed attempts
        assertEq(p.pairFactory(), address(0));
        assertEq(p.router(), address(0));
        p.initialize(address(f), address(r));
    }

    function test_routerAndFactoryRefuseMiswiring() public {
        vm.expectRevert(ILaunchPairFactory.ZeroAddress.selector);
        new LaunchPairFactory(address(0));
        vm.expectRevert(LaunchRouter.ZeroAddress.selector);
        new LaunchRouter(address(0), address(pairFactory), address(usdc));
        vm.expectRevert(LaunchRouter.InvalidWiring.selector);
        new LaunchRouter(address(pad), address(pairFactory), address(0xBEEF)); // wrong USDC
        ArchitexLaunchpad p = new ArchitexLaunchpad(address(usdc), feeTo, setter, 0);
        vm.expectRevert(LaunchRouter.InvalidWiring.selector);
        new LaunchRouter(address(p), address(pairFactory), address(usdc)); // factory of another launchpad
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 5 — Graduation into the launch pair, then trading through the router
    // ═══════════════════════════════════════════════════════════════════════════

    function test_graduation_seedsTheLaunchPairAndLocksTheLp() public {
        address token = _create(300, creatorWallet);
        LaunchPair pair = _pairOf(token);
        assertEq(pair.totalSupply(), 0);
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, type(uint256).max);
        (uint112 reserveToken, uint112 reserveUsdc,) = pair.getReserves();
        assertEq(reserveToken, POOL_SUPPLY);
        assertEq(reserveUsdc, usdc.balanceOf(address(pair)));
        assertEq(uint256(reserveUsdc), uint256(pad.curves(token).virtualUsdc) - VIRTUAL_USDC_0);
        assertEq(pair.balanceOf(DEAD), pair.totalSupply(), "all LP locked at DEAD");
        assertEq(IERC20(token).balanceOf(address(pad)), 0);
        _assertSolvent();
    }

    function test_router_buyAccruesFeesToTheRightToken() public {
        address a = _create(700, creatorWallet);
        address b = _create(100, alice);
        _graduate(a);
        _graduate(b);
        uint256 feesBefore = pad.pendingFees();
        uint256 aBefore = pad.pendingCreatorFees(a);
        uint256 bBefore = pad.pendingCreatorFees(b);
        (uint112 reserveToken, uint112 reserveUsdc,) = _pairOf(a).getReserves();

        uint256 usdcIn = 1_000e6;
        uint256 platformFee = _divCeil(usdcIn * FEE_BPS, BPS);
        uint256 creatorFee = _divCeil(usdcIn * 700, BPS);
        uint256 net = usdcIn - platformFee - creatorFee;
        uint256 expected = net * reserveToken / (uint256(reserveUsdc) + net);
        (uint256 qOut, uint256 qPlatform, uint256 qCreator) = router.quoteBuy(a, usdcIn);

        vm.expectEmit(true, false, false, true, address(pad));
        emit PoolFeesAccrued(a, platformFee, creatorFee);
        uint256 carolBefore = usdc.balanceOf(carol);
        vm.prank(carol);
        uint256 got = router.buy(a, usdcIn, expected, carol, block.timestamp);

        assertEq(got, expected);
        assertEq(qOut, got);
        assertEq(qPlatform, platformFee);
        assertEq(qCreator, creatorFee);
        assertEq(IERC20(a).balanceOf(carol), got);
        assertEq(carolBefore - usdc.balanceOf(carol), usdcIn);
        assertEq(pad.pendingFees() - feesBefore, platformFee);
        assertEq(pad.pendingCreatorFees(a) - aBefore, creatorFee, "the traded token's creator fees");
        assertEq(pad.pendingCreatorFees(b), bBefore, "another token's untouched");
        (uint112 reserveTokenAfter, uint112 reserveUsdcAfter,) = _pairOf(a).getReserves();
        assertEq(reserveUsdcAfter, reserveUsdc + net, "only the net reaches the pool");
        assertEq(reserveTokenAfter, reserveToken - got);
        _assertSolvent();
    }

    function test_router_sellNeedsNoApprovalAndPaysBothFees() public {
        address token = _create(1000, creatorWallet);
        _graduate(token);
        uint256 tokensIn = 1_000_000e18;
        assertEq(IERC20(token).allowance(bob, address(router)), 0);
        (uint112 reserveToken, uint112 reserveUsdc,) = _pairOf(token).getReserves();
        uint256 gross = tokensIn * reserveUsdc / (uint256(reserveToken) + tokensIn);
        uint256 platformFee = _divCeil(gross * FEE_BPS, BPS);
        uint256 creatorFee = _divCeil(gross * 1000, BPS);
        (uint256 qOut,,) = router.quoteSell(token, tokensIn);

        uint256 feesBefore = pad.pendingFees();
        uint256 creatorBefore = pad.pendingCreatorFees(token);
        uint256 bobUsdc = usdc.balanceOf(bob);
        uint256 bobTokens = IERC20(token).balanceOf(bob);
        vm.prank(bob);
        uint256 out = router.sell(token, tokensIn, 0, carol, block.timestamp); // USDC to carol

        assertEq(out, gross - platformFee - creatorFee);
        assertEq(out, qOut);
        assertEq(usdc.balanceOf(carol) - 100_000_000e6, out, "the recipient gets usdcOut");
        assertEq(usdc.balanceOf(bob), bobUsdc, "the seller pays nothing in USDC");
        assertEq(bobTokens - IERC20(token).balanceOf(bob), tokensIn, "tokens left the seller");
        assertEq(pad.pendingFees() - feesBefore, platformFee);
        assertEq(pad.pendingCreatorFees(token) - creatorBefore, creatorFee);
        assertEq(usdc.balanceOf(address(router)), 0, "the router keeps nothing");
        assertEq(IERC20(token).balanceOf(address(router)), 0);
        _assertSolvent();
    }

    function test_router_directSwapReverts() public {
        address token = _create(100, creatorWallet);
        _graduate(token);
        LaunchPair pair = _pairOf(token);
        vm.startPrank(bob);
        usdc.transfer(address(pair), 1_000e6);
        vm.expectRevert(ILaunchPair.OnlyRouter.selector);
        pair.swap(1e18, 0, bob);
        vm.stopPrank();
        vm.prank(address(pad));
        vm.expectRevert(ILaunchPair.OnlyRouter.selector);
        pair.swap(1e18, 0, bob);
    }

    function test_router_refusesUnknownUngraduatedExpiredAndSlippage() public {
        address token = _create(100, creatorWallet);
        vm.startPrank(bob);
        vm.expectRevert(ILaunchRouter.UnknownToken.selector);
        router.buy(address(0xBEEF), 1e6, 0, bob, block.timestamp);
        vm.expectRevert(ILaunchRouter.UnknownToken.selector);
        router.quoteSell(address(0xBEEF), 1e18);
        vm.expectRevert(ILaunchRouter.NotGraduated.selector);
        router.buy(token, 1e6, 0, bob, block.timestamp);
        vm.expectRevert(ILaunchRouter.NotGraduated.selector);
        router.quoteBuy(token, 1e6);
        vm.stopPrank();

        _graduate(token);
        vm.startPrank(bob);
        vm.expectRevert(ILaunchRouter.Expired.selector);
        router.buy(token, 1e6, 0, bob, block.timestamp - 1);
        vm.expectRevert(ILaunchRouter.Expired.selector);
        router.sell(token, 1e18, 0, bob, block.timestamp - 1);
        (uint256 out,,) = router.quoteBuy(token, 1e6);
        vm.expectRevert(ILaunchRouter.SlippageExceeded.selector);
        router.buy(token, 1e6, out + 1, bob, block.timestamp);
        (uint256 usdcOut,,) = router.quoteSell(token, 1e18);
        vm.expectRevert(ILaunchRouter.SlippageExceeded.selector);
        router.sell(token, 1e18, usdcOut + 1, bob, block.timestamp);
        vm.expectRevert(ILaunchRouter.ZeroAmount.selector);
        router.buy(token, 0, 0, bob, block.timestamp);
        vm.expectRevert(ILaunchRouter.ZeroAmount.selector);
        router.buy(token, 2, 0, bob, block.timestamp); // both fees eat it
        vm.expectRevert(ILaunchRouter.ZeroAmount.selector);
        router.sell(token, 0, 0, bob, block.timestamp);
        vm.expectRevert(ILaunchRouter.ZeroAmount.selector);
        router.sell(token, 1, 0, bob, block.timestamp); // grosses nothing
        vm.stopPrank();
    }

    function test_accrueTradeFees_routerOnly() public {
        address token = _create(100, creatorWallet);
        vm.prank(mallory);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        pad.accrueTradeFees(token, 1, 1);
        vm.prank(address(router));
        vm.expectRevert(IArchitexLaunchpad.NotGraduated.selector);
        pad.accrueTradeFees(token, 1, 1);
        vm.prank(address(router));
        vm.expectRevert(IArchitexLaunchpad.UnknownToken.selector);
        pad.accrueTradeFees(address(0xBEEF), 1, 1);
        // Before initialize nobody is the router (not even the deployer)
        ArchitexLaunchpad p = new ArchitexLaunchpad(address(usdc), feeTo, setter, 0);
        vm.expectRevert(IArchitexLaunchpad.Forbidden.selector);
        p.accrueTradeFees(token, 1, 1);
    }

    function testFuzz_poolRoundTripNeverProfits(uint64 rawIn, uint16 rawBps) public {
        address token = _create(uint16(bound(rawBps, 0, 1000)), creatorWallet);
        _graduate(token);
        uint256 usdcIn = bound(rawIn, 1e3, 50_000e6);
        uint256 before = usdc.balanceOf(carol);
        vm.prank(carol);
        uint256 got = router.buy(token, usdcIn, 0, carol, block.timestamp);
        vm.prank(carol);
        try router.sell(token, got, 0, carol, block.timestamp) {} catch {}
        assertLe(usdc.balanceOf(carol), before, "a pool round trip never profits");
        _assertSolvent();
    }

    function test_graduatedPoolKeepsPayingCreatorFeesToThePlugin() public {
        ExactPlugin plugin = new ExactPlugin(pad);
        address token = _create(500, address(plugin));
        _graduate(token);
        pad.collectCreatorFees(token);
        uint256 curveFees = plugin.received(token);
        vm.prank(carol);
        router.buy(token, 10_000e6, 0, carol, block.timestamp);
        uint256 poolFees = pad.pendingCreatorFees(token);
        assertEq(poolFees, _divCeil(10_000e6 * 500, BPS));
        pad.collectCreatorFees(token);
        assertEq(plugin.received(token), curveFees + poolFees);
        _assertSolvent();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 6 — Views return zero values for unknown tokens (plugins rely on this)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_liteViews() public {
        address unknown = address(0xBEEF);
        assertEq(pad.pluginOf(unknown), address(0));
        assertEq(pad.creatorOf(unknown), address(0));
        assertEq(pad.creatorFeeBpsOf(unknown), 0);
        assertEq(pad.pairOf(unknown), address(0));
        assertFalse(pad.isGraduated(unknown));
        assertEq(pad.virtualUsdcOf(unknown), 0);
        assertEq(pad.pendingCreatorFees(unknown), 0);

        vm.prank(alice);
        address token = pad.createToken("V", "V", "", 333, bob, "", 0, 0, type(uint256).max);
        assertEq(pad.pluginOf(token), bob);
        assertEq(pad.creatorOf(token), alice);
        assertEq(pad.creatorFeeBpsOf(token), 333);
        assertEq(pad.pairOf(token), pairFactory.getPair(token));
        assertFalse(pad.isGraduated(token));
        assertEq(pad.virtualUsdcOf(token), VIRTUAL_USDC_0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 7 — Requirements from the plugins build
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Hook-or-plain is decided once at launch: a plugin that stops declaring the interface (an upgraded proxy)
    ///      is still paid through onFees, so every unit it receives is credited to the token.
    function test_hookDecisionIsStored_pluginThatStopsDeclaringStillGetsOnFees() public {
        FlippablePlugin plugin = new FlippablePlugin(IERC20(address(usdc)), true);
        address token = _create(500, address(plugin));
        assertTrue(pad.curves(token).pluginHooks);
        assertEq(plugin.launches(), 1);
        uint256 owed = _accrue(token, 1_000e6);
        plugin.setDeclares(false);
        pad.collectCreatorFees(token);
        assertEq(plugin.feeCalls(), 1, "still paid through onFees");
        assertEq(plugin.credited(token), owed, "and credited to the token");
        assertEq(usdc.balanceOf(address(plugin)), owed);
        _assertSolvent();
    }

    /// @dev ...and a plain address that starts declaring later stays plain: it never had onLaunch for this token, so
    ///      onFees would refuse it and strand the fees.
    function test_hookDecisionIsStored_plainAddressThatStartsDeclaringStaysPlain() public {
        FlippablePlugin plugin = new FlippablePlugin(IERC20(address(usdc)), false);
        address token = _create(500, address(plugin));
        assertFalse(pad.curves(token).pluginHooks);
        assertEq(plugin.launches(), 0, "no onLaunch for a plain address");
        uint256 owed = _accrue(token, 1_000e6);
        plugin.setDeclares(true);
        pad.collectCreatorFees(token);
        assertEq(plugin.feeCalls(), 0, "no onFees without onLaunch");
        assertEq(usdc.balanceOf(address(plugin)), owed, "a plain transfer");
        _assertSolvent();
    }

    function test_pluginHooksFlagPerKindOfPlugin() public {
        assertFalse(pad.curves(_create(100, creatorWallet)).pluginHooks, "EOA");
        assertTrue(pad.curves(_create(100, address(new ExactPlugin(pad)))).pluginHooks, "ERC-165 plugin");
        assertFalse(pad.curves(_create(100, address(new HooklessRecorder()))).pluginHooks, "no ERC-165");
        assertFalse(pad.curves(_create(100, address(new LyingPlugin()))).pluginHooks, "claims 0xffffffff");
        assertFalse(pad.curves(_create(100, address(new GasGuzzlerPlugin()))).pluginHooks, "probe runs out of gas");
    }

    /// @dev onLaunch gets all remaining gas: a configuration as heavy as a full Combo (~1.3M) plus a sell-out first buy
    ///      and graduation fit in one 5M-gas transaction.
    function test_heavyOnLaunchWithASellOutFirstBuyFitsIn5MGas() public {
        HeavyLaunchPlugin heavy = new HeavyLaunchPlugin(60); // 60 fresh storage slots: ~1.33M gas
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        address token = pad.createToken{gas: 5_000_000}("Heavy", "HVY", "", 1000, address(heavy), "", 30_000e6, 0, type(uint256).max);
        uint256 used = gasBefore - gasleft();
        emit log_named_uint("gas: create + 1.3M onLaunch + sell-out + graduation", used);
        assertTrue(pad.isGraduated(token));
        assertEq(heavy.store(59), 60, "the whole configuration was written");
        assertGt(heavy.gasAtLaunch(), 1_400_000, "onLaunch had room to spare");
        _assertSolvent();
    }

    function test_buy_pullsExactlyUsdcSpentAndDeliversToTo() public {
        address token = _create(300, creatorWallet);
        // A normal buy: bob pays, carol receives
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        (uint256 out, uint256 spent) = pad.buy(token, 500e6, 0, carol, type(uint256).max);
        assertEq(spent, 500e6);
        assertEq(bobBefore - usdc.balanceOf(bob), spent);
        assertEq(IERC20(token).balanceOf(carol), out);
        assertEq(IERC20(token).balanceOf(bob), 0);
        // The sell-out buy: offered far more than needed, pulls exactly usdcSpent, delivers the remainder to carol
        uint256 remaining = CURVE_SUPPLY - pad.curves(token).tokensSold;
        bobBefore = usdc.balanceOf(bob);
        uint256 carolBefore = IERC20(token).balanceOf(carol);
        vm.prank(bob);
        (out, spent) = pad.buy(token, 1_000_000e6, 0, carol, type(uint256).max);
        assertEq(out, remaining, "the true tokensOut");
        assertLt(spent, 1_000_000e6);
        assertEq(bobBefore - usdc.balanceOf(bob), spent, "pulled exactly what it returned");
        assertEq(IERC20(token).balanceOf(carol) - carolBefore, out);
        assertTrue(pad.isGraduated(token), "graduated inside the sell-out buy");
        _assertSolvent();
    }

    function test_router_buyIsExactInAndDeliversToTo() public {
        address token = _create(300, creatorWallet);
        _graduate(token);
        (uint256 quoted,,) = router.quoteBuy(token, 100e6);
        uint256 carolUsdc = usdc.balanceOf(carol);
        vm.prank(carol);
        uint256 got = router.buy(token, 100e6, quoted, mallory, block.timestamp);
        assertEq(got, quoted);
        assertEq(IERC20(token).balanceOf(mallory), got, "delivered to `to`");
        assertEq(IERC20(token).balanceOf(carol), 0);
        assertEq(carolUsdc - usdc.balanceOf(carol), 100e6, "exact in: all of usdcIn and nothing more");
        (uint112 reserveToken, uint112 reserveUsdc, uint32 ts) = _pairOf(token).getReserves();
        assertEq(reserveToken, IERC20(token).balanceOf(pad.pairOf(token)), "getReserves: token first");
        assertEq(reserveUsdc, usdc.balanceOf(pad.pairOf(token)), "then USDC");
        assertEq(ts, uint32(block.timestamp));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // 8 — End to end: a Distribute-to-holders plugin pays holders through the token
    // ═══════════════════════════════════════════════════════════════════════════

    function test_distributePluginEndToEnd() public {
        DistributePlugin plugin = new DistributePlugin(IERC20(address(usdc)));
        address token = _create(1000, address(plugin));
        vm.prank(alice);
        pad.buy(token, 3_000e6, 0, alice, type(uint256).max);
        vm.prank(bob);
        pad.buy(token, 1_000e6, 0, bob, type(uint256).max);
        uint256 owed = pad.pendingCreatorFees(token);
        pad.collectCreatorFees(token);
        ILaunchToken t = ILaunchToken(token);
        assertEq(t.totalDistributed(), owed);
        uint256 a = t.claimable(alice);
        uint256 b = t.claimable(bob);
        assertLe(a + b, owed);
        assertApproxEqAbs(a + b, owed, 2);
        // pro-rata to balances
        assertApproxEqRel(a * IERC20(token).balanceOf(bob), b * IERC20(token).balanceOf(alice), 1e12);
        assertEq(t.claimable(address(pad)), 0, "the curve inventory never earns");
        vm.prank(mallory);
        assertEq(t.claimFor(alice), a, "anyone can claim for a holder");
        assertEq(usdc.balanceOf(alice), 100_000_000e6 - 3_000e6 + a);
        _assertSolvent();
    }
}

/// @notice The creator's cap on the launch fee: the admin can raise the fee, but not above what a pending launch agreed to.
contract LaunchFeeGuardTest is LaunchpadV13Base {
    function setUp() public override {
        super.setUp();
        vm.prank(setter);
        pad.setLaunchFee(5e6);
    }

    function test_createToken_revertsWhenLaunchFeeRaisedAboveTheCreatorsMax() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.LaunchFeeAboveMax.selector);
        pad.createToken("Coin", "COIN", "ipfs://x", 0, alice, "", 0, 0, 1e6);
    }

    function test_createToken_chargesExactlyTheCurrentFeeWhenWithinTheMax() public {
        uint256 before = usdc.balanceOf(alice);
        uint256 pendingBefore = pad.pendingFees();
        vm.prank(alice);
        pad.createToken("Coin", "COIN", "ipfs://x", 0, alice, "", 0, 0, 5e6);
        assertEq(before - usdc.balanceOf(alice), 5e6);
        assertEq(pad.pendingFees() - pendingBefore, 5e6);
    }

    function test_createToken_zeroMaxWorksOnlyWhileTheFeeIsZero() public {
        vm.prank(setter);
        pad.setLaunchFee(0);
        vm.prank(alice);
        pad.createToken("Coin", "COIN", "ipfs://x", 0, alice, "", 0, 0, 0);

        vm.prank(setter);
        pad.setLaunchFee(1);
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.LaunchFeeAboveMax.selector);
        pad.createToken("Coin2", "COIN2", "ipfs://y", 0, alice, "", 0, 0, 0);
    }

    function testFuzz_createToken_neverChargesAboveTheMax(uint96 fee, uint96 maxFee) public {
        fee = uint96(bound(fee, 0, pad.MAX_LAUNCH_FEE()));
        vm.prank(setter);
        pad.setLaunchFee(fee);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        if (fee > maxFee) {
            vm.expectRevert(IArchitexLaunchpad.LaunchFeeAboveMax.selector);
            pad.createToken("Coin", "COIN", "ipfs://x", 0, alice, "", 0, 0, maxFee);
        } else {
            pad.createToken("Coin", "COIN", "ipfs://x", 0, alice, "", 0, 0, maxFee);
            assertLe(before - usdc.balanceOf(alice), maxFee);
        }
    }
}
