// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {stdError} from "forge-std/StdError.sol";
import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {ISplitPlugin} from "../../../interfaces/plugins/ISplitPlugin.sol";
import {SplitPlugin} from "../../../plugins/launch/SplitPlugin.sol";
import {MockLaunchToken} from "./LaunchPluginMocks.sol";
import {LaunchPluginTestBase, PluginConformanceTest} from "./LaunchPluginTestBase.sol";

contract SplitPluginConformanceTest is PluginConformanceTest {
    function _deployPlugin(address launchpad_) internal override returns (ILaunchFeePlugin) {
        return new SplitPlugin(launchpad_);
    }

    function _validData() internal view override returns (bytes memory) {
        return abi.encode(_addrs(alice, bob), _uints(1, 1));
    }
}

contract SplitPluginTest is LaunchPluginTestBase {
    SplitPlugin internal split;

    function setUp() public override {
        super.setUp();
        split = new SplitPlugin(address(launchpad));
    }

    function _launchSplit(address[] memory payees, uint256[] memory shares) internal returns (MockLaunchToken) {
        return _launch(address(split), abi.encode(payees, shares));
    }

    /// @dev Launching with `data` must revert with `err`, and leave nothing behind.
    function _expectLaunchRevert(bytes memory data, bytes memory err) internal {
        MockLaunchToken token = _newToken();
        vm.expectRevert(err);
        launchpad.launch(address(token), creator, address(split), address(0), data);
        assertFalse(split.isConfigured(address(token)));
    }

    function _payees(uint256 count) internal pure returns (address[] memory payees, uint256[] memory shares) {
        payees = new address[](count);
        shares = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            payees[i] = address(uint160(0x10000 + i));
            shares[i] = i + 1;
        }
    }

    // ─── Configuration validation ─────────────────────────────────────────────

    function test_onLaunch_rejectsNoPayees() public {
        _expectLaunchRevert(
            abi.encode(new address[](0), new uint256[](0)),
            abi.encodeWithSelector(ISplitPlugin.InvalidPayeeCount.selector, 0)
        );
    }

    function test_onLaunch_rejectsMoreThanTwentyPayees() public {
        (address[] memory payees, uint256[] memory shares) = _payees(21);
        _expectLaunchRevert(
            abi.encode(payees, shares), abi.encodeWithSelector(ISplitPlugin.InvalidPayeeCount.selector, 21)
        );
    }

    function test_onLaunch_acceptsTwentyPayees() public {
        (address[] memory payees, uint256[] memory shares) = _payees(20);
        MockLaunchToken token = _launchSplit(payees, shares);
        (address[] memory storedPayees, uint256[] memory storedShares) = split.payeesOf(address(token));
        assertEq(storedPayees, payees);
        assertEq(storedShares, shares);
        assertEq(split.totalShares(address(token)), 210);
    }

    function test_onLaunch_rejectsLengthMismatch() public {
        _expectLaunchRevert(
            abi.encode(_addrs(alice, bob), _uints(1)), abi.encodeWithSelector(ILaunchFeePlugin.LengthMismatch.selector)
        );
        _expectLaunchRevert(
            abi.encode(_addrs(alice), _uints(1, 1)), abi.encodeWithSelector(ILaunchFeePlugin.LengthMismatch.selector)
        );
    }

    function test_onLaunch_rejectsZeroAddressPayee() public {
        _expectLaunchRevert(
            abi.encode(_addrs(alice, address(0)), _uints(1, 1)),
            abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, address(0))
        );
    }

    function test_onLaunch_rejectsDuplicatePayee() public {
        _expectLaunchRevert(
            abi.encode(_addrs(alice, bob, alice), _uints(1, 2, 3)),
            abi.encodeWithSelector(ISplitPlugin.DuplicatePayee.selector, alice)
        );
    }

    function test_onLaunch_rejectsZeroShare() public {
        _expectLaunchRevert(
            abi.encode(_addrs(alice, bob), _uints(1, 0)), abi.encodeWithSelector(ISplitPlugin.ZeroShare.selector, bob)
        );
    }

    /// @dev USDC sent to any of these would be stranded, or (this plugin) would break the per-token accounting.
    function test_onLaunch_rejectsPayeesThatWouldStrandFees() public {
        address[4] memory bad = [address(split), address(launchpad), address(usdc), address(0)];
        for (uint256 i; i < bad.length; ++i) {
            _expectLaunchRevert(
                abi.encode(_addrs(alice, bad[i]), _uints(1, 1)),
                abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad[i])
            );
        }
        // The token itself (its address is known before onLaunch runs).
        MockLaunchToken token = _newToken();
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, address(token)));
        launchpad.launch(address(token), creator, address(split), address(0), abi.encode(_addrs(address(token)), _uints(1)));
    }

    function test_onLaunch_rejectsSharesWhoseSumOverflows() public {
        _expectLaunchRevert(abi.encode(_addrs(alice, bob), _uints(type(uint256).max, 1)), stdError.arithmeticError);
    }

    function test_onLaunch_rejectsNonCanonicalEncoding() public {
        bytes memory canonical = abi.encode(_addrs(alice, bob), _uints(1, 1));
        _expectLaunchRevert(
            bytes.concat(canonical, bytes32(0)), abi.encodeWithSelector(ILaunchFeePlugin.NonCanonicalData.selector)
        );
        // The same values with the shares array placed after a one-word gap: it decodes to exactly the same
        // payees and shares, but it is not the canonical encoding, so it is rejected.
        bytes memory gapped = abi.encode(uint256(0x40), uint256(0xc0), uint256(2), alice, bob, uint256(0), uint256(2));
        gapped = bytes.concat(gapped, abi.encode(uint256(1), uint256(1)));
        (address[] memory p, uint256[] memory s) = abi.decode(gapped, (address[], uint256[]));
        assertEq(p, _addrs(alice, bob));
        assertEq(s, _uints(1, 1));
        _expectLaunchRevert(gapped, abi.encodeWithSelector(ILaunchFeePlugin.NonCanonicalData.selector));
    }

    function test_onLaunch_rejectsMalformedData() public {
        bytes[3] memory malformed = [bytes(""), hex"00", abi.encode(uint256(0x40))];
        for (uint256 i; i < malformed.length; ++i) {
            MockLaunchToken token = _newToken();
            vm.expectRevert();
            launchpad.launch(address(token), creator, address(split), address(0), malformed[i]);
        }
    }

    function test_onLaunch_storesSplitAndEmits() public {
        MockLaunchToken token = _newToken();
        vm.expectEmit(true, false, false, true, address(split));
        emit ISplitPlugin.SplitConfigured(address(token), _addrs(alice, bob, carol), _uints(50, 30, 20));
        launchpad.launch(address(token), creator, address(split), address(0), abi.encode(_addrs(alice, bob, carol), _uints(50, 30, 20)));

        assertEq(split.sharesOf(address(token), alice), 50);
        assertEq(split.sharesOf(address(token), bob), 30);
        assertEq(split.sharesOf(address(token), carol), 20);
        assertEq(split.sharesOf(address(token), dave), 0);
        assertEq(split.totalShares(address(token)), 100);
    }

    // ─── Release ──────────────────────────────────────────────────────────────

    function test_release_splitsByShare() public {
        MockLaunchToken token = _launchSplit(_addrs(alice, bob, carol), _uints(50, 30, 20));
        _collect(token, 1000e6);

        assertEq(split.releasable(address(token), alice), 500e6);
        assertEq(split.releasable(address(token), bob), 300e6);
        assertEq(split.releasable(address(token), carol), 200e6);

        vm.expectEmit(true, true, false, true, address(split));
        emit ISplitPlugin.Released(address(token), alice, 500e6);
        assertEq(split.release(address(token), alice), 500e6);
        assertEq(usdc.balanceOf(alice), 500e6);
        assertEq(split.releasable(address(token), alice), 0);
        assertEq(split.released(address(token), alice), 500e6);
        assertEq(split.totalReleased(address(token)), 500e6);
        assertEq(split.usdcHeld(address(token)), 500e6);
        assertEq(usdc.balanceOf(address(split)), 500e6);
    }

    function test_release_anyoneCanTriggerAndThePayeeIsPaid() public {
        MockLaunchToken token = _launchSplit(_addrs(alice, bob), _uints(1, 1));
        _collect(token, 100e6);
        vm.prank(attacker);
        split.release(address(token), alice);
        assertEq(usdc.balanceOf(alice), 50e6);
        assertEq(usdc.balanceOf(attacker), 0);
    }

    function test_release_revertsWhenNothingIsOwed() public {
        MockLaunchToken token = _launchSplit(_addrs(alice, bob), _uints(1, 1));
        vm.expectRevert(abi.encodeWithSelector(ISplitPlugin.NothingToRelease.selector, address(token), alice));
        split.release(address(token), alice);

        _collect(token, 100e6);
        split.release(address(token), alice);
        vm.expectRevert(abi.encodeWithSelector(ISplitPlugin.NothingToRelease.selector, address(token), alice));
        split.release(address(token), alice);

        vm.expectRevert(abi.encodeWithSelector(ISplitPlugin.NothingToRelease.selector, address(token), carol));
        split.release(address(token), carol);
    }

    function test_release_accountsForFeesArrivingAfterARelease() public {
        MockLaunchToken token = _launchSplit(_addrs(alice, bob), _uints(1, 1));
        _collect(token, 100e6);
        split.release(address(token), alice);
        _payDirect(address(split), address(token), keeper, 100e6);
        assertEq(split.totalReceived(address(token)), 200e6);
        assertEq(split.releasable(address(token), alice), 50e6);
        assertEq(split.releasable(address(token), bob), 100e6);
        split.release(address(token), alice);
        split.release(address(token), bob);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(address(split)), 0);
    }

    function test_release_roundingDustStaysAndIsAccounted() public {
        MockLaunchToken token = _launchSplit(_addrs(alice, bob, carol), _uints(1, 1, 1));
        _collect(token, 100);
        split.release(address(token), alice);
        split.release(address(token), bob);
        split.release(address(token), carol);
        assertEq(usdc.balanceOf(alice), 33);
        assertEq(usdc.balanceOf(bob), 33);
        assertEq(usdc.balanceOf(carol), 33);
        assertEq(split.usdcHeld(address(token)), 1);
        assertEq(usdc.balanceOf(address(split)), 1);
    }

    function test_release_hugeSharesDoNotOverflow() public {
        uint256 big = 2 ** 250;
        MockLaunchToken token = _launchSplit(_addrs(alice, bob), _uints(big, big * 3));
        _collect(token, 1_000_000e6);
        assertEq(split.releasable(address(token), alice), 250_000e6);
        assertEq(split.releasable(address(token), bob), 750_000e6);
        split.release(address(token), bob);
        assertEq(usdc.balanceOf(bob), 750_000e6);
    }

    /// @dev The same payee on two tokens, with different shares: each token's fees stay with that token.
    function test_perTokenIsolation() public {
        MockLaunchToken tokenA = _launchSplit(_addrs(alice, bob), _uints(1, 1));
        MockLaunchToken tokenB = _launchSplit(_addrs(alice, carol), _uints(1, 3));
        _collect(tokenA, 100e6);
        _collect(tokenB, 400e6);

        assertEq(split.releasable(address(tokenA), alice), 50e6);
        assertEq(split.releasable(address(tokenB), alice), 100e6);
        assertEq(split.releasable(address(tokenA), carol), 0);
        assertEq(split.releasable(address(tokenB), bob), 0);

        split.release(address(tokenA), alice);
        split.release(address(tokenA), bob);
        assertEq(split.usdcHeld(address(tokenA)), 0);
        assertEq(split.usdcHeld(address(tokenB)), 400e6);
        assertEq(split.releasable(address(tokenB), alice), 100e6);

        split.release(address(tokenB), carol);
        split.release(address(tokenB), alice);
        assertEq(usdc.balanceOf(alice), 150e6);
        assertEq(usdc.balanceOf(bob), 50e6);
        assertEq(usdc.balanceOf(carol), 300e6);
        assertEq(usdc.balanceOf(address(split)), 0);
    }

    // ─── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev Random payees and shares, fees in rounds interleaved with random releases: released never exceeds
    ///      received, each payee is paid exactly floor(received * share / totalShares), and the dust left over is
    ///      under one unit per payee.
    function testFuzz_releasedNeverExceedsReceived(uint256 seed, uint8 rawCount, uint64[4] memory fees) public {
        uint256 count = bound(rawCount, 1, 20);
        address[] memory payees = new address[](count);
        uint256[] memory shares = new uint256[](count);
        uint256 total;
        for (uint256 i; i < count; ++i) {
            payees[i] = address(uint160(0x10000 + i));
            shares[i] = bound(uint256(keccak256(abi.encode(seed, "share", i))), 1, type(uint128).max);
            total += shares[i];
        }
        MockLaunchToken token = _launchSplit(payees, shares);

        uint256 received;
        for (uint256 round; round < fees.length; ++round) {
            _collect(token, fees[round]);
            received += fees[round];
            for (uint256 i; i < count; ++i) {
                bool releaseNow = uint256(keccak256(abi.encode(seed, "release", round, i))) % 2 == 0;
                if (releaseNow && split.releasable(address(token), payees[i]) != 0) {
                    split.release(address(token), payees[i]);
                }
                assertLe(split.released(address(token), payees[i]), Math.mulDiv(received, shares[i], total));
            }
            assertEq(split.totalReceived(address(token)), received);
            assertLe(split.totalReleased(address(token)), received);
            assertEq(usdc.balanceOf(address(split)), received - split.totalReleased(address(token)));
        }

        uint256 paid;
        for (uint256 i; i < count; ++i) {
            if (split.releasable(address(token), payees[i]) != 0) split.release(address(token), payees[i]);
            assertEq(usdc.balanceOf(payees[i]), Math.mulDiv(received, shares[i], total));
            paid += usdc.balanceOf(payees[i]);
        }
        assertEq(paid, split.totalReleased(address(token)));
        assertLe(paid, received);
        assertLt(received - paid, count);
        assertEq(split.usdcHeld(address(token)), received - paid);
    }
}
