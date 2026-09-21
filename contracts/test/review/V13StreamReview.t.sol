// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../launchpad/LaunchpadV13Base.sol";

/// @notice Review (v1.3 dividend stream), isolated token: this contract deploys it, so it is the token's launchpad.
///         Reads the private stream state through storage (slot 6 per-share, 10 rate, 11 {eligible, lastAccrual, end}).
contract V13StreamReviewTest is Test {
    uint256 constant TOTAL = 1_000_000_000e18;
    uint256 constant D = 24 hours;
    uint256 constant MAG = 2 ** 128;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    BlockableUSDC usdc;
    LaunchToken token;
    address router = makeAddr("router");
    address pair = makeAddr("pair");
    address payer = makeAddr("payer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new BlockableUSDC();
        token = new LaunchToken("Review", "REV", address(usdc), router);
        token.initPair(pair);
        usdc.mint(payer, type(uint128).max);
        vm.prank(payer);
        usdc.approve(address(token), type(uint256).max);
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _distribute(uint256 amount) internal {
        vm.prank(payer);
        token.distribute(amount);
    }

    function _rawEligible() internal view returns (uint256) {
        return uint256(vm.load(address(token), bytes32(uint256(11)))) & type(uint128).max;
    }

    function _rate() internal view returns (uint256) {
        return uint256(vm.load(address(token), bytes32(uint256(10))));
    }

    function _formula() internal view returns (uint256) {
        return token.totalSupply() - token.balanceOf(address(this)) - token.balanceOf(pair) - token.balanceOf(DEAD);
    }

    // ─── The raw tracked eligible supply is the formula, not only its reported (floored-to-0) view ─────────────

    function test_review_rawEligibleIsZeroAtConstructionAndTracksExactly() public {
        assertEq(_rawEligible(), 0, "the constructor mint to the launchpad is excluded (immutable read in ctor ok)");
        token.transfer(alice, 5e17); // below MIN
        assertEq(_rawEligible(), 5e17);
        assertEq(token.eligibleSupply(), 0);
        vm.prank(alice);
        token.transfer(alice, 5e17); // self
        vm.prank(alice);
        token.transfer(bob, 0); // zero
        token.transfer(DEAD, 0);
        vm.prank(alice);
        token.transfer(DEAD, 1);
        assertEq(_rawEligible(), 5e17 - 1);
        assertEq(_rawEligible(), _formula());
    }

    // ─── A distribute never brings the end forward, and never raises the rate by more than amount/(end - now) ──

    function testFuzz_review_distributeNeverShortensTheStreamNorSpikesTheRate(
        uint64 firstRaw,
        uint32 ageRaw,
        uint64 addRaw,
        bool paused
    ) public {
        uint256 first = bound(firstRaw, 1, 1e15);
        uint256 age = bound(ageRaw, 0, D - 1);
        uint256 added = bound(addRaw, 1, 1e15);
        token.transfer(alice, paused ? 1e18 - 1 : 1_000e18);
        _distribute(first);
        vm.warp(_now() + age);

        // What the stream owes and its end, as distribute will see them after its own accrual (streamEnd() already
        // includes the paused time while paused).
        uint256 endBefore = token.streamEnd();
        uint256 rateBefore = _rate();
        uint256 left = endBefore - _now();

        _distribute(added);
        uint256 endAfter = token.streamEnd();
        assertGe(endAfter, endBefore, "the end never moves forward");
        assertLe(endAfter, _now() + D, "never past now + DRIP_PERIOD");
        // rate' = floor((rate * left + added * MAG) / (endAfter - now)) <= rate + added * MAG / left
        assertLe(_rate(), rateBefore + (added * MAG) / left + 1, "the rate rises by at most the new amount over the time left");
        // Money-time is conserved: (owed + added) * newEnd-left <= owed * left + added * D, up to the 1 s floor.
        uint256 owed = rateBefore * left;
        uint256 newLeft = endAfter - _now();
        assertLe(newLeft * (owed + added * MAG), owed * left + added * MAG * D, "weighted end, rounded down");
        assertGt((newLeft + 1) * (owed + added * MAG), owed * left + added * MAG * D, "by less than one second");
    }

    // ─── Pause toggles around one whole token at random times conserve the stream exactly ──────────────────────

    /// @dev Random holders hover around MIN_ELIGIBLE_SUPPLY (the stream pausing and resuming), with distributes
    ///      landing while paused and running. After every step: nothing is ever over-credited; while paused the
    ///      per-share value is frozen; the raw eligible supply is the formula; the token holds what it owes.
    function testFuzz_review_pauseResumeAroundOneTokenConserves(uint256 seed) public {
        address[3] memory hs = [alice, bob, carol];
        uint256 distributed;
        for (uint256 step; step < 60; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address h = hs[r % 3];
            uint256 action = (r >> 8) % 7;
            uint256 x = r >> 16;
            uint256 psBefore = uint256(vm.load(address(token), bytes32(uint256(6))));
            bool wasPaused = _rawEligible() < 1e18;
            if (action == 0) {
                // buy just around the threshold
                token.transfer(h, x % 2e18);
            } else if (action == 1) {
                uint256 bal = token.balanceOf(h);
                token.pull(h, address(this), bal == 0 ? 0 : x % (bal + 1));
            } else if (action == 2) {
                uint256 amt = 1 + (x % 1e10);
                _distribute(amt);
                distributed += amt;
            } else if (action == 3) {
                token.claimFor(h);
            } else if (action == 4) {
                uint256 bal = token.balanceOf(h);
                vm.prank(h);
                token.burn(bal == 0 ? 0 : x % (bal + 1));
            } else {
                uint256 dt = x % (D / 2);
                vm.warp(_now() + dt);
                if (wasPaused) {
                    // a warp alone never moves the per-share value of a paused stream
                    token.claimFor(h);
                    assertEq(uint256(vm.load(address(token), bytes32(uint256(6)))), psBefore, "paused: frozen");
                }
            }
            uint256 credited;
            uint256 claimedSum;
            for (uint256 i; i < 3; ++i) {
                credited += token.claimable(hs[i]) + token.claimed(hs[i]);
                claimedSum += token.claimed(hs[i]);
            }
            assertLe(credited, distributed, "never over-credited");
            assertLe(credited + token.undistributed(), distributed, "credited + still streaming <= distributed");
            assertEq(usdc.balanceOf(address(token)), distributed - claimedSum);
            assertEq(_rawEligible(), _formula(), "raw eligible == formula");
            if (token.streamEnd() != 0) assertLe(token.streamEnd(), _now() + D + 0, "end within a period (after accrual)");
        }
    }

    // ─── Views the site will show: streamRate/streamEnd after the end and during a pause ──────────────────────

    /// @dev Found in review: streamRate() kept reporting the last rate after the stream ended and while paused, and
    ///      streamEnd() was stale during a pause until the next accrual moved it. Both now report the stream as of now.
    function test_review_viewsAfterEndAndDuringPause() public {
        token.transfer(alice, 100e18);
        uint256 t0 = _now();
        _distribute(86_400e6); // 1 USDC a second
        assertEq(token.streamRate(), 1e6);
        vm.warp(t0 + D + 1 days); // long over
        assertEq(token.undistributed(), 0);
        assertEq(token.streamRate(), 0, "nothing is paying once the stream has ended");

        _distribute(86_400e6);
        vm.warp(_now() + 1 hours);
        token.pull(alice, address(this), 100e18); // everyone sells: paused
        uint256 endAtPause = token.streamEnd();
        vm.warp(_now() + 10 hours);
        assertEq(token.eligibleSupply(), 0);
        assertEq(token.streamRate(), 0, "paused pays nothing");
        assertEq(token.streamEnd(), endAtPause + 10 hours, "the end as of now, including the paused time");
        token.claimFor(alice); // any accrual writes that same end
        assertEq(token.streamEnd(), endAtPause + 10 hours);
    }

    // ─── Gas: what a dust distribute costs every later transfer (griefing surface) ─────────────────────────────

    function test_review_gas_dustStreamCostPerTransfer() public {
        token.transfer(alice, 1_000e18);
        token.transfer(bob, 1_000e18);
        vm.warp(_now() + 10);
        vm.prank(alice);
        uint256 g0 = gasleft();
        token.transfer(bob, 1e18);
        uint256 noStream = g0 - gasleft();

        _distribute(1); // one unit (1e-6 USDC) keeps a stream running for a day
        vm.warp(_now() + 10);
        vm.prank(alice);
        g0 = gasleft();
        token.transfer(bob, 1e18);
        uint256 withStream = g0 - gasleft();

        vm.warp(_now() + 10);
        address fresh = makeAddr("fresh");
        vm.prank(alice);
        g0 = gasleft();
        token.transfer(fresh, 1e18); // a first-time receiver: its correction slot goes 0 -> nonzero
        uint256 withStreamFresh = g0 - gasleft();
        emit log_named_uint("transfer, no stream       ", noStream);
        emit log_named_uint("transfer, 1-unit stream   ", withStream);
        emit log_named_uint("transfer to fresh, stream ", withStreamFresh);
        assertGt(withStream, noStream);
    }
}

/// @notice Review, on the real v1.3 suite (launchpad, pair factory, router, pairs).
contract V13SuiteReviewTest is LaunchpadV13Base {
    address internal lp = makeAddr("lp");

    function _raw(address t) internal view returns (uint256) {
        return uint256(vm.load(t, bytes32(uint256(11)))) & type(uint128).max;
    }

    function _formula(address t) internal view returns (uint256) {
        IERC20 tk = IERC20(t);
        return tk.totalSupply() - tk.balanceOf(address(pad)) - tk.balanceOf(pad.pairOf(t)) - tk.balanceOf(DEAD);
    }

    function _check(address t, string memory where) internal view {
        assertEq(_raw(t), _formula(t), where);
    }

    /// @dev Eligible supply through every real flow the pair and router allow, including LP add/remove, skim to an
    ///      eligible account, router buys paying out to excluded accounts, and a dividend stream running throughout.
    function test_review_eligibleTracksFormulaThroughRealPairAndRouterFlows() public {
        DistributePlugin plugin = new DistributePlugin(IERC20(address(usdc)));
        address t = _create(500, address(plugin));
        LaunchPair p = _pairOf(t);
        _check(t, "fresh");
        vm.prank(carol);
        pad.buy(t, 3_000e6, 0, carol, type(uint256).max);
        pad.collectCreatorFees(t); // a stream starts
        vm.warp(vm.getBlockTimestamp() + 600);
        vm.prank(carol);
        pad.sell(t, 1_000e18, 0, carol, type(uint256).max);
        _check(t, "curve buy/sell");
        _graduate(t); // bob
        _check(t, "graduation");
        vm.warp(vm.getBlockTimestamp() + 600);

        // router buys paying out to eligible and excluded accounts
        vm.startPrank(bob);
        router.buy(t, 100e6, 0, bob, vm.getBlockTimestamp());
        router.buy(t, 100e6, 0, address(pad), vm.getBlockTimestamp());
        router.buy(t, 100e6, 0, DEAD, vm.getBlockTimestamp());
        router.buy(t, 100e6, 0, address(p), vm.getBlockTimestamp()); // pays the pair itself
        vm.stopPrank();
        _check(t, "router buys to eligible/pad/dead/pair");

        // LP add: tokens and USDC in, mint LP; then remove to an eligible account and to DEAD
        uint256 tokIn = IERC20(t).balanceOf(bob) / 4;
        (uint112 rt, uint112 ru,) = p.getReserves();
        uint256 usdcIn = tokIn * ru / rt + 1;
        usdc.mint(bob, usdcIn);
        vm.startPrank(bob);
        IERC20(t).transfer(address(p), tokIn);
        usdc.transfer(address(p), usdcIn);
        uint256 liq = p.mint(lp);
        vm.stopPrank();
        _check(t, "LP add");
        vm.warp(vm.getBlockTimestamp() + 600);
        vm.startPrank(lp);
        p.transfer(address(p), liq / 2);
        p.burn(lp);
        p.transfer(address(p), liq / 2);
        p.burn(DEAD);
        vm.stopPrank();
        _check(t, "LP remove to eligible and to dead");

        // donate to the pair, skim to an eligible account and to the launchpad; sync
        vm.prank(carol);
        IERC20(t).transfer(address(p), 50e18);
        p.skim(mallory);
        vm.prank(carol);
        IERC20(t).transfer(address(p), 50e18);
        p.skim(address(pad));
        vm.prank(carol);
        IERC20(t).transfer(address(p), 50e18);
        p.sync();
        _check(t, "donate/skim/sync");

        // router sell, burn, send to dead, zero transfer, self transfer, claims
        vm.warp(vm.getBlockTimestamp() + 600);
        vm.startPrank(bob);
        router.sell(t, 1_000e18, 0, bob, vm.getBlockTimestamp());
        ILaunchToken(t).burn(10e18);
        IERC20(t).transfer(DEAD, 10e18);
        IERC20(t).transfer(bob, 0);
        IERC20(t).transfer(bob, 5e18);
        ILaunchToken(t).claim();
        vm.stopPrank();
        ILaunchToken(t).claimFor(mallory);
        _check(t, "router sell, burn, dead, zero, self, claims");

        // Solvency: what the token holds covers every holder's claimable
        vm.warp(vm.getBlockTimestamp() + 2 days);
        uint256 owed = ILaunchToken(t).claimable(bob) + ILaunchToken(t).claimable(carol)
            + ILaunchToken(t).claimable(mallory) + ILaunchToken(t).claimable(lp) + ILaunchToken(t).claimable(alice);
        assertLe(owed, usdc.balanceOf(t));
    }

    // ─── The destination checks do not cover launch pairs and launch tokens that do not exist yet ────────────

    /// @dev Info PoC: a plugin (or Split payee / Combo target) set to the NEXT launch's pair passes every check,
    ///      because isLaunchPair and the curve registry only know addresses already created. Once the next token
    ///      launches, this token's fees are plain transfers into a launch pair, and anyone skims them.
    function test_review_futureLaunchPairAsPluginPassesChecksAndIsSkimmed() public {
        // The pair factory's next-but-one CREATE: the pair of the launch after this one.
        address nextPair = vm.computeCreateAddress(address(pairFactory), vm.getNonce(address(pairFactory)) + 1);
        address t = _create(1000, nextPair); // accepted: not a launch pair yet
        assertEq(pad.pluginOf(t), nextPair);

        vm.prank(bob);
        address other = pad.createToken("Next", "NXT", "", 0, bob, "", 0, 0, type(uint256).max);
        assertEq(pad.pairOf(other), nextPair, "the prediction was right");
        assertTrue(pad.isLaunchPair(nextPair));

        vm.prank(carol);
        pad.buy(t, 10_000e6, 0, carol, type(uint256).max);
        uint256 fees = pad.collectCreatorFees(t);
        assertGt(fees, 0);
        uint256 before = usdc.balanceOf(mallory);
        LaunchPair(nextPair).skim(mallory);
        assertEq(usdc.balanceOf(mallory) - before, fees, "anyone takes the creator's fees");
    }

    /// @dev Info PoC: the same for a token that does not exist yet: fees go to the next launch token's address, where
    ///      nothing can ever move them.
    function test_review_futureLaunchTokenAsPluginStrandsFees() public {
        address nextToken = vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)) + 1);
        address t = _create(1000, nextToken);
        vm.prank(bob);
        address other = pad.createToken("Next", "NXT", "", 0, bob, "", 0, 0, type(uint256).max);
        assertEq(other, nextToken);
        vm.prank(carol);
        pad.buy(t, 10_000e6, 0, carol, type(uint256).max);
        uint256 fees = pad.collectCreatorFees(t);
        assertEq(usdc.balanceOf(nextToken), fees, "stranded in another launch token");
        assertEq(ILaunchToken(nextToken).totalDistributed(), 0);
    }
}
