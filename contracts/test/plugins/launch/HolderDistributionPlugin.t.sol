// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IHolderDistributionPlugin} from "../../../interfaces/plugins/IHolderDistributionPlugin.sol";
import {HolderDistributionPlugin} from "../../../plugins/launch/HolderDistributionPlugin.sol";
import {LaunchToken} from "../../../launchpad/LaunchToken.sol";
import {MockLaunchpad, MockLaunchToken, MockLaunchPair} from "./LaunchPluginMocks.sol";
import {LaunchPluginTestBase, PluginConformanceTest} from "./LaunchPluginTestBase.sol";

contract HolderDistributionPluginConformanceTest is PluginConformanceTest {
    function _deployPlugin(address launchpad_) internal override returns (ILaunchFeePlugin) {
        return new HolderDistributionPlugin(launchpad_);
    }

    function _validData() internal pure override returns (bytes memory) {
        return "";
    }
}

/// @notice The plugin as a forwarder, against the mock launch token (which records what it is given and can be made
///         to under-pull).
contract HolderDistributionPluginTest is LaunchPluginTestBase {
    HolderDistributionPlugin internal holder;
    MockLaunchToken internal token;

    function setUp() public override {
        super.setUp();
        holder = new HolderDistributionPlugin(address(launchpad));
        token = _launch(address(holder), "");
    }

    function test_onLaunch_rejectsAnyData() public {
        MockLaunchToken t = _newToken();
        vm.expectRevert(ILaunchFeePlugin.DataNotEmpty.selector);
        launchpad.launch(address(t), creator, address(holder), address(0), hex"01");
        assertFalse(holder.isConfigured(address(t)));
    }

    /// @dev A collection goes straight to the token's distribute, all of it, in the same call; the plugin keeps
    ///      nothing and leaves no allowance.
    function test_onFees_forwardsEverythingToTheTokensDistribute() public {
        token.mint(alice, 100e18);
        usdc.mint(address(launchpad), 10e6);
        vm.expectEmit(true, false, false, true, address(holder));
        emit IHolderDistributionPlugin.Distributed(address(token), 10e6);
        launchpad.collect(address(token), 10e6);

        assertEq(token.totalDistributed(), 10e6);
        assertEq(token.distributeCalls(), 1);
        assertEq(usdc.balanceOf(address(token)), 10e6);
        assertEq(usdc.balanceOf(address(holder)), 0);
        assertEq(usdc.allowance(address(holder), address(token)), 0);
        assertEq(holder.usdcHeld(address(token)), 0);
        assertEq(holder.totalDistributed(address(token)), 10e6);
    }

    /// @dev Nothing holder-side can make a collection revert: with no eligible supply the token still takes the fees
    ///      (its stream waits for holders).
    function test_onFees_withNoEligibleSupplyStillForwards() public {
        assertEq(token.eligibleSupply(), 0);
        _collect(token, 10e6);
        _payDirect(address(holder), address(token), keeper, 5e6);
        assertEq(token.totalDistributed(), 15e6);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    function test_onFees_directPayerIsForwardedExactly() public {
        _payDirect(address(holder), address(token), keeper, 3e6);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(token.totalDistributed(), 3e6);
        assertEq(holder.totalDistributed(address(token)), 3e6);
    }

    function test_onFees_revertsWhenTheTokenUnderPulls() public {
        token.setDistributeShortfall(1);
        usdc.mint(address(launchpad), 10e6);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.PullMismatch.selector, address(token), 10e6, 10e6 - 1));
        launchpad.collect(address(token), 10e6);
        assertEq(usdc.balanceOf(address(launchpad)), 10e6, "the fees stay at the launchpad [D10]");
    }

    function test_perTokenIsolation() public {
        MockLaunchToken other = _launch(address(holder), "");
        _collect(token, 10e6);
        _collect(other, 5e6);
        assertEq(token.totalDistributed(), 10e6);
        assertEq(other.totalDistributed(), 5e6);
        assertEq(holder.totalDistributed(address(token)), 10e6);
        assertEq(holder.totalDistributed(address(other)), 5e6);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    function testFuzz_forwardsExactly(uint64[6] memory amounts) public {
        uint256 credited;
        for (uint256 i; i < amounts.length; ++i) {
            if (i % 2 == 0) _collect(token, amounts[i]);
            else _payDirect(address(holder), address(token), keeper, amounts[i]);
            credited += amounts[i];
            assertEq(token.totalDistributed(), credited);
            assertEq(holder.totalDistributed(address(token)), credited);
            assertEq(usdc.balanceOf(address(token)), credited);
            assertEq(usdc.balanceOf(address(holder)), 0);
        }
    }
}

