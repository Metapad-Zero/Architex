// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IHolderDistributionPlugin} from "../../../interfaces/plugins/IHolderDistributionPlugin.sol";
import {HolderDistributionPlugin} from "../../../plugins/launch/HolderDistributionPlugin.sol";
import {MockLaunchToken} from "./LaunchPluginMocks.sol";
import {LaunchPluginTestBase, PluginConformanceTest} from "./LaunchPluginTestBase.sol";

contract HolderDistributionPluginConformanceTest is PluginConformanceTest {
    function _deployPlugin(address launchpad_) internal override returns (ILaunchFeePlugin) {
        return new HolderDistributionPlugin(launchpad_);
    }

    function _validData() internal pure override returns (bytes memory) {
        return "";
    }
}

contract HolderDistributionPluginTest is LaunchPluginTestBase {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

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

    // ─── Immediate distribution ───────────────────────────────────────────────

    function test_onFees_distributesImmediatelyWhenThereIsEligibleSupply() public {
        token.mint(alice, 100e18);

        usdc.mint(address(launchpad), 10e6);
        vm.expectEmit(true, false, false, true, address(holder));
        emit IHolderDistributionPlugin.Distributed(address(token), 10e6);
        launchpad.collect(address(token), 10e6);

        assertEq(token.totalDistributed(), 10e6);
        assertEq(usdc.balanceOf(address(token)), 10e6);
        assertEq(usdc.balanceOf(address(holder)), 0);
        assertEq(usdc.allowance(address(holder), address(token)), 0);
        assertEq(holder.usdcHeld(address(token)), 0);
        assertEq(holder.totalDistributed(address(token)), 10e6);
    }

    // ─── Held, then flushed ───────────────────────────────────────────────────

    function test_onFees_holdsWhenThereIsNoEligibleSupply() public {
        usdc.mint(address(launchpad), 10e6);
        vm.expectEmit(true, false, false, true, address(holder));
        emit IHolderDistributionPlugin.FeesHeld(address(token), 10e6);
        launchpad.collect(address(token), 10e6);

        assertEq(holder.usdcHeld(address(token)), 10e6);
        assertEq(usdc.balanceOf(address(holder)), 10e6);
        assertEq(token.totalDistributed(), 0);
        assertEq(holder.totalDistributed(address(token)), 0);
    }

    /// @dev Tokens held only by excluded accounts (curve inventory, pool, burn address) are not eligible supply.
    function test_onFees_holdsWhenOnlyExcludedAccountsHoldTokens() public {
        token.mint(address(launchpad), 800_000_000e18);
        token.mint(address(_pairOf(token)), 200_000_000e18);
        token.mint(DEAD, 1e18);
        assertEq(token.eligibleSupply(), 0);
        _collect(token, 10e6);
        assertEq(holder.usdcHeld(address(token)), 10e6);
    }

    function test_flush_revertsWhileThereIsNoEligibleSupply() public {
        _collect(token, 10e6);
        vm.expectRevert(abi.encodeWithSelector(IHolderDistributionPlugin.NoEligibleSupply.selector, address(token)));
        holder.flush(address(token));
    }

    function test_flush_distributesWhatIsHeldOnceThereIsEligibleSupply() public {
        _collect(token, 10e6);
        _collect(token, 2e6);
        assertEq(holder.usdcHeld(address(token)), 12e6);
        token.mint(bob, 1e18);

        vm.expectEmit(true, false, false, true, address(holder));
        emit IHolderDistributionPlugin.Distributed(address(token), 12e6);
        vm.prank(keeper);
        assertEq(holder.flush(address(token)), 12e6);

        assertEq(token.totalDistributed(), 12e6);
        assertEq(holder.usdcHeld(address(token)), 0);
        assertEq(usdc.balanceOf(address(holder)), 0);
        assertEq(usdc.allowance(address(holder), address(token)), 0);
        assertEq(holder.totalDistributed(address(token)), 12e6);
    }

    function test_onFees_nextDeliveryCarriesWhatWasHeld() public {
        _collect(token, 10e6);
        token.mint(alice, 1e18);
        _payDirect(address(holder), address(token), keeper, 5e6);
        assertEq(token.totalDistributed(), 15e6);
        assertEq(holder.usdcHeld(address(token)), 0);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    function test_flush_revertsWhenNothingIsHeld() public {
        token.mint(alice, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IHolderDistributionPlugin.NothingToFlush.selector, address(token)));
        holder.flush(address(token));
    }

    function test_flush_revertsForUnconfiguredToken() public {
        MockLaunchToken other = _launch(alice, "");
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotConfigured.selector, address(other)));
        holder.flush(address(other));
    }

    // ─── A token that does not pull what it is given ──────────────────────────

    function test_onFees_revertsWhenTheTokenUnderPulls() public {
        token.mint(alice, 1e18);
        token.setDistributeShortfall(1);
        usdc.mint(address(launchpad), 10e6);
        vm.expectRevert(
            abi.encodeWithSelector(ILaunchFeePlugin.PullMismatch.selector, address(token), 10e6, 10e6 - 1)
        );
        launchpad.collect(address(token), 10e6);
    }

    function test_flush_revertsWhenTheTokenUnderPulls() public {
        _collect(token, 10e6);
        token.mint(alice, 1e18);
        token.setDistributeShortfall(1);
        vm.expectRevert(
            abi.encodeWithSelector(ILaunchFeePlugin.PullMismatch.selector, address(token), 10e6, 10e6 - 1)
        );
        holder.flush(address(token));
        assertEq(holder.usdcHeld(address(token)), 10e6);
    }

    // ─── Isolation ────────────────────────────────────────────────────────────

    function test_perTokenIsolation() public {
        MockLaunchToken other = _launch(address(holder), "");
        other.mint(alice, 1e18);

        _collect(token, 10e6); // no eligible supply: held for `token`
        _collect(other, 5e6); // eligible: distributed to `other`'s holders

        assertEq(holder.usdcHeld(address(token)), 10e6);
        assertEq(holder.usdcHeld(address(other)), 0);
        assertEq(other.totalDistributed(), 5e6);
        assertEq(token.totalDistributed(), 0);

        vm.expectRevert(abi.encodeWithSelector(IHolderDistributionPlugin.NothingToFlush.selector, address(other)));
        holder.flush(address(other));

        token.mint(carol, 1e18);
        holder.flush(address(token));
        assertEq(token.totalDistributed(), 10e6);
        assertEq(other.totalDistributed(), 5e6);
        assertEq(usdc.balanceOf(address(holder)), 0);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev Deliveries with eligibility switching on and off: held + distributed always equals what was credited,
    ///      everything goes out as soon as there is eligible supply, and the plugin holds exactly what it owes.
    function testFuzz_heldPlusDistributedEqualsCredited(uint64[6] memory amounts, uint8 eligibilityMask) public {
        uint256 credited;
        for (uint256 i; i < amounts.length; ++i) {
            bool eligible = (eligibilityMask >> i) & 1 == 1;
            token.forceEligibleSupply(eligible ? 1e18 : 0);
            _collect(token, amounts[i]);
            credited += amounts[i];
            // A zero delivery is a no-op, so it does not flush; any real delivery with holders sends everything.
            if (eligible && amounts[i] != 0) assertEq(holder.usdcHeld(address(token)), 0, "nothing waits");
            assertEq(holder.usdcHeld(address(token)) + holder.totalDistributed(address(token)), credited);
            assertEq(usdc.balanceOf(address(holder)), holder.usdcHeld(address(token)));
            assertEq(token.totalDistributed(), holder.totalDistributed(address(token)));
        }
    }
}
