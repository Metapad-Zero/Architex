// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 3: Split against the real launchpad (V13-SPEC §2.2, [D16]). The configuration is written inside
///         createToken; payees are paid pro-rata by pull; two tokens on the one Split deployment never mix.
contract SplitE2ETest is E2EBase {
    function _predictToken() internal view returns (address) {
        return vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
    }

    function test_split_configWrittenAtLaunch() public {
        address predicted = _predictToken();
        address[] memory payees = _addrs(carol, dave, erin);
        uint256[] memory shares = _uints(5, 3, 2);
        vm.expectEmit(true, true, false, false, address(split));
        emit ILaunchFeePlugin.Configured(predicted, alice);
        vm.expectEmit(true, false, false, true, address(split));
        emit ISplitPlugin.SplitConfigured(predicted, payees, shares);
        address token = _launch(Kind.Split, 500, 250e6);
        assertEq(token, predicted);

        assertTrue(split.isConfigured(token));
        (address[] memory p, uint256[] memory s) = split.payeesOf(token);
        assertEq(p, payees);
        assertEq(s, shares);
        assertEq(split.totalShares(token), 10);
        assertEq(split.sharesOf(token, dave), 3);
        assertEq(split.sharesOf(token, alice), 0, "the creator is not a payee unless named");

        // Write-once: nobody reconfigures it later, not even through the launchpad's own plugin slot.
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.AlreadyConfigured.selector, token));
        split.onLaunch(token, mallory, abi.encode(_addrs(mallory), _uints(1)));
        vm.prank(address(pad));
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.AlreadyConfigured.selector, token));
        split.onLaunch(token, mallory, abi.encode(_addrs(mallory), _uints(1)));
    }

    /// @dev Payees that would strand fees revert the whole launch (V13-SPEC §2.2 [built]).
    function test_split_invalidPayeesRevertTheLaunch() public {
        uint256 n = pad.tokensLength();
        address predicted = _predictToken();
        address[5] memory bad = [address(pad), address(usdc), address(split), predicted, address(0)];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad[i]));
            pad.createToken(
                "Bad", "BAD", "", 500, address(split), abi.encode(_addrs(carol, bad[i]), _uints(1, 1)), 0, 0, LAUNCH_FEE
            );
        }
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ISplitPlugin.DuplicatePayee.selector, carol));
        pad.createToken("Dup", "DUP", "", 500, address(split), abi.encode(_addrs(carol, carol), _uints(1, 1)), 0, 0, LAUNCH_FEE);
        assertEq(pad.tokensLength(), n, "nothing launched");
    }

    /// @dev Deliveries and releases interleaved across graduation: every payee is always owed exactly
    ///      floor(totalReceived * share / totalShares) in total, anyone can trigger a release, the payee is paid.
    function test_split_payeesPaidProRataByPull_acrossGraduation() public {
        address token = _launch(Kind.Split, 750, 1_000e6);
        _curveBuy(bob, token, 3_000e6);
        _collect(token);

        // carol releases now; dave and erin wait
        vm.prank(mallory);
        uint256 carolFirst = split.release(token, carol);
        assertEq(carolFirst, split.totalReceived(token) * 5 / 10);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(ISplitPlugin.NothingToRelease.selector, token, carol));
        split.release(token, carol);
        vm.expectRevert(abi.encodeWithSelector(ISplitPlugin.NothingToRelease.selector, token, bob));
        split.release(token, bob);

        _curveSell(bob, token, IERC20(token).balanceOf(bob) / 2);
        _graduateVia(frank, token);
        _collect(token);
        _poolBuy(bob, token, 4_321e6);
        _poolSell(frank, token, IERC20(token).balanceOf(frank) / 3);
        _collect(token);

        uint256 received = split.totalReceived(token);
        assertEq(split.releasable(token, carol), received * 5 / 10 - carolFirst, "owed minus paid");
        assertEq(split.releasable(token, dave), received * 3 / 10);
        assertEq(split.releasable(token, erin), received * 2 / 10);
        _releaseAll(token);
        assertEq(usdc.balanceOf(carol) - (FUNDS), received * 5 / 10, "carol: 5/10 of everything");
        assertEq(usdc.balanceOf(dave) - FUNDS, received * 3 / 10);
        assertEq(usdc.balanceOf(erin) - FUNDS, received * 2 / 10);
        assertLe(received - split.totalReleased(token), 2, "rounding dust stays, at most a unit per payee");
        _assertSystem();
    }

    /// @dev Two tokens on the one Split: different payees (one shared), different creator fees, trading in the same
    ///      blocks. Each token's fees go only to that token's payees, by that token's shares.
    function test_split_twoTokensSamePluginNeverMix() public {
        address a = _launchWith(alice, 300, address(split), abi.encode(_addrs(alice, bob), _uints(1, 1)), 0);
        address b = _launchWith(alice, 900, address(split), abi.encode(_addrs(alice, dave), _uints(1, 3)), 0);
        _curveBuy(carol, a, 4_000e6);
        _curveBuy(carol, b, 6_000e6);
        _collect(a);
        _collect(b);
        _curveBuy(erin, b, 1_111e6);
        _collect(b);

        uint256 ra = split.totalReceived(a);
        uint256 rb = split.totalReceived(b);
        assertEq(ra, ghostDelivered[a]);
        assertEq(rb, ghostDelivered[b]);
        assertEq(split.releasable(a, alice), ra / 2);
        assertEq(split.releasable(b, alice), rb / 4, "alice's share differs per token");
        assertEq(split.releasable(a, dave), 0, "dave is not a payee of a");
        assertEq(split.releasable(b, bob), 0, "bob is not a payee of b");
        vm.expectRevert(abi.encodeWithSelector(ISplitPlugin.NothingToRelease.selector, a, dave));
        split.release(a, dave);

        uint256 aliceBefore = usdc.balanceOf(alice);
        split.release(a, alice);
        assertEq(usdc.balanceOf(alice) - aliceBefore, ra / 2);
        assertEq(split.releasable(b, alice), rb / 4, "releasing a leaves b untouched");
        split.release(b, alice);
        assertEq(usdc.balanceOf(alice) - aliceBefore, ra / 2 + rb / 4);
        assertEq(split.usdcHeld(a), ra - ra / 2);
        assertEq(split.usdcHeld(b), rb - rb / 4);
        assertEq(usdc.balanceOf(address(split)), split.usdcHeld(a) + split.usdcHeld(b));

        _graduateVia(frank, a);
        _collect(a);
        _releaseAll(a);
        _releaseAll(b);
        assertEq(split.totalReleased(b) + split.usdcHeld(b), split.totalReceived(b));
        _assertSystem();
    }

    /// @dev The maximum, 20 payees, configured inside createToken and all paid.
    function test_split_twentyPayees() public {
        address[] memory payees = new address[](20);
        uint256[] memory shares = new uint256[](20);
        for (uint256 i; i < 20; ++i) {
            payees[i] = makeAddr(string.concat("payee", vm.toString(i)));
            shares[i] = i + 1; // total 210
            _trackUsdc(payees[i]);
        }
        address token = _launchWith(alice, 1000, address(split), abi.encode(payees, shares), 0);
        _curveBuy(bob, token, 12_345e6);
        _collect(token);
        uint256 received = split.totalReceived(token);
        _releaseAll(token);
        for (uint256 i; i < 20; ++i) {
            assertEq(usdc.balanceOf(payees[i]), received * (i + 1) / 210, "pro-rata");
        }
        assertLe(received - split.totalReleased(token), 20);
        _assertSystem();
    }

    /// @dev Random shares, trades and release timing: no payee is ever paid beyond their share, the plugin never pays
    ///      out more than it received, and its USDC is exactly what it still owes (plus dust).
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_split_payoutsNeverExceedShares(uint32[3] memory sharesRaw, uint64[3] memory buys, uint8 releaseMask)
        public
    {
        uint256[] memory shares = _uints(bound(sharesRaw[0], 1, 1e9), bound(sharesRaw[1], 1, 1e9), bound(sharesRaw[2], 1, 1e9));
        uint256 total = shares[0] + shares[1] + shares[2];
        address[] memory payees = _addrs(carol, dave, erin);
        address token = _launchWith(alice, 1000, address(split), abi.encode(payees, shares), 0);
        for (uint256 i; i < 3; ++i) {
            _buy(bob, token, bound(buys[i], 3, 12_000e6));
            _collect(token);
            for (uint256 j; j < 3; ++j) {
                if ((releaseMask >> (i * 3 + j)) & 1 == 1 && split.releasable(token, payees[j]) != 0) {
                    split.release(token, payees[j]);
                }
            }
        }
        uint256 received = split.totalReceived(token);
        for (uint256 j; j < 3; ++j) {
            assertLe(split.released(token, payees[j]), received * shares[j] / total, "never beyond the share");
            assertEq(split.released(token, payees[j]) + split.releasable(token, payees[j]), received * shares[j] / total);
        }
        assertLe(split.totalReleased(token), received);
        _assertSystem();
    }
}
