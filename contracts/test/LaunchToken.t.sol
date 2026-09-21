// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "./launchpad/LaunchpadV13Base.sol";

/// @notice LaunchToken v2 in isolation: this test contract deploys it, so it is the token's launchpad.
contract LaunchTokenTest is Test {
    uint256 constant TOTAL = 1_000_000_000e18;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    event DividendsDistributed(address indexed from, uint256 amount);
    event DividendClaimed(address indexed holder, uint256 amount);

    BlockableUSDC usdc;
    LaunchToken token;
    address router = makeAddr("router");
    address pair = makeAddr("pair");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address payer = makeAddr("payer");

    function setUp() public {
        usdc = new BlockableUSDC();
        token = new LaunchToken("Dividend", "DIV", address(usdc), router);
        token.initPair(pair);
        usdc.mint(payer, type(uint128).max);
        vm.prank(payer);
        usdc.approve(address(token), type(uint256).max);
    }

    function _give(address to, uint256 amount) internal {
        token.transfer(to, amount); // from the launchpad (this)
    }

    function _distribute(uint256 amount) internal {
        vm.prank(payer);
        token.distribute(amount);
    }

    /// @dev Dividends floor per account: a holder gets the exact pro-rata amount or up to one unit less, never more.
    function _assertFloored(uint256 actual, uint256 exact) internal pure {
        assertLe(actual, exact, "never more than the exact share");
        assertLe(exact - actual, 1, "at most one unit of rounding");
    }

    // ─── Supply, roles, burn ─────────────────────────────────────────────────

    function test_fixedSupplyAtTheLaunchpad() public view {
        assertEq(token.totalSupply(), TOTAL);
        assertEq(token.balanceOf(address(this)), TOTAL);
        assertEq(token.launchpad(), address(this));
        assertEq(token.router(), router);
        assertEq(token.usdc(), address(usdc));
        assertEq(token.pair(), pair);
        assertEq(token.decimals(), 18);
        assertEq(token.MIN_ELIGIBLE_SUPPLY(), 1e18);
        assertFalse(token.graduated());
    }

    function test_burnReducesSupply() public {
        _give(alice, 1_000e18);
        vm.prank(alice);
        token.burn(400e18);
        assertEq(token.totalSupply(), TOTAL - 400e18);
        assertEq(token.balanceOf(alice), 600e18);
        assertEq(token.eligibleSupply(), 600e18);
        vm.prank(alice);
        vm.expectRevert();
        token.burn(600e18 + 1);
    }

    function test_initPairAndMarkGraduated_launchpadOnlyOnce() public {
        vm.prank(alice);
        vm.expectRevert(ILaunchToken.OnlyLaunchpad.selector);
        token.initPair(alice);
        vm.expectRevert(ILaunchToken.PairAlreadySet.selector);
        token.initPair(alice);
        vm.prank(alice);
        vm.expectRevert(ILaunchToken.OnlyLaunchpad.selector);
        token.markGraduated();
        token.markGraduated();
        vm.expectRevert(ILaunchToken.AlreadyGraduated.selector);
        token.markGraduated();
    }

    function test_pairLock() public {
        _give(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        token.transfer(pair, 1);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        token.transfer(pair, 1); // not even the launchpad before graduation
        token.markGraduated();
        vm.prank(alice);
        token.transfer(pair, 1);
        assertEq(token.balanceOf(pair), 1);
    }

    function test_pull_permissionsAndDestinations() public {
        _give(alice, 100e18);
        vm.prank(bob);
        vm.expectRevert(ILaunchToken.OnlyLaunchpadOrRouter.selector);
        token.pull(alice, bob, 1);

        // The launchpad pulls into itself only
        vm.expectRevert(ILaunchToken.InvalidPullTarget.selector);
        token.pull(alice, bob, 1);
        token.pull(alice, address(this), 10e18);
        assertEq(token.balanceOf(alice), 90e18);

        // The router pulls into the pair only, and only once the pair is open
        vm.startPrank(router);
        vm.expectRevert(ILaunchToken.InvalidPullTarget.selector);
        token.pull(alice, router, 1);
        vm.expectRevert(ILaunchToken.PairLockedUntilGraduation.selector);
        token.pull(alice, pair, 1);
        vm.stopPrank();
        token.markGraduated();
        vm.prank(router);
        token.pull(alice, pair, 5e18);
        assertEq(token.balanceOf(pair), 5e18);
        assertEq(token.balanceOf(alice), 85e18);
    }

    // ─── Dividends ───────────────────────────────────────────────────────────

    function test_exclusions() public view {
        assertTrue(token.isExcluded(address(this)));
        assertTrue(token.isExcluded(pair));
        assertTrue(token.isExcluded(DEAD));
        assertTrue(token.isExcluded(address(0)));
        assertFalse(token.isExcluded(alice));
        assertFalse(token.isExcluded(router));
        assertFalse(token.isExcluded(address(token)));
    }

    function test_distribute_zeroEligibleSupplyReverts() public {
        vm.prank(payer);
        vm.expectRevert(ILaunchTokenExtensions.NoEligibleSupply.selector);
        token.distribute(1e6);
        // Tokens at the pair or DEAD are not eligible either
        token.markGraduated();
        _give(pair, 1_000e18);
        _give(DEAD, 1_000e18);
        assertEq(token.eligibleSupply(), 0);
        vm.prank(payer);
        vm.expectRevert(ILaunchTokenExtensions.NoEligibleSupply.selector);
        token.distribute(1e6);
    }

    function test_distribute_belowOneWholeTokenReverts() public {
        _give(alice, 1e18 - 1);
        assertEq(token.eligibleSupply(), 0, "under one whole token dividends are paused and report none");
        vm.prank(payer);
        vm.expectRevert(ILaunchTokenExtensions.NoEligibleSupply.selector);
        token.distribute(1e6);
        _give(bob, 1);
        assertEq(token.eligibleSupply(), 1e18);
        _distribute(1e6);
        assertEq(token.totalDistributed(), 1e6);
    }

    /// @dev What plugins rely on: eligibleSupply() > 0 means distribute succeeds, and it pulls exactly `amount`.
    function testFuzz_positiveEligibleSupplyMeansDistributeSucceeds(uint256 held, uint256 amount) public {
        held = bound(held, 0, 1e21);
        amount = bound(amount, 0, 1e15);
        if (held > 0) _give(alice, held);
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 tokenBefore = usdc.balanceOf(address(token));
        if (token.eligibleSupply() > 0) {
            _distribute(amount);
            assertEq(payerBefore - usdc.balanceOf(payer), amount, "pulls exactly amount");
            assertEq(usdc.balanceOf(address(token)) - tokenBefore, amount);
            assertGe(held, 1e18);
        } else {
            vm.prank(payer);
            vm.expectRevert(ILaunchTokenExtensions.NoEligibleSupply.selector);
            token.distribute(amount);
            assertLt(held, 1e18);
        }
    }

    /// @dev Contracts (plugins among them) hold, transfer and burn like anyone else; nothing calls back into them.
    function test_contractsHoldAndBurnFreely() public {
        address plugin = address(new HooklessRecorder());
        _give(plugin, 500e18);
        vm.startPrank(plugin);
        token.transfer(alice, 100e18);
        token.burn(400e18);
        vm.stopPrank();
        assertEq(token.balanceOf(plugin), 0);
        assertEq(token.totalSupply(), TOTAL - 400e18);
        assertEq(HooklessRecorder(plugin).hookCalls(), 0);
    }

    function test_distribute_proRataAndClaim() public {
        _give(alice, 300e18);
        _give(bob, 100e18);
        vm.expectEmit(true, false, false, true, address(token));
        emit DividendsDistributed(payer, 400e6);
        _distribute(400e6);
        assertEq(usdc.balanceOf(address(token)), 400e6);
        assertEq(token.totalDistributed(), 400e6);
        _assertFloored(token.claimable(alice), 300e6);
        _assertFloored(token.claimable(bob), 100e6);
        assertEq(token.claimable(address(this)), 0, "the launchpad's 999,999,600 tokens earn nothing");

        uint256 aliceShare = token.claimable(alice);
        vm.expectEmit(true, false, false, true, address(token));
        emit DividendClaimed(alice, aliceShare);
        vm.prank(alice);
        assertEq(token.claim(), aliceShare);
        assertEq(usdc.balanceOf(alice), aliceShare);
        assertEq(token.claimed(alice), aliceShare);
        assertEq(token.claimable(alice), 0);
        vm.prank(alice);
        assertEq(token.claim(), 0, "nothing twice");

        // claimFor pays the holder, never the caller
        uint256 bobShare = token.claimable(bob);
        vm.prank(carol);
        assertEq(token.claimFor(bob), bobShare);
        assertEq(usdc.balanceOf(bob), bobShare);
        assertEq(usdc.balanceOf(carol), 0);
        // What stays behind is only rounding dust
        assertLe(usdc.balanceOf(address(token)), 2);
    }

    function test_excludedAccountsNeverAccrue() public {
        token.markGraduated();
        _give(alice, 100e18);
        _give(pair, 500e18);
        _give(DEAD, 500e18);
        _distribute(100e6);
        _assertFloored(token.claimable(alice), 100e6);
        assertEq(token.claimable(pair), 0);
        assertEq(token.claimable(DEAD), 0);
        assertEq(token.claimable(address(this)), 0);
        assertEq(token.claimFor(pair), 0);
        assertEq(token.claimFor(DEAD), 0);
        assertEq(token.claimFor(address(this)), 0);
    }

    function test_transferKeepsEarnedDividendsWithTheSender() public {
        _give(alice, 100e18);
        _give(bob, 100e18);
        _distribute(200e6);
        vm.prank(alice);
        token.transfer(carol, 100e18);
        _assertFloored(token.claimable(alice), 100e6);
        assertEq(token.claimable(carol), 0, "carol earned nothing yet");
        _distribute(200e6);
        _assertFloored(token.claimable(alice), 100e6);
        _assertFloored(token.claimable(carol), 100e6);
        _assertFloored(token.claimable(bob), 200e6);
    }

    function test_sendingToAnExcludedAddressStopsAccrual() public {
        _give(alice, 100e18);
        _give(bob, 100e18);
        _distribute(200e6);
        vm.prank(alice);
        token.transfer(DEAD, 100e18);
        assertEq(token.eligibleSupply(), 100e18);
        _distribute(100e6);
        _assertFloored(token.claimable(alice), 100e6);
        _assertFloored(token.claimable(bob), 200e6);
        assertEq(token.claimable(DEAD), 0);
    }

    function test_burnKeepsEarnedAndShrinksTheBase() public {
        _give(alice, 100e18);
        _give(bob, 100e18);
        _distribute(200e6);
        vm.prank(alice);
        token.burn(100e18);
        _assertFloored(token.claimable(alice), 100e6);
        _distribute(100e6);
        _assertFloored(token.claimable(alice), 100e6);
        _assertFloored(token.claimable(bob), 200e6);
    }

    function test_pullKeepsEarned() public {
        _give(alice, 100e18);
        _give(bob, 100e18);
        _distribute(200e6);
        token.pull(alice, address(this), 100e18); // a curve sell
        _assertFloored(token.claimable(alice), 100e6);
        _distribute(100e6);
        _assertFloored(token.claimable(alice), 100e6);
        _assertFloored(token.claimable(bob), 200e6);
        assertEq(token.claimable(address(this)), 0);
    }

    function test_selfTransferChangesNothing() public {
        _give(alice, 100e18);
        _give(bob, 300e18);
        _distribute(400e6);
        vm.prank(alice);
        token.transfer(alice, 60e18);
        _distribute(400e6);
        _assertFloored(token.claimable(alice), 200e6);
        _assertFloored(token.claimable(bob), 600e6);
    }

    function test_blocklistedHolderKeepsTheirClaim() public {
        _give(alice, 100e18);
        _distribute(50e6);
        usdc.setBlocked(alice, true);
        vm.expectRevert(bytes("blocklisted"));
        token.claimFor(alice);
        _assertFloored(token.claimable(alice), 50e6);
        usdc.setBlocked(alice, false);
        _assertFloored(token.claimFor(alice), 50e6);
    }

    /// @dev The minimum eligible supply bounds the per-share growth: even after distributions far larger than all
    ///      USDC in existence at the smallest allowed base, moving the whole supply still works.
    function test_minimumEligibleSupplyKeepsTransfersSafe() public {
        _give(alice, 1e18); // the smallest base a distribution accepts
        // 1e11 USDC per round (more than all USDC that exists), 20 rounds, claimed back each time
        for (uint256 i = 0; i < 20; i++) {
            _distribute(1e17);
            vm.prank(alice);
            token.claim();
        }
        token.markGraduated();
        // the launchpad moves (nearly) the whole supply around; holders trade it
        token.transfer(bob, TOTAL - 1e18);
        vm.prank(bob);
        token.transfer(carol, TOTAL - 1e18);
        vm.prank(carol);
        token.transfer(pair, TOTAL - 1e18);
        assertEq(token.balanceOf(pair), TOTAL - 1e18);
        assertEq(token.claimable(bob), 0);
        assertEq(token.claimable(carol), 0);
        assertLe(token.claimed(alice), 20 * 1e17);
        assertGe(token.claimed(alice), 20 * 1e17 - 20);
    }

    function testFuzz_dividendsNeverOverCredit(uint256 seed) public {
        address[4] memory holders = [alice, bob, carol, makeAddr("dave")];
        token.markGraduated();
        for (uint256 i = 0; i < holders.length; i++) {
            _give(holders[i], 1e24 + (uint256(keccak256(abi.encode(seed, i))) % 1e26));
        }
        uint256 distributions;
        for (uint256 step = 0; step < 40; step++) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address a = holders[r % 4];
            address b = holders[(r >> 8) % 4];
            uint256 action = (r >> 16) % 7;
            uint256 amount = r >> 32;
            if (action == 0) {
                vm.prank(payer);
                try token.distribute(amount % 1e13) {
                    distributions++;
                } catch {}
            } else if (action == 1) {
                uint256 bal = token.balanceOf(a);
                vm.prank(a);
                token.transfer(b, bal == 0 ? 0 : amount % (bal + 1));
            } else if (action == 2) {
                uint256 bal = token.balanceOf(a);
                vm.prank(a);
                token.burn(bal == 0 ? 0 : amount % (bal + 1));
            } else if (action == 3) {
                vm.prank(b);
                token.claimFor(a);
            } else if (action == 4) {
                uint256 bal = token.balanceOf(a);
                token.pull(a, address(this), bal == 0 ? 0 : amount % (bal + 1));
            } else if (action == 5) {
                uint256 bal = token.balanceOf(a);
                vm.prank(router);
                token.pull(a, pair, bal == 0 ? 0 : amount % (bal + 1));
            } else {
                uint256 bal = token.balanceOf(a);
                vm.prank(a);
                token.transfer(DEAD, bal == 0 ? 0 : amount % (bal + 1));
            }

            uint256 credited;
            uint256 claimedSum;
            for (uint256 i = 0; i < holders.length; i++) {
                credited += token.claimable(holders[i]) + token.claimed(holders[i]);
                claimedSum += token.claimed(holders[i]);
            }
            assertLe(credited, token.totalDistributed(), "sum claimable + claimed <= sum distributed");
            assertLe(token.totalDistributed() - credited, distributions + holders.length, "dust bound");
            assertEq(usdc.balanceOf(address(token)), token.totalDistributed() - claimedSum);
            assertEq(token.claimable(pair) + token.claimable(DEAD) + token.claimable(address(this)), 0);
        }
    }
}

