// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IComboPlugin} from "../../../interfaces/plugins/IComboPlugin.sol";
import {ISplitPlugin} from "../../../interfaces/plugins/ISplitPlugin.sol";
import {ComboPlugin} from "../../../plugins/launch/ComboPlugin.sol";
import {SplitPlugin} from "../../../plugins/launch/SplitPlugin.sol";
import {BuybackBurnPlugin} from "../../../plugins/launch/BuybackBurnPlugin.sol";
import {HolderDistributionPlugin} from "../../../plugins/launch/HolderDistributionPlugin.sol";
import {
    MockLaunchToken, RecordingPlugin, ShortPullPlugin, ReentrantPlugin
} from "./LaunchPluginMocks.sol";
import {LaunchPluginTestBase, PluginConformanceTest} from "./LaunchPluginTestBase.sol";

contract ComboPluginConformanceTest is PluginConformanceTest {
    function _deployPlugin(address launchpad_) internal override returns (ILaunchFeePlugin) {
        return new ComboPlugin(launchpad_);
    }

    function _validData() internal view override returns (bytes memory) {
        return abi.encode(_addrs(alice), _u16s(10_000), _datas(""));
    }
}

contract ComboPluginTest is LaunchPluginTestBase {
    ComboPlugin internal combo;
    SplitPlugin internal split;
    BuybackBurnPlugin internal buyback;
    HolderDistributionPlugin internal holder;

    function setUp() public override {
        super.setUp();
        combo = new ComboPlugin(address(launchpad));
        split = new SplitPlugin(address(launchpad));
        buyback = new BuybackBurnPlugin(address(launchpad));
        holder = new HolderDistributionPlugin(address(launchpad));
    }

    function _data(address[] memory targets, uint16[] memory bps, bytes[] memory datas)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(targets, bps, datas);
    }

    function _launchCombo(address[] memory targets, uint16[] memory bps, bytes[] memory datas)
        internal
        returns (MockLaunchToken)
    {
        return _launch(address(combo), _data(targets, bps, datas));
    }

    /// @dev Launching with `data` must revert with `err` and leave nothing configured.
    function _expectLaunchRevert(bytes memory data, bytes memory err) internal {
        MockLaunchToken token = _newToken();
        vm.expectRevert(err);
        launchpad.launch(address(token), creator, address(combo), address(0), data);
        assertFalse(combo.isConfigured(address(token)));
    }

    function _splitData() internal view returns (bytes memory) {
        return abi.encode(_addrs(alice, bob), _uints(1, 1));
    }

    /// @dev Split (alice, bob 1:1) 50%, buyback 30%, holders 10%, carol's wallet 10%.
    function _launchFullCombo() internal returns (MockLaunchToken) {
        return _launchCombo(
            _addrs(address(split), address(buyback), address(holder), carol),
            _u16s(5000, 3000, 1000, 1000),
            _datas(_splitData(), "", "", "")
        );
    }

    // ─── Configuration validation ─────────────────────────────────────────────

    function test_onLaunch_rejectsNoEntries() public {
        _expectLaunchRevert(
            _data(new address[](0), new uint16[](0), new bytes[](0)),
            abi.encodeWithSelector(IComboPlugin.InvalidEntryCount.selector, 0)
        );
    }

    function test_onLaunch_rejectsMoreThanFiveEntries() public {
        address[] memory targets = new address[](6);
        uint16[] memory bps = new uint16[](6);
        bytes[] memory datas = new bytes[](6);
        for (uint256 i; i < 6; ++i) {
            targets[i] = address(uint160(0x20000 + i));
            bps[i] = i == 5 ? 5000 : 1000;
        }
        _expectLaunchRevert(_data(targets, bps, datas), abi.encodeWithSelector(IComboPlugin.InvalidEntryCount.selector, 6));
    }

    function test_onLaunch_acceptsFiveEntries() public {
        address[] memory targets = new address[](5);
        uint16[] memory bps = new uint16[](5);
        bytes[] memory datas = new bytes[](5);
        for (uint256 i; i < 5; ++i) {
            targets[i] = address(uint160(0x20000 + i));
            bps[i] = 2000;
        }
        MockLaunchToken token = _launchCombo(targets, bps, datas);
        (address[] memory storedTargets, uint16[] memory storedBps, bool[] memory isPlugin) =
            combo.allocationOf(address(token));
        assertEq(storedTargets, targets);
        assertEq(storedBps.length, 5);
        for (uint256 i; i < 5; ++i) {
            assertEq(storedBps[i], 2000);
            assertFalse(isPlugin[i]);
        }
    }

    function test_onLaunch_rejectsLengthMismatches() public {
        _expectLaunchRevert(
            _data(_addrs(alice, bob), _u16s(10_000), _datas("", "")),
            abi.encodeWithSelector(ILaunchFeePlugin.LengthMismatch.selector)
        );
        _expectLaunchRevert(
            _data(_addrs(alice, bob), _u16s(5000, 5000), _datas("")),
            abi.encodeWithSelector(ILaunchFeePlugin.LengthMismatch.selector)
        );
    }

    function test_onLaunch_rejectsZeroAddressAndItself() public {
        _expectLaunchRevert(
            _data(_addrs(alice, address(0)), _u16s(5000, 5000), _datas("", "")),
            abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, address(0))
        );
        _expectLaunchRevert(
            _data(_addrs(alice, address(combo)), _u16s(5000, 5000), _datas("", "")),
            abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, address(combo))
        );
    }

    function test_onLaunch_rejectsDestinationsThatWouldStrandFees() public {
        address[2] memory bad = [address(launchpad), address(usdc)];
        for (uint256 i; i < bad.length; ++i) {
            _expectLaunchRevert(
                _data(_addrs(alice, bad[i]), _u16s(5000, 5000), _datas("", "")),
                abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad[i])
            );
        }
        MockLaunchToken token = _newToken();
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, address(token)));
        launchpad.launch(
            address(token), creator, address(combo), address(0), _data(_addrs(address(token)), _u16s(10_000), _datas(""))
        );
    }

    function test_onLaunch_rejectsDuplicates() public {
        _expectLaunchRevert(
            _data(_addrs(alice, bob, alice), _u16s(3000, 3000, 4000), _datas("", "", "")),
            abi.encodeWithSelector(IComboPlugin.DuplicateEntry.selector, alice)
        );
        _expectLaunchRevert(
            _data(_addrs(address(buyback), address(buyback)), _u16s(5000, 5000), _datas("", "")),
            abi.encodeWithSelector(IComboPlugin.DuplicateEntry.selector, address(buyback))
        );
    }

    function test_onLaunch_rejectsZeroBps() public {
        _expectLaunchRevert(
            _data(_addrs(alice, bob, carol), _u16s(5000, 0, 5000), _datas("", "", "")),
            abi.encodeWithSelector(IComboPlugin.ZeroBps.selector, bob)
        );
    }

    function test_onLaunch_rejectsBpsNotSummingToTenThousand() public {
        _expectLaunchRevert(
            _data(_addrs(alice, bob), _u16s(5000, 4999), _datas("", "")),
            abi.encodeWithSelector(IComboPlugin.BpsSumNot10000.selector, 9999)
        );
        _expectLaunchRevert(
            _data(_addrs(alice, bob), _u16s(5000, 5001), _datas("", "")),
            abi.encodeWithSelector(IComboPlugin.BpsSumNot10000.selector, 10_001)
        );
        _expectLaunchRevert(
            _data(_addrs(alice, bob, carol), _u16s(65_535, 65_535, 65_535), _datas("", "", "")),
            abi.encodeWithSelector(IComboPlugin.BpsSumNot10000.selector, 3 * uint256(65_535))
        );
    }

    /// @dev Configuration meant for a plugin, given to an address that is not one, would be silently dropped.
    function test_onLaunch_rejectsDataForANonPluginEntry() public {
        _expectLaunchRevert(
            _data(_addrs(alice, bob), _u16s(5000, 5000), _datas(hex"01", "")),
            abi.encodeWithSelector(IComboPlugin.DataForNonPlugin.selector, alice)
        );
    }

    function test_onLaunch_rejectsNonCanonicalEncoding() public {
        bytes memory canonical = _data(_addrs(alice), _u16s(10_000), _datas(""));
        _expectLaunchRevert(
            bytes.concat(canonical, bytes32(0)), abi.encodeWithSelector(ILaunchFeePlugin.NonCanonicalData.selector)
        );
    }

    function test_onLaunch_rejectsMalformedData() public {
        MockLaunchToken token = _newToken();
        vm.expectRevert();
        launchpad.launch(address(token), creator, address(combo), address(0), hex"deadbeef");
    }

    /// @dev A sub-plugin that rejects its configuration reverts the whole launch (createToken reverts).
    function test_onLaunch_subPluginRejectingItsDataRevertsTheLaunch() public {
        _expectLaunchRevert(
            _data(_addrs(address(split), alice), _u16s(5000, 5000), _datas(abi.encode(new address[](0), new uint256[](0)), "")),
            abi.encodeWithSelector(ISplitPlugin.InvalidPayeeCount.selector, 0)
        );
        _expectLaunchRevert(
            _data(_addrs(address(buyback), alice), _u16s(5000, 5000), _datas(hex"00", "")),
            abi.encodeWithSelector(ILaunchFeePlugin.DataNotEmpty.selector)
        );
    }

    // ─── Configuration of sub-plugins ─────────────────────────────────────────

    function test_onLaunch_storesTheAllocationAndConfiguresEveryPluginEntry() public {
        MockLaunchToken token = _newToken();
        bytes memory data = _data(
            _addrs(address(split), address(buyback), address(holder), carol),
            _u16s(5000, 3000, 1000, 1000),
            _datas(_splitData(), "", "", "")
        );
        bool[] memory expectedIsPlugin = new bool[](4);
        (expectedIsPlugin[0], expectedIsPlugin[1], expectedIsPlugin[2]) = (true, true, true);
        vm.expectEmit(true, false, false, true, address(combo));
        emit IComboPlugin.ComboConfigured(
            address(token),
            _addrs(address(split), address(buyback), address(holder), carol),
            _u16s(5000, 3000, 1000, 1000),
            expectedIsPlugin
        );
        launchpad.launch(address(token), creator, address(combo), address(0), data);

        assertTrue(combo.isConfigured(address(token)));
        assertTrue(split.isConfigured(address(token)), "split configured through the Combo");
        assertTrue(buyback.isConfigured(address(token)), "buyback configured through the Combo");
        assertTrue(holder.isConfigured(address(token)), "holder configured through the Combo");

        (address[] memory targets, uint16[] memory bps, bool[] memory isPlugin) = combo.allocationOf(address(token));
        assertEq(targets, _addrs(address(split), address(buyback), address(holder), carol));
        assertEq(bps.length, 4);
        assertEq(bps[0], 5000);
        assertEq(bps[3], 1000);
        assertTrue(isPlugin[0] && isPlugin[1] && isPlugin[2]);
        assertFalse(isPlugin[3]);

        (address[] memory payees, uint256[] memory shares) = split.payeesOf(address(token));
        assertEq(payees, _addrs(alice, bob));
        assertEq(shares, _uints(1, 1));
    }

    function test_onLaunch_forwardsDataToACustomPlugin() public {
        RecordingPlugin custom = new RecordingPlugin(address(usdc));
        MockLaunchToken token = _launchCombo(_addrs(address(custom), alice), _u16s(2500, 7500), _datas(hex"c0ffee", ""));
        assertEq(custom.launchData(address(token)), hex"c0ffee");
        assertEq(custom.launchCalls(), 1);
    }

    /// @dev Once a token's plugin is the Combo, nobody else can configure a listed plugin for it: not an attacker,
    ///      not the launchpad (the Combo is the token's plugin, not Split), and not the Combo again (write-once).
    function test_subPluginsCannotBeConfiguredForTheTokenByAnyoneElse() public {
        MockLaunchToken token = _launchCombo(_addrs(carol), _u16s(10_000), _datas(""));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.Unauthorized.selector, attacker));
        split.onLaunch(address(token), attacker, abi.encode(_addrs(attacker), _uints(1)));

        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotTokenPlugin.selector, address(token)));
        launchpad.callOnLaunch(address(split), address(token), creator, abi.encode(_addrs(attacker), _uints(1)));

        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.AlreadyConfigured.selector, address(token)));
        launchpad.callOnLaunch(address(combo), address(token), creator, _data(_addrs(address(split)), _u16s(10_000), _datas(abi.encode(_addrs(attacker), _uints(1)))));

        assertFalse(split.isConfigured(address(token)));
    }

    /// @dev Documented limitation: a Combo inside a Combo cannot configure listed plugins, because only the token's
    ///      registered plugin (the outer Combo) may configure them. The launch reverts; nothing is lost.
    function test_nestedComboCannotConfigureListedPlugins() public {
        ComboPlugin inner = new ComboPlugin(address(launchpad));
        bytes memory innerData = _data(_addrs(address(split)), _u16s(10_000), _datas(_splitData()));
        _expectLaunchRevert(
            _data(_addrs(address(inner)), _u16s(10_000), _datas(innerData)),
            abi.encodeWithSelector(ILaunchFeePlugin.Unauthorized.selector, address(inner))
        );
    }

    // ─── Fees ─────────────────────────────────────────────────────────────────

    function test_onFees_splitsExactlyAndKeepsNothing() public {
        MockLaunchToken token = _launchFullCombo();
        uint256 amount = 1_000_000_007;

        uint256[] memory slices = combo.previewSplit(address(token), amount);
        assertEq(slices, _uints4(500_000_003, 300_000_002, 100_000_000, 100_000_002));

        usdc.mint(address(launchpad), amount);
        vm.expectEmit(true, true, false, true, address(combo));
        emit IComboPlugin.FeesForwarded(address(token), address(split), 500_000_003, true);
        vm.expectEmit(true, true, false, true, address(combo));
        emit IComboPlugin.FeesForwarded(address(token), address(buyback), 300_000_002, true);
        vm.expectEmit(true, true, false, true, address(combo));
        emit IComboPlugin.FeesForwarded(address(token), address(holder), 100_000_000, true);
        vm.expectEmit(true, true, false, true, address(combo));
        emit IComboPlugin.FeesForwarded(address(token), carol, 100_000_002, false);
        launchpad.collect(address(token), amount);

        assertEq(split.totalReceived(address(token)), 500_000_003);
        assertEq(buyback.usdcHeld(address(token)), 300_000_002);
        assertEq(holder.usdcHeld(address(token)), 100_000_000); // no holders yet: held
        assertEq(usdc.balanceOf(carol), 100_000_002);
        assertEq(
            split.totalReceived(address(token)) + buyback.usdcHeld(address(token)) + holder.usdcHeld(address(token))
                + usdc.balanceOf(carol),
            amount
        );
        assertEq(usdc.balanceOf(address(combo)), 0);
        assertEq(combo.usdcHeld(address(token)), 0);
        assertEq(usdc.allowance(address(combo), address(split)), 0);
        assertEq(usdc.allowance(address(combo), address(buyback)), 0);
        assertEq(usdc.allowance(address(combo), address(holder)), 0);
    }

    /// @dev Fees through the Combo then work in every sub-plugin exactly as if it were the token's own plugin.
    function test_endToEnd_everySubPluginWorksBehindTheCombo() public {
        MockLaunchToken token = _launchFullCombo();
        token.mint(dave, 1e18); // a holder, so the holder slice distributes at once
        _collect(token, 1000e6);

        assertEq(token.totalDistributed(), 100e6);
        split.release(address(token), alice);
        split.release(address(token), bob);
        assertEq(usdc.balanceOf(alice), 250e6);
        assertEq(usdc.balanceOf(bob), 250e6);

        vm.prank(keeper);
        (uint256 spent, uint256 burned) = buyback.run(address(token));
        assertEq(spent, 20_833_333);
        assertEq(token.balanceOf(address(buyback)), 0);
        assertEq(token.totalBurned(), burned);

        assertEq(usdc.balanceOf(carol), 100e6);
        assertEq(usdc.balanceOf(address(combo)), 0);
    }

    function test_onFees_directPayerIsPulledExactly() public {
        MockLaunchToken token = _launchFullCombo();
        _payDirect(address(combo), address(token), keeper, 10_000);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(split.totalReceived(address(token)), 5000);
        assertEq(buyback.usdcHeld(address(token)), 3000);
        assertEq(holder.usdcHeld(address(token)), 1000);
        assertEq(usdc.balanceOf(carol), 1000);
    }

    function test_onFees_skipsZeroSlices() public {
        MockLaunchToken token =
            _launchCombo(_addrs(address(split), carol), _u16s(9999, 1), _datas(_splitData(), ""));
        _collect(token, 1); // 1 * 9999 / 10,000 = 0 for the split; the last entry takes the remaining 1
        assertEq(split.totalReceived(address(token)), 0);
        assertEq(usdc.balanceOf(carol), 1);
        assertEq(usdc.balanceOf(address(combo)), 0);
    }

    function test_onFees_customPluginEntryIsPaidThroughItsHook() public {
        RecordingPlugin custom = new RecordingPlugin(address(usdc));
        MockLaunchToken token = _launchCombo(_addrs(address(custom), alice), _u16s(2500, 7500), _datas("", ""));
        _collect(token, 1000);
        assertEq(custom.received(address(token)), 250);
        assertEq(usdc.balanceOf(address(custom)), 250);
        assertEq(usdc.balanceOf(alice), 750);
    }

    // ─── Sub-plugins that do not pull exactly ─────────────────────────────────

    function test_onFees_revertsWhenASubPluginUnderPulls() public {
        ShortPullPlugin short = new ShortPullPlugin(address(usdc), 1, 0);
        MockLaunchToken token = _launchCombo(_addrs(address(short), alice), _u16s(5000, 5000), _datas("", ""));
        usdc.mint(address(launchpad), 100);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.PullMismatch.selector, address(short), 50, 49));
        launchpad.collect(address(token), 100);
    }

    function test_onFees_revertsWhenASubPluginPullsNothing() public {
        ShortPullPlugin short = new ShortPullPlugin(address(usdc), type(uint256).max, 0);
        MockLaunchToken token = _launchCombo(_addrs(address(short), alice), _u16s(5000, 5000), _datas("", ""));
        usdc.mint(address(launchpad), 100);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.PullMismatch.selector, address(short), 50, 0));
        launchpad.collect(address(token), 100);
    }

    function test_onFees_revertsWhenASubPluginPaysPartBack() public {
        ShortPullPlugin short = new ShortPullPlugin(address(usdc), 0, 1);
        MockLaunchToken token = _launchCombo(_addrs(address(short), alice), _u16s(5000, 5000), _datas("", ""));
        usdc.mint(address(launchpad), 100);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.PullMismatch.selector, address(short), 50, 49));
        launchpad.collect(address(token), 100);
    }

    function test_onFees_revertsWhenASubPluginReenters() public {
        ReentrantPlugin reentrant = new ReentrantPlugin(address(usdc));
        MockLaunchToken token = _launchCombo(_addrs(address(reentrant), alice), _u16s(5000, 5000), _datas("", ""));
        usdc.mint(address(launchpad), 100);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        launchpad.collect(address(token), 100);
    }

    // ─── Views and isolation ──────────────────────────────────────────────────

    function test_viewsForAnUnconfiguredToken() public view {
        (address[] memory targets, uint16[] memory bps, bool[] memory isPlugin) = combo.allocationOf(alice);
        assertEq(targets.length, 0);
        assertEq(bps.length, 0);
        assertEq(isPlugin.length, 0);
        assertEq(combo.previewSplit(alice, 1e6).length, 0);
        assertEq(combo.MAX_ENTRIES(), 5);
        assertEq(combo.TOTAL_BPS(), 10_000);
    }

    function test_perTokenIsolation() public {
        MockLaunchToken tokenA = _launchCombo(_addrs(alice), _u16s(10_000), _datas(""));
        MockLaunchToken tokenB =
            _launchCombo(_addrs(address(split), dave), _u16s(5000, 5000), _datas(abi.encode(_addrs(bob, carol), _uints(1, 1)), ""));

        _collect(tokenA, 700);
        _collect(tokenB, 1000);

        assertEq(usdc.balanceOf(alice), 700);
        assertEq(usdc.balanceOf(dave), 500);
        assertEq(split.totalReceived(address(tokenB)), 500);
        assertEq(split.totalReceived(address(tokenA)), 0);
        assertFalse(split.isConfigured(address(tokenA)));
        assertEq(usdc.balanceOf(address(combo)), 0);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev Any allocation of 1 to 5 entries summing to 10,000 bps, any amount: the slices sum to exactly the
    ///      amount, each is `amount * bps / 10,000` except the last (which takes the remainder), and the Combo keeps
    ///      nothing.
    function testFuzz_onFees_slicesSumExactly(uint64 amountRaw, uint8 countRaw, uint16[4] memory bpsRaw) public {
        uint256 count = bound(countRaw, 1, 5);
        uint256 amount = bound(amountRaw, 0, 1e15);
        address[] memory targets = new address[](count);
        uint16[] memory bps = new uint16[](count);
        bytes[] memory datas = new bytes[](count);
        uint256 remainingBps = 10_000;
        for (uint256 i; i < count; ++i) {
            targets[i] = address(uint160(0x30000 + i));
            if (i + 1 == count) {
                bps[i] = uint16(remainingBps);
            } else {
                bps[i] = uint16(bound(bpsRaw[i], 1, remainingBps - (count - 1 - i)));
                remainingBps -= bps[i];
            }
        }
        MockLaunchToken token = _launchCombo(targets, bps, datas);
        _collect(token, amount);

        uint256 total;
        uint256 expectedBeforeLast;
        for (uint256 i; i < count; ++i) {
            uint256 got = usdc.balanceOf(targets[i]);
            if (i + 1 < count) {
                assertEq(got, (amount * bps[i]) / 10_000);
                expectedBeforeLast += got;
            } else {
                assertEq(got, amount - expectedBeforeLast);
            }
            total += got;
        }
        assertEq(total, amount);
        assertEq(usdc.balanceOf(address(combo)), 0);
    }

    function _uints4(uint256 a, uint256 b, uint256 c, uint256 d) internal pure returns (uint256[] memory r) {
        r = new uint256[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }
}