/// @notice End to end with the real launch token: the plugin forwards, the token streams with continuous accrual.
///         This test contract deploys the token, so it is the token's launchpad: its balance is the curve inventory
///         (excluded from dividends), and a transfer out of it stands in for a buy, a transfer back for a sell.
/// @dev Time is read with vm.getBlockTimestamp(): under via-IR the optimizer may re-read TIMESTAMP after a vm.warp.
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

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _buy(address to, uint256 amount) internal {
        token.transfer(to, amount);
    }

    /// @dev `amount` of creator fees collected to the plugin, as collectCreatorFees does.
    function _collectFees(uint256 amount) internal {
        usdc.mint(address(launchpad), amount);
        launchpad.collect(address(token), amount);
    }

    function _snipe(uint256 tokens, uint256 pile) internal returns (uint256 claimed) {
        Sniper sniper = new Sniper();
        token.approve(address(sniper), tokens);
        claimed = sniper.attack(token, address(this), tokens, launchpad, pile);
        assertEq(usdc.balanceOf(address(sniper)), claimed);
        assertEq(token.balanceOf(address(sniper)), 0, "it sold everything it bought");
    }

    /// @dev Collected fees stream to the holders over a day; nothing is claimable in the collecting block.
    function test_collectedFeesStreamToHoldersOverADay() public {
        _buy(alice, 300_000_000e18);
        _buy(bob, 100_000_000e18);
        uint256 t0 = _now();
        _collectFees(96e6);
        assertEq(token.totalDistributed(), 96e6);
        assertEq(token.streamEnd(), t0 + PERIOD);
        assertEq(token.claimable(alice), 0);
        assertEq(usdc.balanceOf(address(holder)), 0);

        vm.warp(t0 + PERIOD);
        assertApproxEqAbs(token.claimable(alice), 72e6, 1);
        assertApproxEqAbs(token.claimable(bob), 24e6, 1);
        vm.prank(alice);
        token.claim();
        vm.prank(carol);
        token.claimFor(bob);
        assertApproxEqAbs(usdc.balanceOf(alice) + usdc.balanceOf(bob), 96e6, 2);
    }

    /// @dev A large pile of creator fees waits at the launchpad. A bot buys half the eligible supply, collects the
    ///      pile to the plugin, claims and sells, all in one transaction: it gets exactly 0. The holders who stay get
    ///      the pile over the next 24 hours.
    function test_sniper_getsNothingOfAPendingPile() public {
        _buy(alice, 100_000_000e18);
        _buy(bob, 100_000_000e18);
        uint256 pile = 1_000_000e6;
        usdc.mint(address(launchpad), pile);
        vm.warp(_now() + 3 days);

        assertEq(_snipe(200_000_000e18, pile), 0, "the bot got none of the pile");
        assertEq(token.totalDistributed(), pile);

        vm.warp(_now() + PERIOD);
        assertApproxEqAbs(token.claimable(alice), pile / 2, 1);
        assertApproxEqAbs(token.claimable(bob), pile / 2, 1);
    }

    /// @dev A stream nobody has claimed or touched for a day: the holders have already earned all of it, second by
    ///      second, so a bot buying half the supply, claiming and selling in one transaction gets exactly 0.
    function test_sniper_anIdleDaySandwichGetsNothing() public {
        _buy(alice, 100_000_000e18);
        _buy(bob, 100_000_000e18);
        _collectFees(10_000e6);
        vm.warp(_now() + PERIOD);
        uint256 aliceEarned = token.claimable(alice);
        assertApproxEqAbs(aliceEarned, 5_000e6, 1);

        assertEq(_snipe(200_000_000e18, 0), 0);
        assertEq(token.claimable(alice), aliceEarned, "the holders keep what they earned");
    }

    /// @dev The review's case: a 10,000 USDC stream, every holder sells, more than a day passes, a bot buys one token,
    ///      claims and sells in one transaction. It gets exactly 0: while nobody held, the stream was paused, not
    ///      matured.
    function test_sniper_afterEveryHolderSoldGetsNothing() public {
        _buy(alice, 100_000_000e18);
        uint256 t0 = _now();
        _collectFees(10_000e6);
        vm.warp(t0 + 1 hours);
        vm.prank(alice);
        token.transfer(address(this), 100_000_000e18); // alice sells back to the curve
        assertEq(token.eligibleSupply(), 0);
        uint256 owed = token.undistributed();

        vm.warp(t0 + 25 hours);
        assertEq(_snipe(1e18, 0), 0);
        assertEq(token.undistributed(), owed, "nothing matured while nobody held");
        assertEq(token.streamEnd(), t0 + PERIOD + 24 hours, "paused for exactly the time nobody held");
    }

    /// @dev Fees collected while nobody holds do not revert and do not pile up for the first buyer: the stream waits,
    ///      and the first buyer earns from its buy, over the full period.
    function test_collectionWithNoHoldersWaitsForTheFirst() public {
        uint256 t0 = _now();
        _collectFees(24e6);
        vm.warp(t0 + 5 days);
        _buy(alice, 1e18);
        assertEq(token.claimable(alice), 0);
        assertEq(token.streamEnd(), t0 + 5 days + PERIOD);
        vm.warp(t0 + 5 days + 6 hours);
        assertApproxEqAbs(token.claimable(alice), 6e6, 1);
    }

    /// @dev Random holdings and fees: after the period, the holders' claimable USDC adds up to everything collected,
    ///      less at most one unit of rounding per holder, and the plugin keeps nothing.
    function testFuzz_holdersReceiveEverything(uint96 aRaw, uint96 bRaw, uint96 cRaw, uint64 feesRaw) public {
        _buy(alice, bound(aRaw, 1e18, 300_000_000e18));
        _buy(bob, bound(bRaw, 0, 300_000_000e18));
        _buy(carol, bound(cRaw, 0, 300_000_000e18));
        uint256 fees = bound(feesRaw, 1, 1e15);
        _collectFees(fees);
        vm.warp(_now() + PERIOD);

        uint256 owed = token.claimable(alice) + token.claimable(bob) + token.claimable(carol);
        assertLe(owed, fees);
        assertLe(fees - owed, 3, "at most one unit of rounding per holder");
        assertEq(usdc.balanceOf(address(holder)), 0);
        assertEq(usdc.balanceOf(address(token)), fees);
    }
}

/// @notice A bot doing everything in one transaction: buy (a transfer out of the curve inventory, which approved it),
///         collect the pending creator fees to the plugin (`pile` may be 0), claim, sell (a transfer back).
contract Sniper {
    function attack(LaunchToken token, address inventory, uint256 tokens, MockLaunchpad launchpad, uint256 pile)
        external
        returns (uint256 claimed)
    {
        token.transferFrom(inventory, address(this), tokens);
        launchpad.collect(address(token), pile);
        claimed = token.claim();
        token.transfer(inventory, tokens);
    }
}
