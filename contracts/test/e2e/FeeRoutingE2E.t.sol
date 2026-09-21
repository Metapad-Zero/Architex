// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 1: fee routing per plugin, on the curve and in the launch pool (V13-SPEC §1, §2.1, §4, §5).
///         Every buy and sell pays 0.5% platform + the token's creator fee, both from the USDC side and rounded up;
///         platform fees reach feeTo; creator fees accrue per token and each collection delivers exactly them to the
///         plugin through onFees (or by plain transfer to an address that does not declare the hooks).
contract FeeRoutingE2ETest is E2EBase {
    /// @dev One trading life, the same for every plugin: the creator's first buy, curve buys and sells (one of 7 USDC
    ///      units, where rounding up shows), collections, the graduating exact-fill buy, pool buys and sells through
    ///      the router, collections, platform-fee collections. Every trade and collection is checked by the helpers.
    function _lifecycle(Kind kind, uint16 bps) internal returns (address token) {
        token = _launch(kind, bps, 500e6);
        _curveBuy(bob, token, 1_000e6);
        _curveBuy(carol, token, 2_345_678_901);
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 2);
        _collect(token);
        _collectFees();
        _curveBuy(dave, token, 7);
        _curveSell(carol, token, IERC20(token).balanceOf(carol) / 3);
        _collect(token);
        _collect(token); // a second collection finds nothing and calls nothing

        // The graduating buy: its creator fee is pending at graduation and still goes to this token's plugin.
        uint256 before = pad.pendingCreatorFees(token);
        _graduateVia(erin, token);
        if (bps != 0) assertGt(pad.pendingCreatorFees(token), before, "the graduating buy paid a creator fee");
        _collect(token);
        _collectFees();

        _poolBuy(frank, token, 3_000e6);
        _poolSell(bob, token, IERC20(token).balanceOf(bob));
        _poolBuy(bob, token, 12_345_679);
        _poolSell(erin, token, IERC20(token).balanceOf(erin) / 4);
        _poolBuy(dave, token, 1_000); // small: fees rounded up
        _collect(token);
        _collectFees();
        _assertSystem();
    }

    function _expectHooks(address token, bool hooks) internal view {
        assertEq(pad.curves(token).pluginHooks, hooks, "hooks decided once, at launch");
    }

    // ─── Each destination ─────────────────────────────────────────────────────

    function test_feeRouting_creatorWalletEoa() public {
        address token = _lifecycle(Kind.Eoa, 250);
        _expectHooks(token, false);
        assertEq(usdc.balanceOf(creatorWallet), ghostDelivered[token], "the wallet got every creator fee by transfer");
        assertGt(ghostDelivered[token], 0);
    }

    function test_feeRouting_creatorIsTheirOwnWallet() public {
        // The default "Creator wallet": the creator names themselves, and trades too.
        address token = _launchWith(alice, 900, alice, "", 1_000e6);
        _curveBuy(bob, token, 4_000e6);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 owed = pad.pendingCreatorFees(token);
        _collect(token);
        assertEq(usdc.balanceOf(alice) - aliceBefore, owed);
        _graduateVia(carol, token);
        _poolSell(alice, token, IERC20(token).balanceOf(alice));
        _collect(token);
        _assertSystem();
    }

    function test_feeRouting_plainContractWithoutErc165() public {
        address token = _lifecycle(Kind.Plain, 300);
        _expectHooks(token, false);
        assertEq(plainWallet.calls(), 0, "no onLaunch, no onFees: plain transfers only");
        assertEq(usdc.balanceOf(address(plainWallet)), ghostDelivered[token]);
    }

    function test_feeRouting_safeLikeWallet() public {
        address token = _lifecycle(Kind.SafeLike, 700);
        _expectHooks(token, false);
        assertEq(safeWallet.calls(), 0, "answers ERC-165 for other interfaces only: no hooks");
        assertEq(usdc.balanceOf(address(safeWallet)), ghostDelivered[token]);
    }

    function test_feeRouting_split() public {
        address token = _lifecycle(Kind.Split, 500);
        _expectHooks(token, true);
        assertEq(split.totalReceived(token), ghostDelivered[token]);
    }

    function test_feeRouting_buyback() public {
        address token = _lifecycle(Kind.Buyback, 400);
        _expectHooks(token, true);
        assertEq(buyback.usdcHeld(token), ghostDelivered[token]);
    }

    function test_feeRouting_holders() public {
        address token = _lifecycle(Kind.Holder, 600);
        _expectHooks(token, true);
        // Every unit went straight into the token's stream; all in one block, so none of it has been earned yet.
        assertEq(ILaunchToken(token).totalDistributed(), ghostDelivered[token]);
        assertEq(holder.usdcHeld(token), 0);
        assertEq(usdc.balanceOf(address(holder)), 0);
        assertEq(_claimableSum(token), 0, "nothing earned in the delivering block");
        assertApproxEqAbs(ILaunchToken(token).undistributed(), ghostDelivered[token], 1, "all of it still to stream");
    }

    function test_feeRouting_combo() public {
        address token = _lifecycle(Kind.Combo, 800);
        _expectHooks(token, true);
        uint256 delivered = ghostDelivered[token];
        assertEq(
            ghostSlice[token][address(split)] + ghostSlice[token][address(buyback)] + ghostSlice[token][address(holder)]
                + ghostSlice[token][creatorWallet],
            delivered
        );
        assertEq(usdc.balanceOf(creatorWallet), ghostSlice[token][creatorWallet], "the plain entry, by transfer");
    }

    // ─── The creator-fee edges ────────────────────────────────────────────────

    /// @dev creatorFeeBps 0: no trade accrues a creator fee, and collecting never calls or pays the plugin.
    function test_feeRouting_zeroCreatorFee_everyPlugin() public {
        for (uint256 k; k <= uint256(Kind.Combo); ++k) {
            address token = _lifecycle(Kind(k), 0);
            assertEq(ghostCreatorAccrued[token], 0, _kindName(Kind(k)));
            assertEq(ghostDelivered[token], 0, _kindName(Kind(k)));
        }
        assertEq(usdc.balanceOf(address(split)) + usdc.balanceOf(address(buyback)) + usdc.balanceOf(address(holder)), 0);
        assertEq(usdc.balanceOf(creatorWallet), 0);
        assertEq(usdc.balanceOf(address(plainWallet)) + usdc.balanceOf(address(safeWallet)), 0);
    }

    /// @dev creatorFeeBps 1000 (10%, the maximum) on every plugin.
    function test_feeRouting_maxCreatorFee_everyPlugin() public {
        for (uint256 k; k <= uint256(Kind.Combo); ++k) {
            address token = _lifecycle(Kind(k), 1000);
            assertGt(ghostDelivered[token], 0, _kindName(Kind(k)));
            assertEq(pad.pendingCreatorFees(token), 0);
        }
    }

    /// @dev Two tokens on the same plugin trade in the same block: creator fees accrue and collect per token only.
    function test_feeRouting_feesNeverCrossTokens() public {
        address a = _launch(Kind.Split, 100, 0);
        address b = _launch(Kind.Split, 1000, 0);
        _curveBuy(bob, a, 5_000e6);
        uint256 aOwed = pad.pendingCreatorFees(a);
        assertEq(pad.pendingCreatorFees(b), 0, "b untouched by a's trade");
        _curveBuy(bob, b, 5_000e6);
        assertEq(pad.pendingCreatorFees(a), aOwed, "a untouched by b's trade");
        _collect(b);
        assertEq(pad.pendingCreatorFees(a), aOwed, "collecting b leaves a pending");
        assertEq(split.totalReceived(a), 0);
        _collect(a);
        assertEq(split.totalReceived(a), aOwed);
        _assertSystem();
    }

    // ─── Curve deadlines (V13-SPEC §5 [review]) ────────────────────────────────

    /// @dev A curve buy or sell mined after its deadline reverts Expired and changes nothing; at the deadline it runs.
    ///      (Every curve trade in these tests passes the tightest deadline, the block's own time.)
    function test_curveDeadlines_aDelayedTradeExpiresAndChangesNothing() public {
        address token = _launch(Kind.Split, 500, 1_000e6);
        uint256 signedAt = _now();
        _warp(10 minutes); // mined late
        uint256 pending = pad.pendingFees();
        uint256 creatorPending = pad.pendingCreatorFees(token);
        uint256 vUsdc = pad.virtualUsdcOf(token);
        vm.startPrank(alice);
        vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        pad.buy(token, 1_000e6, 0, alice, signedAt);
        vm.expectRevert(IArchitexLaunchpad.Expired.selector);
        pad.sell(token, 1_000e18, 0, alice, signedAt);
        vm.stopPrank();
        assertEq(pad.pendingFees(), pending);
        assertEq(pad.pendingCreatorFees(token), creatorPending);
        assertEq(pad.virtualUsdcOf(token), vUsdc);
        _curveBuy(bob, token, 500e6); // deadline == now: fine
        _curveSell(bob, token, IERC20(token).balanceOf(bob));
        _assertSystem();
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    function _sellableOnCurve(address token, uint256 tokensIn) internal view returns (bool) {
        if (tokensIn == 0 || tokensIn > pad.curves(token).tokensSold) return false;
        IArchitexLaunchpad.Curve memory c = pad.curves(token);
        uint256 k = uint256(c.virtualUsdc) * uint256(c.virtualTokens);
        uint256 gross = uint256(c.virtualUsdc) - _divCeil(k, uint256(c.virtualTokens) + tokensIn);
        return _divCeil(gross * FEE_BPS, BPS) + _divCeil(gross * c.creatorFeeBps, BPS) < gross;
    }

    function _sellableInPool(address token, uint256 tokensIn) internal view returns (bool) {
        if (tokensIn == 0) return false;
        (uint256 rt, uint256 ru) = _reserves(token);
        uint256 gross = tokensIn * ru / (rt + tokensIn);
        return _divCeil(gross * FEE_BPS, BPS) + _divCeil(gross * pad.creatorFeeBpsOf(token), BPS) < gross;
    }

    /// @dev Any plugin, any creator fee, random trade sizes on both sides of graduation.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_feeRouting(
        uint8 kindRaw,
        uint16 bpsRaw,
        uint64 firstBuy,
        uint64 curveIn,
        uint96 curveSellRaw,
        uint64 poolIn,
        uint96 poolSellRaw
    ) public {
        Kind kind = Kind(bound(kindRaw, 0, uint256(Kind.Combo)));
        uint16 bps = uint16(bound(bpsRaw, 0, 1000));
        uint256 first = bound(firstBuy, 0, 5_000e6);
        if (first < 3) first = 0; // 1-2 units are all fees: createToken would (rightly) revert ZeroAmount
        address token = _launch(kind, bps, first);

        _curveBuy(bob, token, bound(curveIn, 3, 15_000e6));
        uint256 toSell = bound(curveSellRaw, 1, IERC20(token).balanceOf(bob));
        if (_sellableOnCurve(token, toSell)) _curveSell(bob, token, toSell);
        _collect(token);

        _graduateVia(carol, token);
        _collect(token);

        _poolBuy(dave, token, bound(poolIn, 1_000, 50_000e6));
        toSell = bound(poolSellRaw, 1, IERC20(token).balanceOf(carol));
        if (_sellableInPool(token, toSell)) _poolSell(carol, token, toSell);
        _collect(token);
        _collectFees();
        _assertSystem();
    }
}
