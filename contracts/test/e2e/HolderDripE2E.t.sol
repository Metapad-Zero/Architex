// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 5: Distribute to holders with the real LaunchToken dividend stream (V13-SPEC §2.2, §3, [D15], [D21]).
///         The Holders plugin forwards each collection into the token's distribute, which pays it out continuously
///         over DRIP_PERIOD; each eligible account earns second by second in proportion to what it holds.
///
///         The main check is an independent model of the ideal stream: over every interval between balance changes,
///         a holder earns amount * dt * balance / (DRIP_PERIOD * eligibleSupply), and nothing while eligible supply is
///         under one token (the stream pauses and its end moves out). The token's claimable + claimed must equal the
///         model to a unit. _assertSystem() adds conservation: distributed == Σ claimed + Σ claimable + undistributed
///         + dust, the dust at most a unit per holder.
contract HolderDripE2ETest is E2EBase {
    E2ESniper internal sniper;

    // ─── The ideal-stream model (one delivery into an empty stream) ───────────
    address internal mToken;
    uint256 internal mAmount; // what was delivered
    uint256 internal mLast; // the model's clock
    uint256 internal mLeft; // stream seconds still to run; counts down only while somebody holds
    address[] internal mHolders;
    mapping(address => uint256) internal mIdeal; // earned, scaled by 1e18

    function setUp() public override {
        super.setUp();
        sniper = new E2ESniper();
        _trackUsdc(address(sniper));
        usdc.mint(address(sniper), 10_000_000e6);
    }

    // ─── Model ────────────────────────────────────────────────────────────────

    function _modelStart(address token, uint256 amount, address[] memory holders) internal {
        mToken = token;
        mAmount = amount;
        mLast = _now();
        mLeft = PERIOD;
        for (uint256 i; i < holders.length; ++i) {
            mHolders.push(holders[i]);
            mIdeal[holders[i]] = 0;
        }
        for (uint256 i; i < holders.length; ++i) {
            // Nothing earned from this stream yet: whatever a holder could claim before was from earlier ones.
            assertEq(ILaunchToken(token).claimable(holders[i]) + ILaunchToken(token).claimed(holders[i]), 0);
        }
    }

    /// @dev Brings the model up to now with the balances and eligible supply that held since its last step. Call it
    ///      before every balance change (every trade, transfer or burn) and before every check.
    function _modelAccrue() internal {
        uint256 t = _now();
        if (t <= mLast) return;
        uint256 dt = t - mLast;
        mLast = t;
        uint256 e = ILaunchToken(mToken).eligibleSupply();
        if (e == 0 || mLeft == 0) return; // paused (the stream waits) or run out
        if (dt > mLeft) dt = mLeft;
        mLeft -= dt;
        for (uint256 i; i < mHolders.length; ++i) {
            uint256 bal = IERC20(mToken).balanceOf(mHolders[i]);
            mIdeal[mHolders[i]] += (mAmount * dt * bal * 1e18) / (PERIOD * e);
        }
    }

    /// @dev Every modelled holder has earned exactly its time-weighted share, to a unit.
    function _assertModel() internal {
        _modelAccrue();
        ILaunchToken lt = ILaunchToken(mToken);
        uint256 total;
        for (uint256 i; i < mHolders.length; ++i) {
            address h = mHolders[i];
            uint256 earned = lt.claimable(h) + lt.claimed(h);
            assertApproxEqAbs(earned, mIdeal[h] / 1e18, 1, "time-weighted share, exact to rounding");
            total += earned;
        }
        assertLe(total, mAmount, "never more than was delivered");
    }

    // ─── Delivery ─────────────────────────────────────────────────────────────

    /// @dev A checked collection to the Holders plugin: everything goes straight into the token's stream, the plugin
    ///      keeps nothing, and nobody earns any of it in the delivering block.
    function _deliver(address token) internal returns (uint256 amount) {
        ILaunchToken lt = ILaunchToken(token);
        uint256 distributedBefore = lt.totalDistributed();
        uint256 claimableBefore = _claimableSum(token);
        uint256 owedBefore = lt.undistributed();
        amount = _collect(token);
        assertEq(lt.totalDistributed() - distributedBefore, amount, "all of it into the token's distribute");
        assertEq(holder.totalDistributed(token), lt.totalDistributed());
        assertEq(usdc.balanceOf(address(holder)), 0, "the plugin keeps nothing");
        assertEq(_claimableSum(token), claimableBefore, "nothing of a delivery is earned in the delivering block");
        if (amount == 0) return 0;
        assertEq(lt.lastAccrual(), _now());
        assertGt(lt.streamEnd(), _now(), "the stream runs on");
        assertLe(lt.streamEnd(), _now() + PERIOD, "for at most a period");
        assertApproxEqAbs(lt.undistributed(), owedBefore + amount, 2, "what it owes grew by the delivery");
    }

    // ─── Time-weighted shares ─────────────────────────────────────────────────

    /// @dev Holders join and leave at different times, by curve buys and sells, a transfer and a mid-stream claim;
    ///      the stream runs past its end. Each earns exactly its time-weighted share.
    function test_holders_timeWeightedShares_exactToRounding() public {
        address token = _launch(Kind.Holder, 1000, 0);
        _curveBuy(bob, token, 4_000e6);
        _curveBuy(carol, token, 1_500e6);
        uint256 amount = _deliver(token);
        assertGt(amount, 500e6);
        _modelStart(token, amount, _addrs(bob, carol, dave, erin, frank));

        _warp(5 hours);
        _modelAccrue();
        _curveBuy(dave, token, 3_000e6); // dave joins

        _warp(3 hours);
        _modelAccrue();
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 2); // bob halves

        _warp(2 hours);
        _modelAccrue();
        uint256 carolBal = IERC20(token).balanceOf(carol);
        vm.prank(carol);
        IERC20(token).transfer(erin, carolBal); // carol leaves, erin joins, by transfer
        _addHolder(token, erin);

        _warp(4 hours);
        _assertModel();
        _claim(token, dave); // a mid-stream claim changes nothing about what is earned

        _warp(6 hours);
        _modelAccrue();
        _curveSell(dave, token, IERC20(token).balanceOf(dave)); // dave leaves

        _warp(1 hours);
        _modelAccrue();
        _curveBuy(frank, token, 2_000e6); // frank joins for the last hours

        _warp(5 hours); // 26 h: past the end
        _assertModel();
        assertEq(ILaunchToken(token).undistributed(), 0);
        _finishStream(token);
        _assertSystem();
    }

    /// @dev A holder who sells keeps what they earned and earns nothing afterwards; one who buys late earns only from
    ///      then on.
    function test_holders_sellerKeepsWhatTheyEarned_lateBuyerEarnsFromThenOn() public {
        address token = _launch(Kind.Holder, 1000, 2_000e6);
        _curveBuy(dave, token, 4_000e6);
        uint256 amount = _deliver(token);
        _modelStart(token, amount, _addrs(alice, dave, erin));
        _warp(10 hours);
        _modelAccrue();
        uint256 earned = ILaunchToken(token).claimable(dave);
        assertGt(earned, 0);
        _curveSell(dave, token, IERC20(token).balanceOf(dave));
        _curveBuy(erin, token, 4_000e6);
        assertEq(ILaunchToken(token).claimable(erin), 0, "no backlog for a new buyer");
        _warp(20 hours);
        _assertModel();
        assertEq(ILaunchToken(token).claimable(dave), earned, "kept, and nothing more");
        assertEq(_claim(token, dave), earned);
        _assertSystem();
    }

    // ─── Pause and resume ─────────────────────────────────────────────────────

    /// @dev Everyone sells: eligible supply drops to 0 and the stream pauses; nothing accrues and nothing is lost.
    ///      The next buyer restarts it, with the end moved out by exactly the paused time, and earns from then on
    ///      only; no backlog built up for them.
    function test_holders_pauseWhenEveryoneSells_resumeWithTheEndShifted() public {
        address token = _launch(Kind.Holder, 1000, 0);
        _curveBuy(bob, token, 5_000e6);
        uint256 amount = _deliver(token);
        uint256 end0 = ILaunchToken(token).streamEnd();
        assertEq(end0, _now() + PERIOD, "a first stream runs exactly DRIP_PERIOD");
        _modelStart(token, amount, _addrs(bob, carol));

        _warp(6 hours);
        _modelAccrue();
        _curveSell(bob, token, IERC20(token).balanceOf(bob)); // everyone sold
        ILaunchToken lt = ILaunchToken(token);
        assertEq(lt.eligibleSupply(), 0);
        uint256 bobEarned = lt.claimable(bob);
        uint256 owed = lt.undistributed();
        assertApproxEqAbs(bobEarned, amount / 4, 1, "a quarter of the stream in 6 hours");
        uint256 pausedAt = _now();

        _warp(30 hours); // paused
        _modelAccrue();
        assertEq(lt.claimable(bob), bobEarned, "nothing accrues while paused");
        assertEq(lt.undistributed(), owed, "and nothing is lost");

        _curveBuy(carol, token, 1_000e6); // the stream resumes
        assertEq(lt.streamEnd(), end0 + (_now() - pausedAt), "the end moved out by exactly the paused time");
        assertEq(lt.claimable(carol), 0, "no backlog for whoever buys next");
        assertEq(lt.undistributed(), owed);

        _warp(1);
        assertApproxEqAbs(lt.claimable(carol), amount / PERIOD, 1, "one second of stream");
        _warp(lt.streamEnd() - _now() + 1);
        _assertModel(); // carol got the rest, bob his quarter
        assertApproxEqAbs(lt.claimable(carol), amount - bobEarned, 2);
        _finishStream(token);
        _assertSystem();
    }

    // ─── The one-transaction bot ──────────────────────────────────────────────

    /// @dev Keeps the fee ghosts in step with what the bot's transaction did through the real contracts: its buy's fees
    ///      were accrued then collected inside the attack, its sell's fees are pending.
    function _syncGhostsAfterSniper(address token, uint256 collected) internal {
        ghostDelivered[token] += collected;
        ghostCreatorAccrued[token] = ghostDelivered[token] + pad.pendingCreatorFees(token);
        ghostPlatformAccrued = ghostPlatformCollected + pad.pendingFees();
        _addHolder(token, address(sniper));
    }

    /// @dev The smallest USDC buy that gets at least one whole token.
    function _usdcForOneToken(address token) internal view returns (uint256 usdcIn) {
        usdcIn = 3;
        while (true) {
            uint256 out;
            if (pad.isGraduated(token)) {
                (out,,) = router.quoteBuy(token, usdcIn);
            } else {
                (out,,,,) = pad.quoteBuy(token, usdcIn);
            }
            if (out >= 1e18) return usdcIn;
            usdcIn += usdcIn / 4 + 1;
        }
    }

    function _snipe(address token, uint256 usdcIn) internal returns (uint256 collected, uint256 claimed) {
        uint256 before = usdc.balanceOf(address(sniper));
        uint256 bought;
        if (pad.isGraduated(token)) (bought, collected, claimed) = sniper.poolAttack(pad, router, token, usdcIn);
        else (bought, collected, claimed) = sniper.curveAttack(pad, token, usdcIn);
        _syncGhostsAfterSniper(token, collected);
        assertGe(bought, 1e18, "held at least a whole token for the transaction");
        assertEq(claimed, 0, "a buy, collect, claim and sell in one transaction earns exactly 0");
        assertEq(IERC20(token).balanceOf(address(sniper)), 0, "and it sold everything");
        assertEq(ILaunchToken(token).claimable(address(sniper)), 0);
        assertLt(usdc.balanceOf(address(sniper)), before, "a pure loss: two rounds of fees");
    }

    function test_holders_sniper_earnsZero_onCurve() public {
        address token = _launch(Kind.Holder, 1000, 2_000e6);
        _curveBuy(bob, token, 6_000e6);
        _deliver(token);
        _warp(10 hours);
        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 4);
        uint256 pile = pad.pendingCreatorFees(token);
        (uint256 collected,) = _snipe(token, 10_000e6);
        assertGt(collected, pile, "the pile plus the bot's own buy fee went into the stream");
        _warp(1 hours);
        assertEq(ILaunchToken(token).claimable(address(sniper)), 0, "nothing later either: it holds nothing");
        _finishStream(token);
        _assertSystem();
    }

    function test_holders_sniper_earnsZero_inPool() public {
        address token = _launch(Kind.Holder, 800, 1_000e6);
        _curveBuy(bob, token, 5_000e6);
        _deliver(token);
        _graduateVia(carol, token);
        _poolBuy(dave, token, 20_000e6);
        _warp(30 hours); // the first stream fully matured, nobody claimed
        _snipe(token, 50_000e6);
        _finishStream(token);
        _assertSystem();
    }

    /// @dev "Everyone sold, a day passes, buy 1 token": the stream is paused with most of it still owed. A bot buys
    ///      one whole token, collects, claims and sells in one transaction: exactly 0. Nothing built up while paused.
    function test_holders_sniper_everyoneSoldADayPassesBuyOneToken() public {
        address token = _launch(Kind.Holder, 1000, 0);
        _curveBuy(bob, token, 5_000e6);
        _curveBuy(carol, token, 2_000e6);
        _deliver(token);
        _warp(3 hours);
        _curveSell(bob, token, IERC20(token).balanceOf(bob));
        _curveSell(carol, token, IERC20(token).balanceOf(carol));
        assertEq(ILaunchToken(token).eligibleSupply(), 0, "everyone sold");
        uint256 owed = ILaunchToken(token).undistributed();
        _warp(1 days);
        assertEq(ILaunchToken(token).undistributed(), owed, "paused: all still owed");
        _snipe(token, _usdcForOneToken(token));
        assertEq(ILaunchToken(token).eligibleSupply(), 0, "and it sold again");
        _assertSystem();
    }

    /// @dev Any idle gap, any matured amount, any creator fee, a running, matured or paused stream, on the curve or in
    ///      the pool: the one-transaction bot earns exactly 0.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_holders_oneTransactionSnipeEarnsExactlyZero(
        uint16 bpsRaw,
        uint64 volumeRaw,
        uint32 gapRaw,
        uint64 sizeRaw,
        uint8 mode,
        bool inPool
    ) public {
        uint16 bps = uint16(bound(bpsRaw, 50, 1000));
        address token = _launch(Kind.Holder, bps, 0);
        _curveBuy(bob, token, bound(volumeRaw, 10e6, 9_000e6));
        _curveBuy(carol, token, 1_000e6);
        if (inPool) _graduateVia(dave, token);
        if (mode % 3 != 0) _deliver(token); // a stream is running
        _warp(bound(gapRaw, 0, 3 days)); // matures, partly or fully
        if (mode % 3 == 2) {
            // everyone sells: paused
            _sell(bob, token, IERC20(token).balanceOf(bob));
            _sell(carol, token, IERC20(token).balanceOf(carol));
            if (inPool) _sell(dave, token, IERC20(token).balanceOf(dave));
            _warp(1 days);
        }
        uint256 size = mode % 3 == 2 ? _usdcForOneToken(token) : bound(sizeRaw, 1e6, pad.isGraduated(token) ? 60_000e6 : 5_000e6);
        _snipe(token, size);
        _assertSystem();
    }

    // ─── Graduation with a running stream ─────────────────────────────────────

    /// @dev The stream runs through graduation: the pool seeding moves POOL_SUPPLY between two excluded accounts (the
    ///      curve inventory and the pair), so eligible supply is untouched; the pool and the curve inventory never
    ///      earn; every holder still earns exactly its time-weighted share, across the curve and the pool.
    function test_holders_graduationWithARunningStream() public {
        address token = _launch(Kind.Holder, 800, 1_000e6);
        _curveBuy(bob, token, 6_000e6);
        uint256 amount = _deliver(token);
        _modelStart(token, amount, _addrs(alice, bob, carol, dave, erin));

        _warp(4 hours);
        _modelAccrue();
        _curveBuy(carol, token, 2_000e6);
        _warp(3 hours);
        _modelAccrue();
        uint256 eligibleBefore = ILaunchToken(token).eligibleSupply();
        (uint256 lastTokens,) = _graduateVia(dave, token);
        assertEq(ILaunchToken(token).eligibleSupply(), eligibleBefore + lastTokens, "only the buyer's tokens became eligible");
        assertEq(IERC20(token).balanceOf(pad.pairOf(token)), POOL_SUPPLY);

        _warp(2 hours);
        _modelAccrue();
        _poolBuy(erin, token, 5_000e6);
        _warp(5 hours);
        _modelAccrue();
        _poolSell(bob, token, IERC20(token).balanceOf(bob) / 2);
        _warp(12 hours); // past the end
        _assertModel();

        ILaunchToken lt = ILaunchToken(token);
        assertGt(IERC20(token).balanceOf(pad.pairOf(token)), POOL_SUPPLY);
        assertEq(lt.claimable(pad.pairOf(token)), 0, "the pool never earns");
        assertEq(lt.claimable(address(pad)), 0, "the curve inventory never earns");
        assertEq(lt.claimable(DEAD), 0);
        _finishStream(token);
        _assertSystem();
    }

    // ─── Excluded accounts, burns, the forwarder ──────────────────────────────

    /// @dev Tokens sent to the burn address and tokens burned stop earning; the curve inventory, the pair, the burn
    ///      address and address(0) never earn; the rest still goes to the holders, exactly by time and balance.
    function test_holders_excludedAddressesAndBurnsNeverEarn() public {
        address token = _launch(Kind.Holder, 500, 1_000e6);
        _curveBuy(bob, token, 8_000e6);
        uint256 amount = _deliver(token);
        _modelStart(token, amount, _addrs(alice, bob));
        _warp(6 hours);
        _modelAccrue();
        vm.prank(bob);
        IERC20(token).transfer(DEAD, 10_000_000e18);
        _warp(6 hours);
        _modelAccrue();
        uint256 burnt = IERC20(token).balanceOf(alice) / 2;
        vm.prank(alice);
        ILaunchToken(token).burn(burnt);
        assertEq(ILaunchToken(token).eligibleSupply(), _eligible(token));
        _warp(13 hours);
        _assertModel();
        ILaunchToken lt = ILaunchToken(token);
        assertEq(lt.claimable(address(pad)) + lt.claimable(pad.pairOf(token)) + lt.claimable(DEAD) + lt.claimable(address(0)), 0);
        assertTrue(lt.isExcluded(address(pad)) && lt.isExcluded(pad.pairOf(token)) && lt.isExcluded(DEAD));
        assertFalse(lt.isExcluded(address(router)) || lt.isExcluded(address(holder)));
        _finishStream(token);
        _assertSystem();
    }

    /// @dev The plugin forwards every collection in the same call and holds nothing; a delivery while nobody holds
    ///      does not revert (onFees never reverts holder-side): the stream waits, paused, for the first holder.
    function test_holders_pluginIsAForwarder_evenWithNoHolders() public {
        address token = _launch(Kind.Holder, 1000, 0);
        _curveBuy(bob, token, 3_000e6);
        _curveSell(bob, token, IERC20(token).balanceOf(bob));
        assertEq(ILaunchToken(token).eligibleSupply(), 0);
        uint256 owed = pad.pendingCreatorFees(token);
        uint256 amount = _deliver(token); // checks the whole amount went into the token's distribute
        assertEq(amount, owed);
        assertEq(holder.totalDistributed(token), owed);
        assertEq(holder.usdcHeld(token), 0);
        _warp(3 days);
        assertApproxEqAbs(ILaunchToken(token).undistributed(), amount, 1, "waiting, not lost");
        _curveBuy(carol, token, 1_000e6);
        assertEq(ILaunchToken(token).claimable(carol), 0);
        _finishStream(token);
        assertApproxEqAbs(ILaunchToken(token).claimable(carol), amount, 1, "the first holder gets it, over time");
        _assertSystem();
    }

    // ─── Conservation, fuzzed ─────────────────────────────────────────────────

    /// @dev Random trades, deliveries (several, into a running stream), transfers, burns, claims and gaps, across
    ///      graduation. After every step: distributed == Σ claimed + Σ claimable + undistributed + dust (in
    ///      _assertSystem). At the end, past the stream's end, everything distributed reached holders.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_holders_streamConservation(uint256 seed, uint16 bpsRaw) public {
        address token = _launch(Kind.Holder, uint16(bound(bpsRaw, 100, 1000)), 1_000e6);
        address[4] memory traders = [bob, carol, dave, erin];
        for (uint256 i; i < 18; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address who = traders[r % 4];
            uint256 action = (r >> 8) % 8;
            uint256 bal = IERC20(token).balanceOf(who);
            if (action <= 1) {
                _buy(who, token, bound(r >> 16, 10e6, 6_000e6));
            } else if (action == 2) {
                if (bal > 1e21) _sell(who, token, bal / 2);
            } else if (action == 3) {
                _deliver(token);
            } else if (action == 4) {
                if (ILaunchToken(token).claimable(who) != 0) _claim(token, who);
            } else if (action == 5 && bal > 1e21) {
                address to = traders[(r >> 16) % 4];
                vm.prank(who);
                IERC20(token).transfer(to, bal / 3);
                _addHolder(token, to);
            } else if (action == 6 && bal > 1e21) {
                vm.prank(who);
                ILaunchToken(token).burn(bal / 5);
            } else if (action == 7 && !pad.isGraduated(token)) {
                _graduateVia(who, token);
            }
            _assertSystem();
            _warp(bound(r >> 128, 0, 10 hours));
        }
        _deliver(token);
        if (ILaunchToken(token).eligibleSupply() == 0) _buy(frank, token, 1_000e6);
        _finishStream(token);
        _assertSystem();
    }
}
