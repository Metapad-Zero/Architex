// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Test.sol";
import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IHolderDistributionPlugin} from "../../../interfaces/plugins/IHolderDistributionPlugin.sol";
import {HolderDistributionPlugin} from "../../../plugins/launch/HolderDistributionPlugin.sol";
import {LaunchToken} from "../../../launchpad/LaunchToken.sol";
import {MockLaunchpad, MockLaunchToken, MockLaunchPair} from "./LaunchPluginMocks.sol";
import {LaunchPluginTestBase, PluginConformanceTest} from "./LaunchPluginTestBase.sol";

/// @dev The stream end after a delivery of `amount` when `kept` USDC is left in a stream ending at `oldEnd`, written
///      out directly rather than in the plugin's rearranged form:
///      ceil((kept * max(oldEnd, at) + amount * (at + period)) / (kept + amount)).
function expectedEnd(uint256 kept, uint256 oldEnd, uint256 amount, uint256 at, uint256 period)
    pure
    returns (uint256)
{
    uint256 from = oldEnd > at ? oldEnd : at;
    uint256 denominator = kept + amount;
    return (kept * from + amount * (at + period) + denominator - 1) / denominator;
}

contract HolderDistributionPluginConformanceTest is PluginConformanceTest {
    function _deployPlugin(address launchpad_) internal override returns (ILaunchFeePlugin) {
        return new HolderDistributionPlugin(launchpad_);
    }

    function _validData() internal pure override returns (bytes memory) {
        return "";
    }
}

