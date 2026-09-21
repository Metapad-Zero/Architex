// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 5: Distribute to holders, dripped over 24 hours, with the real LaunchToken dividends (V13-SPEC §2.2,
///         §3, [D15], [D21]). Only properties of the stream window are asserted, never exact end times or partial
///         amounts (the window math on a new delivery is still being tuned): nothing of a delivery is released in the
///         transaction that delivers it; everything delivered is releasable a DRIP_PERIOD after the last delivery;
///         releases never exceed deliveries; delivered == distributed + unreleased; holders' claims sum to what was
///         distributed, to rounding dust; excluded addresses never earn. "Everything is out by the end" is asserted
///         with a keeper dripping hourly (KEEPER_INTERVAL): the latest plugin pauses a stream nobody drips (a release
///         covers at most MAX_CATCH_UP of stream time), so these tests hold for both the committed drip (c508af3) and
///         that version.
contract HolderDripE2ETest is E2EBase {
    E2ESniper internal sniper;

    function setUp() public override {
        super.setUp();
        sniper = new E2ESniper();
        _trackUsdc(address(sniper));
        usdc.mint(address(sniper), 10_000_000e6);
    }

    /// @dev A checked collection to the Holder plugin: only what the running stream owed by now is released (to the
    ///      holders of this moment), nothing of the new fees; the window ends after now and within a period.
    function _deliver(address token) internal returns (uint256 amount) {
        uint256 oldDue = holder.releasable(token);
        uint256 unreleasedBefore = holder.unreleased(token);
        uint256 distributedBefore = holder.totalDistributed(token);
        amount = _collect(token);
        if (amount == 0) return 0;
        assertEq(holder.totalDistributed(token) - distributedBefore, oldDue, "a delivery releases only the old stream's due");
        assertEq(holder.unreleased(token), unreleasedBefore - oldDue + amount);
        assertEq(holder.releasable(token), 0, "nothing of a delivery is released in the delivering transaction");
        assertEq(holder.lastDrip(token), _now());
        assertGt(holder.streamEnd(token), _now(), "the window ends after now");
        assertLe(holder.streamEnd(token), _now() + PERIOD, "and within one period");
    }

    function _assertStreamConserved(address token) internal view {
        assertEq(
            holder.unreleased(token) + holder.totalDistributed(token),
            ghostDelivered[token] + ghostDonated[token],
            "delivered == distributed + unreleased"
        );
        assertGe(usdc.balanceOf(address(holder)), holder.unreleased(token));
    }

    /// @dev What `who` should be able to claim from one distribution of `amount` at eligible supply `eligible`.
    function _share(uint256 amount, uint256 bal, uint256 eligible) internal pure returns (uint256) {
        return amount * bal / eligible;
    }

    // ─── Holders earn pro-rata once delivered and dripped ─────────────────────

    function test_holders_earnProRata_onceDeliveredAndDripped() public {
        address token = _launch(Kind.Holder, 1000, 3_000e6); // alice, the creator, holds from her first buy
        _curveBuy(bob, token, 5_000e6);
        _curveBuy(carol, token, 1_000e6);
        _curveBuy(dave, token, 2_000e6);
        _curveSell(dave, token, IERC20(token).balanceOf(dave)); // dave leaves before anything is distributed

        uint256 amount = _deliver(token);
        assertEq(ILaunchToken(token).totalDistributed(), 0, "delivered, not distributed");
        _assertStreamConserved(token);

        // Dripped hourly: part-way through, part of it is out, never more than delivered...
        _dripEvery(token, 6 hours);
        uint256 partOut = holder.totalDistributed(token);
        assertGt(partOut, 0);
        assertLt(partOut, amount);
        // ...and a period after the delivery, everything.
        _dripEvery(token, PERIOD - 6 hours);
        assertEq(holder.unreleased(token), 0, "everything out a period after the delivery");
        uint256 eligible = ILaunchToken(token).eligibleSupply();
        assertEq(eligible, IERC20(token).balanceOf(alice) + IERC20(token).balanceOf(bob) + IERC20(token).balanceOf(carol));

        ILaunchToken lt = ILaunchToken(token);
        assertApproxEqAbs(lt.claimable(alice), _share(amount, IERC20(token).balanceOf(alice), eligible), 1, "alice pro-rata");
        assertApproxEqAbs(lt.claimable(bob), _share(amount, IERC20(token).balanceOf(bob), eligible), 1, "bob pro-rata");
        assertApproxEqAbs(lt.claimable(carol), _share(amount, IERC20(token).balanceOf(carol), eligible), 1, "carol pro-rata");
        assertEq(lt.claimable(dave), 0, "sold before the distribution: nothing");
        assertLe(lt.claimable(alice) + lt.claimable(bob) + lt.claimable(carol), amount);

        _claim(token, alice);
        vm.prank(mallory);
        uint256 paid = lt.claimFor(bob); // anyone can claim for a holder; the holder is paid
        assertGt(paid, 0);
        vm.prank(carol);
        (uint256 released, uint256 claimed) = holder.dripAndClaim(token);
        assertEq(released, 0);
        assertGt(claimed, 0);
        _assertSystem();
    }

    // ─── Excluded addresses never earn ────────────────────────────────────────

    function test_holders_excludedAddressesNeverEarn_acrossGraduation() public {
        address token = _launch(Kind.Holder, 500, 1_000e6);
        _curveBuy(bob, token, 8_000e6);
        vm.prank(bob);
        IERC20(token).transfer(DEAD, 1_000_000e18); // tokens sent to the burn address stop earning
        ILaunchToken lt = ILaunchToken(token);
        assertEq(lt.eligibleSupply(), _eligible(token));

        _deliver(token);
        _warp(PERIOD);
        _drip(token);
        // The curve inventory (most of the supply right now), the pair, the burn address and address(0) earn nothing.
        assertGt(IERC20(token).balanceOf(address(pad)), 0);
        assertEq(lt.claimable(address(pad)), 0);
        assertEq(lt.claimable(pad.pairOf(token)), 0);
        assertEq(lt.claimable(DEAD), 0);
        assertEq(lt.claimable(address(0)), 0);
        assertApproxEqAbs(lt.claimable(alice) + lt.claimable(bob), holder.totalDistributed(token), 2, "all to real holders");

        // After graduation the pair holds POOL_SUPPLY and more; it still earns nothing.
        _graduateVia(carol, token);
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        _deliver(token);
        _warp(PERIOD);
        _drip(token);
        assertGt(IERC20(token).balanceOf(pad.pairOf(token)), POOL_SUPPLY);
        assertEq(lt.claimable(pad.pairOf(token)), 0);
        assertEq(lt.claimable(address(pad)), 0);
        assertEq(lt.claimable(DEAD), 0);
        assertTrue(lt.isExcluded(address(pad)) && lt.isExcluded(pad.pairOf(token)) && lt.isExcluded(DEAD));
        assertFalse(lt.isExcluded(address(router)) || lt.isExcluded(address(holder)));
        _assertSystem();
    }

    // ─── The one-transaction bot ──────────────────────────────────────────────

    /// @dev A pile of creator fees waits at the launchpad and no stream is running. A bot buys a large position,
    ///      collects the pile to the plugin, drips and claims, and sells, all in one transaction: it gets nothing of
    ///      the pile (or of its own trades' fees) and loses its round-trip fees. The holders who stay get it all.
    function test_holders_sniperInOneTransaction_getsNothing_onCurve() public {
        address token = _launch(Kind.Holder, 1000, 2_000e6);
        _curveBuy(bob, token, 6_000e6);
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 4);
        uint256 pile = pad.pendingCreatorFees(token);
        assertGt(pile, 700e6);
        uint256 usdcBefore = usdc.balanceOf(address(sniper));

        (uint256 bought, uint256 collected, uint256 released, uint256 claimed) =
            sniper.curveAttack(pad, holder, token, 10_000e6);
        _addHolder(token, address(sniper));
        _syncGhostsAfterSniper(token, collected);

        assertEq(released, 0, "nothing was streaming: nothing to release");
        assertEq(claimed, 0, "the bot got none of the fees delivered in its transaction");
        assertGt(collected, pile, "the pile plus the bot's own buy fee was delivered");
        assertEq(IERC20(token).balanceOf(address(sniper)), 0, "and it sold everything");
        assertGt(bought, 0);
        assertLt(usdc.balanceOf(address(sniper)), usdcBefore, "a pure loss: two rounds of fees");
        assertEq(holder.unreleased(token), collected, "the whole delivery streams");

        _dripEvery(token, PERIOD + KEEPER_INTERVAL);
        ILaunchToken lt = ILaunchToken(token);
        assertEq(lt.claimable(address(sniper)), 0, "no later share either: it no longer holds");
        assertApproxEqAbs(lt.claimable(alice) + lt.claimable(bob), collected, 2, "the holders who stayed get it all");
        _collect(token); // the bot's sell fee
        _assertSystem();
    }

    /// @dev The same bot in the launch pool, through the router.
    function test_holders_sniperInOneTransaction_getsNothing_inPool() public {
        address token = _launch(Kind.Holder, 800, 1_000e6);
        _curveBuy(bob, token, 5_000e6);
        _graduateVia(carol, token);
        _poolBuy(dave, token, 20_000e6);
        uint256 pile = pad.pendingCreatorFees(token);
        uint256 usdcBefore = usdc.balanceOf(address(sniper));

        (, uint256 collected, uint256 released, uint256 claimed) =
            sniper.poolAttack(pad, router, holder, token, 50_000e6);
        _addHolder(token, address(sniper));
        _syncGhostsAfterSniper(token, collected);

        assertEq(released, 0);
        assertEq(claimed, 0, "none of the fees delivered in its transaction");
        assertGt(collected, pile);
        assertLt(usdc.balanceOf(address(sniper)), usdcBefore);
        _warp(PERIOD);
        _drip(token);
        assertEq(ILaunchToken(token).claimable(address(sniper)), 0);
        _collect(token);
        _assertSystem();
    }

    /// @dev With a stream running, the collection in the bot's transaction first releases what the old stream owes
    ///      since its last drip, to whoever holds at that moment, the bot included (documented). Here one minute of
    ///      the old stream: the bot's claim is at most its pro-rata share of that, and none of the new pile.
    function test_holders_sniperWithARunningStream_sharesOnlyWhatMaturedBefore() public {
        address token = _launch(Kind.Holder, 1000, 2_000e6);
        _curveBuy(bob, token, 6_000e6);
        _deliver(token);
        _warp(12 hours);
        _drip(token); // a keeper drips
        _warp(1 minutes);
        _curveBuy(carol, token, 5_000e6);
        _curveSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        uint256 pile = pad.pendingCreatorFees(token);
        uint256 oldDue = holder.releasable(token);
        assertGt(oldDue, 0);
        uint256 eligibleBefore = ILaunchToken(token).eligibleSupply();

        (uint256 bought, uint256 collected,, uint256 claimed) = sniper.curveAttack(pad, holder, token, 3_000e6);
        _addHolder(token, address(sniper));
        _syncGhostsAfterSniper(token, collected);

        assertLe(claimed, oldDue * bought / (eligibleBefore + bought) + 1, "at most its share of what had matured");
        assertLt(claimed * 1000, pile, "and nothing like the pile");
        assertGt(collected, pile);
        _assertSystem();
    }

    /// @dev Keeps the fee ghosts in step with what the bot's transaction did through the real contracts: its buy's fees
    ///      were accrued then collected inside the attack, its sell's fees are pending.
    function _syncGhostsAfterSniper(address token, uint256 collected) internal {
        ghostDelivered[token] += collected;
        ghostCreatorAccrued[token] = ghostDelivered[token] + pad.pendingCreatorFees(token);
        ghostPlatformAccrued = ghostPlatformCollected + pad.pendingFees();
    }

    /// @dev DOCUMENTED LIMIT (IHolderDistributionPlugin NatSpec): a release goes to whoever holds at that moment, so a
    ///      bot that buys, triggers a release, claims and sells in one transaction shares what that one release
    ///      covers. Asserted as: the bot's claim is exactly its pro-rata share of releasable() just before it, and none
    ///      of the fees delivered in its transaction. How much that is after a day nobody dripped depends on the
    ///      version: all of the matured stream with the committed drip (c508af3), at most MAX_CATCH_UP (an hour) of
    ///      stream time with the latest; the log shows which.
    function test_holders_justInTimeBuyerSharesOnlyWhatOneReleaseCovers() public {
        address token = _launch(Kind.Holder, 1000, 2_000e6);
        _curveBuy(bob, token, 6_000e6);
        uint256 amount = _deliver(token);
        _warp(PERIOD + 1 hours); // nobody drips for a day
        uint256 due = holder.releasable(token);
        assertLe(due, amount);
        uint256 eligibleBefore = ILaunchToken(token).eligibleSupply();
        (uint256 bought, uint256 collected, uint256 released, uint256 claimed) =
            sniper.curveAttack(pad, holder, token, 5_000e6);
        _addHolder(token, address(sniper));
        _syncGhostsAfterSniper(token, collected);
        assertEq(released, 0, "the collection inside the attack already made the one release");
        assertApproxEqAbs(claimed, due * bought / (eligibleBefore + bought), 1, "exactly its share of that release");
        assertGt(claimed, 0);
        console2.log("share of an idle day's stream one release hands out (bps):", due * BPS / amount);
        _assertSystem();
    }

    // ─── Deliveries over time ─────────────────────────────────────────────────

    /// @dev Deliveries at different times, a keeper dripping hourly through the gaps. At every step: releases never
    ///      exceed deliveries and delivered == distributed + unreleased. After the last delivery the end lies within a
    ///      period, regular drips never move it, and everything is out by it.
    function test_holders_deliveriesOverTime_allOutByTheEnd() public {
        address token = _launch(Kind.Holder, 600, 1_000e6);
        uint64[5] memory gaps = [uint64(0), 3 hours, 7 hours, 30 minutes, 20 hours];
        uint256 lastDelivery;
        for (uint256 i; i < gaps.length; ++i) {
            _dripEvery(token, gaps[i]);
            _buy(i % 2 == 0 ? bob : carol, token, 1_500e6 + i * 111e6);
            if (i == 2) _curveSell(bob, token, IERC20(token).balanceOf(bob) / 3);
            _deliver(token);
            lastDelivery = _now();
            _assertStreamConserved(token);
            assertLe(holder.totalDistributed(token), ghostDelivered[token], "releases never exceed deliveries");
        }
        uint256 end = holder.streamEnd(token);
        assertLe(end, lastDelivery + PERIOD, "ends within a period of the last delivery");
        while (_now() + KEEPER_INTERVAL < end) {
            _warp(KEEPER_INTERVAL);
            _drip(token);
            assertEq(holder.streamEnd(token), end, "regular drips never move the end");
            assertGt(holder.unreleased(token), 0, "not all out before the end");
            _assertStreamConserved(token);
        }
        vm.warp(end);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(holder.releasable(token), holder.unreleased(token), "all due at streamEnd");
        _drip(token);
        assertEq(holder.unreleased(token), 0);
        assertEq(holder.totalDistributed(token), ghostDelivered[token]);
        _assertSystem();
    }

    /// @dev A holder who sells keeps what they earned while holding and earns nothing afterwards.
    function test_holders_sellerKeepsWhatTheyEarned() public {
        address token = _launch(Kind.Holder, 1000, 2_000e6);
        _curveBuy(dave, token, 4_000e6);
        _deliver(token);
        _warp(PERIOD);
        _drip(token);
        uint256 earned = ILaunchToken(token).claimable(dave);
        assertGt(earned, 0);
        _curveSell(dave, token, IERC20(token).balanceOf(dave));
        _curveBuy(bob, token, 3_000e6);
        _deliver(token);
        _warp(PERIOD);
        _drip(token);
        assertEq(ILaunchToken(token).claimable(dave), earned, "kept, and nothing more");
        assertEq(_claim(token, dave), earned);
        _assertSystem();
    }

    /// @dev Without eligible supply nothing is released; what matured goes out once there are holders (documented).
    function test_holders_noEligibleSupply_holdsUntilThereAreHolders() public {
        address token = _launch(Kind.Holder, 1000, 0);
        _curveBuy(bob, token, 3_000e6);
        _curveSell(bob, token, IERC20(token).balanceOf(bob));
        assertEq(ILaunchToken(token).eligibleSupply(), 0, "everything is back in the curve inventory");
        uint256 amount = _deliver(token);
        _warp(PERIOD);
        assertEq(holder.releasable(token), 0);
        assertEq(_drip(token), 0);
        assertEq(holder.unreleased(token), amount, "held, not lost");
        _curveBuy(carol, token, 1_000e6);
        _dripEvery(token, PERIOD + KEEPER_INTERVAL);
        assertEq(holder.unreleased(token), 0, "out once there are holders and someone drips");
        _collect(token);
        _assertSystem();
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev Random trades, deliveries, drips, claims and gaps (up to 9 hours, so an idle stream may pause), on both
    ///      sides of graduation. The stream properties hold at every step; after a last delivery and a period of hourly
    ///      drips, everything has gone to holders.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_holders_dripConservation(uint256 seed, uint16 bpsRaw) public {
        uint16 bps = uint16(bound(bpsRaw, 100, 1000));
        address token = _launch(Kind.Holder, bps, 1_000e6);
        address[4] memory traders = [bob, carol, dave, erin];
        for (uint256 i; i < 16; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address who = traders[r % 4];
            uint256 action = (r >> 8) % 6;
            if (action == 0 || action == 1) {
                _buy(who, token, bound(r >> 16, 10e6, 6_000e6));
            } else if (action == 2) {
                uint256 bal = IERC20(token).balanceOf(who);
                if (bal > 1e21) _sell(who, token, bal / 2);
            } else if (action == 3) {
                _deliver(token);
            } else if (action == 4) {
                _drip(token);
            } else {
                vm.prank(who);
                holder.dripAndClaim(token);
            }
            assertLe(holder.totalDistributed(token), ghostDelivered[token], "never more out than in");
            _assertStreamConserved(token);
            _warp(bound(r >> 128, 0, 9 hours));
        }
        _deliver(token);
        if (holder.unreleased(token) != 0) {
            assertLe(holder.streamEnd(token), holder.lastDrip(token) + PERIOD, "the end is within a period of lastDrip");
        }
        // Dripped hourly from here, everything is out within a period (the end is never more than a period past the
        // last release or delivery).
        _dripEvery(token, PERIOD + KEEPER_INTERVAL);
        if (ILaunchToken(token).eligibleSupply() != 0) {
            assertEq(holder.unreleased(token), 0, "all out a period later, dripped hourly");
        }
        _assertSystem();
    }
}