/// @notice The same token behaviour through the real launchpad: the curve inventory is excluded from the start,
///         the launch pair is registered before any buy, and sells pull through `pull`.
contract LaunchTokenThroughLaunchpadTest is LaunchpadV13Base {
    function test_curveAndPoolSellsKeepDividendsExact() public {
        DistributePlugin plugin = new DistributePlugin(IERC20(address(usdc)));
        address t = _create(1000, address(plugin));
        ILaunchToken token = ILaunchToken(t);
        vm.prank(alice);
        pad.buy(t, 2_000e6, 0, alice, type(uint256).max);
        vm.prank(carol);
        pad.buy(t, 2_000e6, 0, carol, type(uint256).max);
        pad.collectCreatorFees(t); // distributes
        uint256 aliceEarned = token.claimable(alice);
        uint256 carolEarned = token.claimable(carol);
        assertGt(aliceEarned, 0);

        // Curve sell (pull into the launchpad) keeps what was earned
        uint256 half = IERC20(t).balanceOf(alice) / 2;
        vm.prank(alice);
        pad.sell(t, half, 0, alice, type(uint256).max);
        assertEq(token.claimable(alice), aliceEarned);

        // Graduate, then a pool sell (pull into the pair) keeps it too
        _graduate(t);
        uint256 carolHalf = IERC20(t).balanceOf(carol) / 2;
        vm.prank(carol);
        router.sell(t, carolHalf, 0, carol, block.timestamp);
        assertEq(token.claimable(carol), carolEarned);

        // The next distribution ignores the launchpad and the pair
        pad.collectCreatorFees(t);
        assertEq(token.claimable(address(pad)), 0);
        assertEq(token.claimable(pad.pairOf(t)), 0);
        uint256 credited = token.claimable(alice) + token.claimable(carol) + token.claimable(bob);
        assertLe(credited, token.totalDistributed());
        assertApproxEqAbs(credited, token.totalDistributed(), 5);
    }

    function test_distributionBeforeAnyBuyReverts() public {
        address t = _create();
        vm.startPrank(alice);
        usdc.approve(t, 1e6);
        vm.expectRevert(ILaunchTokenExtensions.NoEligibleSupply.selector);
        ILaunchToken(t).distribute(1e6);
        vm.stopPrank();
    }
}