/// @notice The drip against the mock launch token (whose eligible supply can be forced, and whose distribute can be
///         made to under-pull).
/// @dev Time is read with vm.getBlockTimestamp(), never block.timestamp: under via-IR the optimizer may re-read
///      TIMESTAMP where the source cached it, which is wrong after a vm.warp in the same test.
contract HolderDistributionPluginTest is LaunchPluginTestBase {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant PERIOD = 24 hours;

    HolderDistributionPlugin internal holder;
    MockLaunchToken internal token;

    function setUp() public override {
        super.setUp();
        holder = new HolderDistributionPlugin(address(launchpad));
        token = _launch(address(holder), "");
    }

    /// @dev The release rule, written out independently of the plugin: everything at or after the end, otherwise
    ///      the elapsed share of the remaining window, rounded down.
    function _linear(uint256 pending, uint256 last, uint256 end, uint256 at) internal pure returns (uint256) {
        if (pending == 0) return 0;
        if (at >= end) return pending;
        return (pending * (at - last)) / (end - last);
    }

    /// @dev What drip(t) should release now, from the plugin's stream views and the token's eligibility.
    function _expectedDrip(MockLaunchToken t) internal view returns (uint256) {
        if (t.eligibleSupply() == 0) return 0;
        address a = address(t);
        return _linear(holder.unreleased(a), holder.lastDrip(a), holder.streamEnd(a), vm.getBlockTimestamp());
    }

    function _assertStream(MockLaunchToken t, uint256 unreleased, uint256 lastDrip, uint256 end) internal view {
        address a = address(t);
        assertEq(holder.unreleased(a), unreleased, "unreleased");
        assertEq(holder.usdcHeld(a), unreleased, "usdcHeld is the unreleased balance");
        assertEq(holder.lastDrip(a), lastDrip, "lastDrip");
        assertEq(holder.streamEnd(a), end, "streamEnd");
    }

    // ─── Configuration ────────────────────────────────────────────────────────

    function test_onLaunch_rejectsAnyData() public {
        MockLaunchToken t = _newToken();
        vm.expectRevert(ILaunchFeePlugin.DataNotEmpty.selector);
        launchpad.launch(address(t), creator, address(holder), address(0), hex"01");
        assertFalse(holder.isConfigured(address(t)));
    }

    function test_dripPeriodIs24Hours() public view {
        assertEq(holder.DRIP_PERIOD(), 24 hours);
    }

    function test_viewsForATokenThatWasNeverFed() public view {
        _assertStream(token, 0, 0, 0);
        assertEq(holder.releasable(address(token)), 0);
        assertEq(holder.totalDistributed(address(token)), 0);
        // An address that is not a token at all: views answer 0 without calling it.
        assertEq(holder.releasable(address(0xBEEF)), 0);
    }

    // ─── Nothing goes out in the block that delivers it ───────────────────────

    function test_onFees_distributesNothingInTheSameBlock() public {
        token.mint(alice, 100e18);
        uint256 t0 = vm.getBlockTimestamp();

        usdc.mint(address(launchpad), 10e6);
        vm.expectEmit(true, false, false, true, address(holder));
        emit IHolderDistributionPlugin.FeesStreamed(address(token), 10e6, 10e6, t0 + PERIOD);
        launchpad.collect(address(token), 10e6);

        assertEq(token.totalDistributed(), 0, "nothing distributed on delivery");
        assertEq(usdc.balanceOf(address(token)), 0);
        assertEq(usdc.balanceOf(address(holder)), 10e6);
        _assertStream(token, 10e6, t0, t0 + PERIOD);
        assertEq(holder.releasable(address(token)), 0);

        // A drip in the same block releases nothing and changes nothing.
        vm.recordLogs();
        vm.prank(keeper);
        assertEq(holder.drip(address(token)), 0);
        assertEq(vm.getRecordedLogs().length, 0, "no events");
        assertEq(token.totalDistributed(), 0);
        _assertStream(token, 10e6, t0, t0 + PERIOD);
        assertEq(holder.totalDistributed(address(token)), 0);
    }

    function test_onFees_sameBlockDeliveriesStackWithoutReleasing() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 10e6);
        _payDirect(address(holder), address(token), keeper, 5e6);
        _collect(token, 1);
        _assertStream(token, 15e6 + 1, t0, t0 + PERIOD);
        assertEq(holder.releasable(address(token)), 0);
        assertEq(token.totalDistributed(), 0);
    }

    // ─── Linear release ───────────────────────────────────────────────────────

    function test_drip_releasesLinearlyAt6h12h24hAndNothingAfter() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 96e6);

        vm.warp(t0 + 6 hours);
        assertEq(holder.releasable(address(token)), 24e6, "a quarter at 6h");
        vm.expectEmit(true, false, false, true, address(holder));
        emit IHolderDistributionPlugin.Distributed(address(token), 24e6);
        vm.prank(keeper);
        assertEq(holder.drip(address(token)), 24e6);
        assertEq(token.totalDistributed(), 24e6);
        assertEq(usdc.balanceOf(address(token)), 24e6);
        assertEq(usdc.allowance(address(holder), address(token)), 0);
        _assertStream(token, 72e6, t0 + 6 hours, t0 + PERIOD); // the end does not move

        vm.warp(t0 + 12 hours);
        assertEq(holder.releasable(address(token)), 24e6, "half by 12h");
        assertEq(holder.drip(address(token)), 24e6);
        assertEq(token.totalDistributed(), 48e6);

        vm.warp(t0 + 24 hours);
        assertEq(holder.releasable(address(token)), 48e6, "the rest at 24h");
        assertEq(holder.drip(address(token)), 48e6);
        assertEq(token.totalDistributed(), 96e6);
        assertEq(holder.unreleased(address(token)), 0);
        assertEq(holder.totalDistributed(address(token)), 96e6);
        assertEq(usdc.balanceOf(address(holder)), 0);

        vm.warp(t0 + 30 hours);
        assertEq(holder.releasable(address(token)), 0);
        assertEq(holder.drip(address(token)), 0);
        assertEq(token.totalDistributed(), 96e6);
    }

    function test_drip_oneDripAt12hReleasesHalf() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 10e6);
        vm.warp(t0 + 12 hours);
        assertEq(holder.drip(address(token)), 5e6);
        vm.warp(t0 + 18 hours);
        assertEq(holder.drip(address(token)), 2.5e6);
        vm.warp(t0 + 24 hours);
        assertEq(holder.drip(address(token)), 2.5e6);
        assertEq(token.totalDistributed(), 10e6);
    }

    function test_drip_longAfterTheEndReleasesEverythingAtOnce() public {
        token.mint(alice, 1e18);
        _collect(token, 10e6);
        vm.warp(vm.getBlockTimestamp() + 30 days);
        assertEq(holder.releasable(address(token)), 10e6);
        assertEq(holder.drip(address(token)), 10e6);
        assertEq(holder.unreleased(address(token)), 0);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    /// @dev A release that rounds to zero changes nothing, so the elapsed time is not lost: 3 units still go out
    ///      one at a time, on schedule, and all of them by the end.
    function test_drip_roundsDownWithoutLosingTime() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 3);

        vm.warp(t0 + 1 hours);
        assertEq(holder.drip(address(token)), 0); // 3 * 1/24 rounds down
        _assertStream(token, 3, t0, t0 + PERIOD); // lastDrip did not move

        vm.warp(t0 + 8 hours);
        assertEq(holder.drip(address(token)), 1); // 3 * 8/24
        _assertStream(token, 2, t0 + 8 hours, t0 + PERIOD);

        vm.warp(t0 + 16 hours);
        assertEq(holder.drip(address(token)), 1); // 2 * 8/16

        vm.warp(t0 + 24 hours);
        assertEq(holder.drip(address(token)), 1);
        assertEq(token.totalDistributed(), 3);
    }

    /// @dev Hourly drips of a small amount: each release is exactly the rule, none runs ahead of a straight line
    ///      from the deposit, and the total is exactly the deposit.
    function test_drip_hourlyDripsSumToTheDeposit() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        uint256 amount = 1_000_003;
        _collect(token, amount);
        uint256 released;
        for (uint256 h = 1; h <= 24; ++h) {
            vm.warp(t0 + h * 1 hours);
            uint256 expected = _expectedDrip(token);
            uint256 got = holder.drip(address(token));
            assertEq(got, expected);
            released += got;
            assertLe(released * PERIOD, amount * h * 1 hours, "never ahead of the straight line");
        }
        assertEq(released, amount);
    }

    // ─── A second deposit mid-stream ──────────────────────────────────────────

    /// @dev A second delivery mid-stream first releases what the old stream owed (half, at 12h). Then the 60 left
    ///      and the 60 new stream on one line from now to the amount-weighted average of the old end (24h) and a full
    ///      period from now (36h): 30h. Nothing more goes out in the delivering block.
    function test_onFees_midStreamMovesTheEndToTheAmountWeightedAverage() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 120e6);

        vm.warp(t0 + 12 hours);
        usdc.mint(address(launchpad), 60e6);
        vm.expectEmit(true, false, false, true, address(holder));
        emit IHolderDistributionPlugin.Distributed(address(token), 60e6);
        vm.expectEmit(true, false, false, true, address(holder));
        emit IHolderDistributionPlugin.FeesStreamed(address(token), 60e6, 120e6, t0 + 30 hours);
        launchpad.collect(address(token), 60e6);

        assertEq(token.totalDistributed(), 60e6, "the old stream's due went out on the old schedule");
        _assertStream(token, 120e6, t0 + 12 hours, t0 + 30 hours);
        assertEq(holder.releasable(address(token)), 0, "nothing more in the delivering block");

        vm.warp(t0 + 24 hours); // 12h of the new 18h line
        assertEq(holder.drip(address(token)), 80e6);
        vm.warp(t0 + 30 hours);
        assertEq(holder.drip(address(token)), 40e6);
        assertEq(token.totalDistributed(), 180e6);
        assertEq(holder.unreleased(address(token)), 0);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    /// @dev The weights decide. A pile 99 times what is left gets 99% of the way to a full period from now; a
    ///      delivery of 2% of what is left moves the end about 2% of the way.
    function test_onFees_theEndMovesByWeight() public {
        token.mint(alice, 1e18);
        MockLaunchToken other = _launch(address(holder), "");
        other.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 2e6);
        _collect(other, 100e6);
        vm.warp(t0 + 12 hours);

        _collect(token, 99e6); // kept 1e6 after the due: 24h + ceil(99/100 * 12h)
        assertEq(holder.streamEnd(address(token)), t0 + 24 hours + 42_768);
        assertEq(holder.streamEnd(address(token)), expectedEnd(1e6, t0 + PERIOD, 99e6, t0 + 12 hours, PERIOD));

        _collect(other, 1e6); // kept 50e6 after the due: 24h + ceil(1/51 * 12h)
        assertEq(holder.streamEnd(address(other)), t0 + 24 hours + 848);
    }

    /// @dev Dust cannot hold a stream back: a 1-unit delivery every hour for a day moves a 1,000,000 USDC pile's end
    ///      by one second each (the rounding up), so the pile never falls behind the line from its delivery to the
    ///      original end plus those seconds, stays within 0.03% of its original line, and is entirely out by the
    ///      original end plus an hour.
    function test_onFees_hourlyDustLeavesThePileOnItsOriginalSchedule() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        uint256 pile = 1_000_000e6;
        _collect(token, pile);
        for (uint256 h = 1; h <= 24; ++h) {
            vm.warp(t0 + h * 1 hours);
            _payDirect(address(holder), address(token), attacker, 1);
            assertEq(holder.streamEnd(address(token)), t0 + PERIOD + h, "one second per delivery");
            uint256 released = token.totalDistributed();
            assertGe(released + h, (pile * h * 1 hours) / (PERIOD + h), "on the line to the end + h seconds");
            assertGe(released * 10_000, ((pile * h * 1 hours) / PERIOD) * 9_997, "within 0.03% of the original line");
        }

        vm.warp(t0 + PERIOD + 1 hours);
        holder.drip(address(token));
        assertGe(token.totalDistributed(), (pile * 99) / 100, "at least 99% by the original end + 1 hour");
        assertEq(token.totalDistributed(), pile + 24, "in fact all of it");
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    /// @dev What rounding up costs: a delivery moves the end by at least one second unless it already sits a full
    ///      period out, even several deliveries in one block. Holding a stream back therefore takes one delivery per
    ///      second of delay.
    function test_onFees_eachDustDeliveryMovesTheEndOneSecond() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 1_000_000e6);
        vm.warp(t0 + 12 hours);
        for (uint256 i = 1; i <= 5; ++i) {
            _payDirect(address(holder), address(token), attacker, 1);
            assertEq(holder.streamEnd(address(token)), t0 + PERIOD + i);
        }
        assertEq(holder.releasable(address(token)), 0);
    }

    /// @dev No delivery moves the end past a full period from now: a large delivery on a nearly empty stream gets
    ///      exactly the full period, and a same-block delivery on a stream already ending there leaves it.
    function test_onFees_theEndNeverPassesAFullPeriodFromNow() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 1);
        vm.warp(t0 + 12 hours); // 1 * 12/24 rounds down: the unit is still kept
        _collect(token, 1e6);
        assertEq(holder.streamEnd(address(token)), t0 + 12 hours + PERIOD);
        _collect(token, 1e6);
        assertEq(holder.streamEnd(address(token)), t0 + 12 hours + PERIOD);
    }

    function test_onFees_afterTheStreamEndedReleasesTheOldBalanceThenStreamsTheNew() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 10e6);
        vm.warp(t0 + 30 hours);
        _collect(token, 20e6);
        assertEq(token.totalDistributed(), 10e6);
        _assertStream(token, 20e6, t0 + 30 hours, t0 + 54 hours);
        assertEq(holder.releasable(address(token)), 0);
    }

    /// @dev A zero delivery neither releases what is due nor restarts the window.
    function test_onFees_zeroAmountIsANoopAndDoesNotRestartTheWindow() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 10e6);
        vm.warp(t0 + 6 hours);
        vm.recordLogs();
        _collect(token, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].emitter != address(holder), "the plugin emitted nothing");
        }
        _assertStream(token, 10e6, t0, t0 + PERIOD);
        assertEq(holder.releasable(address(token)), 2.5e6);
        assertEq(token.totalDistributed(), 0);
    }

    // ─── No eligible supply ───────────────────────────────────────────────────

    /// @dev Without holders nothing is released and lastDrip stays put, so what matured goes out as soon as there
    ///      is eligible supply.
    function test_noEligibleSupply_holdsAndReleasesOnceThereAreHolders() public {
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 24e6);
        assertEq(token.eligibleSupply(), 0);

        vm.warp(t0 + 12 hours);
        assertEq(holder.releasable(address(token)), 0);
        vm.recordLogs();
        assertEq(holder.drip(address(token)), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        _assertStream(token, 24e6, t0, t0 + PERIOD); // the clock keeps running

        token.mint(alice, 1e18);
        assertEq(holder.releasable(address(token)), 12e6);
        assertEq(holder.drip(address(token)), 12e6);
        _assertStream(token, 12e6, t0 + 12 hours, t0 + PERIOD);

        vm.warp(t0 + 24 hours);
        assertEq(holder.drip(address(token)), 12e6);
        assertEq(token.totalDistributed(), 24e6);
    }

    function test_noEligibleSupply_everythingWaitsPastTheEndThenGoesOutAtOnce() public {
        _collect(token, 10e6);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        assertEq(holder.drip(address(token)), 0);
        assertEq(holder.unreleased(address(token)), 10e6);
        token.mint(bob, 1e18);
        assertEq(holder.drip(address(token)), 10e6);
        assertEq(token.totalDistributed(), 10e6);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    /// @dev Tokens held only by excluded accounts (curve inventory, pool, burn address) are not eligible supply.
    function test_noEligibleSupply_whenOnlyExcludedAccountsHoldTokens() public {
        token.mint(address(launchpad), 800_000_000e18);
        token.mint(address(_pairOf(token)), 200_000_000e18);
        token.mint(DEAD, 1e18);
        assertEq(token.eligibleSupply(), 0);
        _collect(token, 10e6);
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        assertEq(holder.releasable(address(token)), 0);
        assertEq(holder.drip(address(token)), 0);
        assertEq(holder.usdcHeld(address(token)), 10e6);
    }

    /// @dev A delivery while there are no holders: the matured 10 count as ending now, so the line for all 24
    ///      restarts from now and ends at the weighted average, 14/24 of a period out. Nothing is releasable in the
    ///      delivering block even once there are holders.
    function test_noEligibleSupply_aDeliveryRestartsTheLineFromNow() public {
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 10e6);
        vm.warp(t0 + 30 hours);
        _collect(token, 14e6);
        assertEq(token.totalDistributed(), 0);
        _assertStream(token, 24e6, t0 + 30 hours, t0 + 44 hours);

        token.mint(alice, 1e18);
        assertEq(holder.releasable(address(token)), 0);
        vm.warp(t0 + 37 hours);
        assertEq(holder.drip(address(token)), 12e6);
    }

    // ─── Drip access ──────────────────────────────────────────────────────────

    function test_drip_revertsForUnconfiguredToken() public {
        MockLaunchToken other = _launch(alice, "");
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotConfigured.selector, address(other)));
        holder.drip(address(other));
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotConfigured.selector, address(other)));
        holder.dripAndClaim(address(other));
    }

    function test_drip_withNothingStreamedReturnsZero() public {
        token.mint(alice, 1e18);
        vm.prank(attacker);
        assertEq(holder.drip(address(token)), 0);
        vm.prank(attacker);
        (uint256 released, uint256 claimed) = holder.dripAndClaim(address(token));
        assertEq(released, 0);
        assertEq(claimed, 0);
    }

    function test_dripAndClaim_dripsLikeDrip() public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, 8e6);
        vm.warp(t0 + 6 hours);
        vm.prank(alice);
        (uint256 released,) = holder.dripAndClaim(address(token));
        assertEq(released, 2e6);
        _assertStream(token, 6e6, t0 + 6 hours, t0 + PERIOD);
        assertEq(token.totalDistributed(), 2e6);
    }

    // ─── A token that does not pull what it is given ──────────────────────────

    function test_drip_revertsWhenTheTokenUnderPulls() public {
        _collect(token, 10e6);
        token.mint(alice, 1e18);
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        token.setDistributeShortfall(1);
        vm.expectRevert(
            abi.encodeWithSelector(ILaunchFeePlugin.PullMismatch.selector, address(token), 10e6, 10e6 - 1)
        );
        holder.drip(address(token));
        assertEq(holder.usdcHeld(address(token)), 10e6);
    }

    /// @dev onFees releases the old stream's due first, so a token that under-pulls makes the collection revert and
    ///      the new fees stay at the launchpad [D10].
    function test_onFees_revertsWhenTheTokenUnderPullsTheOldStreamsDue() public {
        token.mint(alice, 1e18);
        _collect(token, 10e6);
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        token.setDistributeShortfall(1);
        usdc.mint(address(launchpad), 5e6);
        vm.expectRevert(
            abi.encodeWithSelector(ILaunchFeePlugin.PullMismatch.selector, address(token), 10e6, 10e6 - 1)
        );
        launchpad.collect(address(token), 5e6);
        assertEq(usdc.balanceOf(address(launchpad)), 5e6);
        assertEq(holder.usdcHeld(address(token)), 10e6);
    }

    // ─── Isolation ────────────────────────────────────────────────────────────

    function test_perTokenIsolation() public {
        MockLaunchToken other = _launch(address(holder), "");
        other.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();

        _collect(token, 10e6); // no eligible supply: waits
        vm.warp(t0 + 6 hours);
        _collect(other, 8e6); // eligible: streams on its own clock

        _assertStream(token, 10e6, t0, t0 + PERIOD);
        _assertStream(other, 8e6, t0 + 6 hours, t0 + 30 hours);

        vm.warp(t0 + 18 hours);
        assertEq(holder.drip(address(other)), 4e6);
        assertEq(holder.drip(address(token)), 0);
        assertEq(other.totalDistributed(), 4e6);
        assertEq(token.totalDistributed(), 0);

        token.mint(carol, 1e18);
        assertEq(holder.drip(address(token)), 7.5e6);
        assertEq(token.totalDistributed(), 7.5e6);
        assertEq(other.totalDistributed(), 4e6);
        assertEq(usdc.balanceOf(address(holder)), holder.unreleased(address(token)) + holder.unreleased(address(other)));
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev One deposit, drips at random times: each release is exactly the rule and never more than what is
    ///      unreleased; the running total never gets ahead of a straight line from the deposit and falls behind it
    ///      by less than one unit per release; and everything, to the unit, is out by the end.
    function testFuzz_drip_releaseMath(uint256 amountRaw, uint32[8] memory gaps) public {
        uint256 amount = bound(amountRaw, 1, 1e18);
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, amount);

        uint256 released;
        uint256 releases;
        for (uint256 i; i < gaps.length; ++i) {
            vm.warp(vm.getBlockTimestamp() + bound(gaps[i], 0, 8 hours));
            uint256 pending = holder.unreleased(address(token));
            uint256 expected = _expectedDrip(token);
            assertEq(holder.releasable(address(token)), expected, "the view is the rule");
            uint256 got = holder.drip(address(token));
            assertEq(got, expected, "the release is the rule");
            assertLe(got, pending, "never more than unreleased");
            released += got;
            if (got != 0) releases += 1;

            uint256 elapsed = vm.getBlockTimestamp() - t0;
            if (elapsed < PERIOD) {
                assertLe(released * PERIOD, amount * elapsed, "never ahead of the straight line");
                assertGe(released + releases, (amount * elapsed) / PERIOD, "behind it by rounding only");
            } else {
                assertEq(released, amount, "all out once the period is over");
            }
        }

        vm.warp(t0 + PERIOD + bound(gaps[0], 0, 30 days));
        released += holder.drip(address(token));
        assertEq(released, amount, "sums to the deposit");
        assertEq(holder.unreleased(address(token)), 0);
        assertEq(token.totalDistributed(), amount);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    /// @dev Deliveries, drips and eligibility at random times. Each delivery releases exactly what the old stream
    ///      owed and nothing of itself, restarts the line from now and moves the end to the rounded-up weighted
    ///      average; unreleased + distributed always equals what was credited; the plugin holds exactly its
    ///      unreleased USDC; and once there are holders and a full period passes, everything is out.
    function testFuzz_deliveriesDripsAndEligibility(
        uint64[6] memory amounts,
        uint32[6] memory gaps,
        uint8 eligibilityMask,
        uint8 dripMask
    ) public {
        uint256 credited;
        for (uint256 i; i < amounts.length; ++i) {
            vm.warp(vm.getBlockTimestamp() + bound(gaps[i], 0, 30 hours));
            token.forceEligibleSupply((eligibilityMask >> i) & 1 == 1 ? 1e18 : 0);
            if ((dripMask >> i) & 1 == 1) {
                uint256 expected = _expectedDrip(token);
                assertEq(holder.drip(address(token)), expected);
            }

            uint256 due = holder.releasable(address(token));
            uint256 before = holder.unreleased(address(token));
            uint256 distributedBefore = holder.totalDistributed(address(token));
            uint256 lastBefore = holder.lastDrip(address(token));
            uint256 endBefore = holder.streamEnd(address(token));
            _collect(token, amounts[i]);
            credited += amounts[i];

            if (amounts[i] != 0) {
                uint256 at = vm.getBlockTimestamp();
                assertEq(holder.totalDistributed(address(token)), distributedBefore + due, "only the old due");
                _assertStream(
                    token, before - due + amounts[i], at, expectedEnd(before - due, endBefore, amounts[i], at, PERIOD)
                );
                assertEq(holder.releasable(address(token)), 0, "nothing of new fees in the delivering block");
            } else {
                assertEq(holder.totalDistributed(address(token)), distributedBefore);
                _assertStream(token, before, lastBefore, endBefore);
            }
            assertEq(holder.unreleased(address(token)) + holder.totalDistributed(address(token)), credited);
            assertEq(usdc.balanceOf(address(holder)), holder.unreleased(address(token)));
            assertEq(token.totalDistributed(), holder.totalDistributed(address(token)));
            assertEq(usdc.allowance(address(holder), address(token)), 0);
        }

        token.forceEligibleSupply(1e18);
        vm.warp(vm.getBlockTimestamp() + PERIOD);
        holder.drip(address(token));
        assertEq(holder.unreleased(address(token)), 0);
        assertEq(holder.totalDistributed(address(token)), credited);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    /// @dev A second deposit at any point of a running stream: from then on, what is unreleased never drops below a
    ///      straight line from the combined balance at the deposit to zero at the new end (so nothing goes out
    ///      early), and all of it is out at the new end.
    function testFuzz_secondDepositNeverReleasesEarly(
        uint64 firstRaw,
        uint64 secondRaw,
        uint32 atRaw,
        uint32[4] memory gaps
    ) public {
        token.mint(alice, 1e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, bound(firstRaw, 1, type(uint64).max));
        vm.warp(t0 + bound(atRaw, 0, PERIOD - 1));
        uint256 deposited = vm.getBlockTimestamp();
        uint256 kept = holder.unreleased(address(token)) - holder.releasable(address(token));
        uint256 second = bound(secondRaw, 1, type(uint64).max);
        _collect(token, second);

        uint256 balance = holder.unreleased(address(token));
        uint256 end = holder.streamEnd(address(token));
        assertEq(end, expectedEnd(kept, t0 + PERIOD, second, deposited, PERIOD));
        for (uint256 i; i < gaps.length; ++i) {
            vm.warp(vm.getBlockTimestamp() + bound(gaps[i], 0, 8 hours));
            holder.drip(address(token));
            if (vm.getBlockTimestamp() < end) {
                assertGe(
                    holder.unreleased(address(token)) * (end - deposited), balance * (end - vm.getBlockTimestamp())
                );
            } else {
                assertEq(holder.unreleased(address(token)), 0);
            }
        }
        vm.warp(end);
        holder.drip(address(token));
        assertEq(holder.unreleased(address(token)), 0);
    }

    /// @dev Any delivery on any stream, with or without holders: the end is exactly the rounded-up weighted average;
    ///      it is never before the old end (clamped to now) nor past a full period from now; it is after now, so
    ///      nothing is releasable in the delivering block; a delivery to an empty stream gets exactly the full
    ///      period; and dust (at most kept / (period - 1)) moves the end at most one second.
    function testFuzz_onFees_weightedEnd(uint64 firstRaw, uint64 secondRaw, uint32 gapRaw, bool eligible) public {
        token.forceEligibleSupply(eligible ? 1e18 : 0);
        uint256 t0 = vm.getBlockTimestamp();
        _collect(token, bound(firstRaw, 1, type(uint64).max));
        assertEq(holder.streamEnd(address(token)), t0 + PERIOD, "an empty stream gets the full period");

        vm.warp(t0 + bound(gapRaw, 0, 3 * PERIOD));
        uint256 at = vm.getBlockTimestamp();
        uint256 kept = holder.unreleased(address(token)) - holder.releasable(address(token));
        uint256 oldEnd = holder.streamEnd(address(token));
        uint256 from = oldEnd > at ? oldEnd : at;
        uint256 second = bound(secondRaw, 1, type(uint64).max);
        _collect(token, second);

        uint256 end = holder.streamEnd(address(token));
        assertEq(end, expectedEnd(kept, oldEnd, second, at, PERIOD), "the rounded-up weighted average");
        assertGe(end, from, "never before the old end");
        assertLe(end, at + PERIOD, "never past a full period from now");
        assertGt(end, at, "after now");
        assertEq(holder.lastDrip(address(token)), at);
        assertEq(holder.releasable(address(token)), 0, "nothing releasable in the delivering block");
        if (kept == 0) assertEq(end, at + PERIOD, "nothing kept: the full period");
        if (second * (PERIOD - 1) <= kept) assertLe(end, from + 1, "dust: one second at most");
    }
}

/// @notice The real launch token (LaunchToken v2) behind the plugin: dividends, claims, and the one-transaction bot
///         the drip exists to stop. This test contract deploys the token, so it is the token's launchpad: its
///         balance is the curve inventory (excluded from dividends), and a transfer out of it stands in for a curve
///         buy, a transfer back for a sell. Time is read with vm.getBlockTimestamp() (see above).
contract HolderDistributionLaunchTokenTest is LaunchPluginTestBase {
    uint256 internal constant PERIOD = 24 hours;

    HolderDistributionPlugin internal holder;
    LaunchToken internal token;

    function setUp() public override {
        super.setUp();
        holder = new HolderDistributionPlugin(address(launchpad));
        token = new LaunchToken("Launch", "LAUNCH", address(usdc), address(router));
        MockLaunchPair pair = new MockLaunchPair();
        token.initPair(address(pair));
        launchpad.launch(address(token), creator, address(holder), address(pair), "");
        assertTrue(holder.isConfigured(address(token)));
    }

    function _buy(address to, uint256 amount) internal {
        token.transfer(to, amount);
    }

    /// @dev `amount` of creator fees collected to the plugin, as collectCreatorFees does.
    function _collectFees(uint256 amount) internal {
        usdc.mint(address(launchpad), amount);
        launchpad.collect(address(token), amount);
    }

    // ─── dripAndClaim ─────────────────────────────────────────────────────────

    /// @dev The caller is paid exactly its claimable (as it stands after the drip); nobody else is paid anything,
    ///      and the other holders' USDC stays claimable in the token.
    function test_dripAndClaim_paysTheCallerItsClaimableAndNobodyElse() public {
        _buy(alice, 300_000_000e18);
        _buy(bob, 100_000_000e18);
        _collectFees(100e6);
        vm.warp(vm.getBlockTimestamp() + PERIOD);

        uint256 snapshot = vm.snapshotState();
        holder.drip(address(token));
        uint256 aliceOwed = token.claimable(alice);
        uint256 bobOwed = token.claimable(bob);
        vm.revertToState(snapshot);
        assertApproxEqAbs(aliceOwed, 75e6, 1);
        assertApproxEqAbs(bobOwed, 25e6, 1);

        vm.prank(alice);
        (uint256 released, uint256 claimed) = holder.dripAndClaim(address(token));
        assertEq(released, 100e6);
        assertEq(claimed, aliceOwed);
        assertEq(usdc.balanceOf(alice), aliceOwed, "the caller got its claimable");
        assertEq(token.claimable(alice), 0);
        assertEq(usdc.balanceOf(bob), 0, "nobody else was paid");
        assertEq(token.claimable(bob), bobOwed, "bob's share waits for bob");
        assertEq(usdc.balanceOf(address(token)), 100e6 - aliceOwed);
        assertEq(usdc.balanceOf(address(holder)), 0);

        // A caller with no tokens drips (nothing left) and is paid nothing.
        vm.prank(carol);
        (released, claimed) = holder.dripAndClaim(address(token));
        assertEq(released, 0);
        assertEq(claimed, 0);
        assertEq(usdc.balanceOf(carol), 0);
        assertEq(token.claimable(bob), bobOwed);
    }

    function test_dripAndClaim_midStreamClaimsWhatHasBeenReleasedSoFar() public {
        _buy(alice, 1_000_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collectFees(100e6);

        vm.warp(t0 + 6 hours);
        vm.prank(alice);
        (uint256 released, uint256 claimed) = holder.dripAndClaim(address(token));
        assertEq(released, 25e6);
        assertApproxEqAbs(claimed, 25e6, 1);

        vm.warp(t0 + PERIOD);
        vm.prank(alice);
        (uint256 released2, uint256 claimed2) = holder.dripAndClaim(address(token));
        assertEq(released2, 75e6);
        assertApproxEqAbs(claimed + claimed2, 100e6, 2);
        assertLe(claimed + claimed2, 100e6);
        assertEq(usdc.balanceOf(alice), claimed + claimed2);
    }

    /// @dev claimFor for a caller that was paid through the token already: the plugin never double-pays.
    function test_dripAndClaim_afterClaimingOnTheTokenPaysOnlyWhatIsNew() public {
        _buy(alice, 1_000_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collectFees(48e6);
        vm.warp(t0 + 12 hours);
        holder.drip(address(token));
        vm.prank(alice);
        uint256 first = token.claim();
        assertApproxEqAbs(first, 24e6, 1);

        vm.prank(alice);
        (uint256 released, uint256 claimed) = holder.dripAndClaim(address(token));
        assertEq(released, 0);
        assertEq(claimed, 0);
        assertEq(usdc.balanceOf(alice), first);
    }

    // ─── The one-transaction bot ──────────────────────────────────────────────

    /// @dev A large pile of creator fees waits at the launchpad and no stream is running. A bot buys half the
    ///      eligible supply, collects the pile to the plugin, drips and claims, and sells, all in one transaction. It
    ///      gets nothing; the holders who stay get the whole pile over the next 24 hours.
    function test_sniper_getsNothingOfAPendingPile() public {
        _buy(alice, 100_000_000e18);
        _buy(bob, 100_000_000e18);
        uint256 pile = 1_000_000e6;
        usdc.mint(address(launchpad), pile);

        Sniper sniper = new Sniper();
        token.approve(address(sniper), 200_000_000e18);
        (uint256 released, uint256 claimed) = sniper.attack(token, address(this), 200_000_000e18, launchpad, pile, holder);

        assertEq(released, 0);
        assertEq(claimed, 0);
        assertEq(usdc.balanceOf(address(sniper)), 0, "the bot got none of the pile");
        assertEq(token.balanceOf(address(sniper)), 0, "and sold everything it bought");
        assertEq(token.totalDistributed(), 0);
        assertEq(holder.unreleased(address(token)), pile);
        assertEq(usdc.balanceOf(address(launchpad)), 0, "the pile was collected");

        vm.warp(vm.getBlockTimestamp() + PERIOD);
        holder.drip(address(token));
        assertApproxEqAbs(token.claimable(alice), pile / 2, 1);
        assertApproxEqAbs(token.claimable(bob), pile / 2, 1);
        assertEq(token.claimable(address(sniper)), 0);
    }

    /// @dev With a stream already running, the collection inside the bot's transaction first releases what the old
    ///      stream owes since its last drip, and the bot, holding half the supply at that moment, earns half of that:
    ///      here one minute of the old stream, about 83 USDC, against a 1,000,000 USDC pile. None of the pile.
    function test_sniper_withARunningStreamOnlySharesWhatAccruedSinceTheLastDrip() public {
        _buy(alice, 100_000_000e18);
        _buy(bob, 100_000_000e18);
        uint256 t0 = vm.getBlockTimestamp();
        _collectFees(240_000e6);
        vm.warp(t0 + 12 hours);
        holder.drip(address(token)); // the site or a keeper drips: half of the old stream goes out
        vm.warp(t0 + 12 hours + 1 minutes);

        uint256 oldDue = holder.releasable(address(token));
        assertEq(oldDue, (uint256(120_000e6) * 1 minutes) / 12 hours); // 166.666666 USDC
        uint256 pile = 1_000_000e6;
        usdc.mint(address(launchpad), pile);

        Sniper sniper = new Sniper();
        token.approve(address(sniper), 200_000_000e18);
        (uint256 released, uint256 claimed) = sniper.attack(token, address(this), 200_000_000e18, launchpad, pile, holder);

        assertEq(released, 0, "the collection already released the old due; nothing more this block");
        assertEq(claimed, usdc.balanceOf(address(sniper)));
        assertApproxEqAbs(claimed, oldDue / 2, 1);
        assertLe(claimed * 10_000, pile, "under 0.01% of the pile");
        assertEq(holder.unreleased(address(token)), 120_000e6 - oldDue + pile);
        // The pile dwarfs what was left, so the end moves most of the way to a full period from now (about 34.7h).
        uint256 at = vm.getBlockTimestamp();
        uint256 end = holder.streamEnd(address(token));
        assertEq(end, expectedEnd(120_000e6 - oldDue, t0 + PERIOD, pile, at, PERIOD));
        assertGt(end, at + 22 hours);
        assertEq(holder.releasable(address(token)), 0);
    }

    // ─── Eligible supply below one whole token ────────────────────────────────

    /// @dev The real token reports no eligible supply below one whole eligible token: the plugin holds, and releases
    ///      what matured once there is a whole token.
    function test_belowOneWholeEligibleTokenNothingIsReleased() public {
        _buy(alice, 0.5e18);
        assertEq(token.eligibleSupply(), 0);
        uint256 t0 = vm.getBlockTimestamp();
        _collectFees(10e6);
        vm.warp(t0 + PERIOD);
        assertEq(holder.releasable(address(token)), 0);
        assertEq(holder.drip(address(token)), 0);
        assertEq(holder.lastDrip(address(token)), t0);

        _buy(alice, 0.5e18);
        assertEq(holder.releasable(address(token)), 10e6);
        vm.prank(alice);
        (uint256 released, uint256 claimed) = holder.dripAndClaim(address(token));
        assertEq(released, 10e6);
        assertApproxEqAbs(claimed, 10e6, 1);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev Random holdings, fees and drip times: once the period is over, the holders' claimable USDC adds up to
    ///      everything delivered, less at most one unit of rounding per holder, and the plugin keeps nothing.
    function testFuzz_holdersReceiveEverythingOverThePeriod(
        uint96 aRaw,
        uint96 bRaw,
        uint96 cRaw,
        uint64 feesRaw,
        uint32[4] memory gaps
    ) public {
        _buy(alice, bound(aRaw, 1e18, 300_000_000e18));
        _buy(bob, bound(bRaw, 0, 300_000_000e18));
        _buy(carol, bound(cRaw, 0, 300_000_000e18));
        uint256 fees = bound(feesRaw, 1, 1e15);
        uint256 t0 = vm.getBlockTimestamp();
        _collectFees(fees);
        for (uint256 i; i < gaps.length; ++i) {
            vm.warp(vm.getBlockTimestamp() + bound(gaps[i], 0, 8 hours));
            holder.drip(address(token));
        }
        vm.warp(t0 + PERIOD);
        holder.drip(address(token));

        uint256 owed = token.claimable(alice) + token.claimable(bob) + token.claimable(carol);
        assertLe(owed, fees);
        assertLe(fees - owed, 3, "at most one unit of rounding per holder");
        assertEq(usdc.balanceOf(address(holder)), 0);
        assertEq(usdc.balanceOf(address(token)), fees);
    }
}

/// @notice A bot doing everything in one transaction: buy (a transfer out of the curve inventory, which approved it),
///         collect the pending creator fees to the plugin, drip and claim, sell (a transfer back).
contract Sniper {
    function attack(
        LaunchToken token,
        address inventory,
        uint256 tokens,
        MockLaunchpad launchpad,
        uint256 pile,
        HolderDistributionPlugin holder
    ) external returns (uint256 released, uint256 claimed) {
        token.transferFrom(inventory, address(this), tokens);
        launchpad.collect(address(token), pile);
        (released, claimed) = holder.dripAndClaim(address(token));
        token.transfer(inventory, tokens);
    }
}
