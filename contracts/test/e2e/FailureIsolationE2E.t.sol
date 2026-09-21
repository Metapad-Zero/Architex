// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 7: failure isolation (V13-SPEC §2 [D10], §6.3, §9). A plugin that reverts or under-pulls strands only
///         its own token's creator fees (that token's collection reverts, the fees stay accrued); trading on that token
///         (curve, graduation, pool) and every other token, collections included, keeps working.
contract FailureIsolationE2ETest is E2EBase {
    address[] internal good;

    function _launchGoodTokens() internal {
        good.push(_launch(Kind.Split, 500, 500e6));
        good.push(_launch(Kind.Buyback, 500, 500e6));
        good.push(_launch(Kind.Holder, 500, 500e6));
        good.push(_launch(Kind.Combo, 500, 500e6));
        good.push(_launch(Kind.Eoa, 500, 500e6));
    }

    /// @dev Every good token trades, collects and works its plugin, whatever the broken one is doing.
    function _exerciseGoodTokens() internal {
        for (uint256 i; i < good.length; ++i) {
            _buy(bob, good[i], 1_500e6);
            _collect(good[i]);
        }
        _nextBlock();
        _run(good[1]);
        _warp(PERIOD);
        _drip(good[2]);
        _releaseAll(good[0]);
    }

    function _assertStranded(address token, bytes memory err) internal {
        uint256 owed = pad.pendingCreatorFees(token);
        assertGt(owed, 0);
        uint256 padBefore = usdc.balanceOf(address(pad));
        vm.prank(keeper);
        vm.expectRevert(err);
        pad.collectCreatorFees(token);
        assertEq(pad.pendingCreatorFees(token), owed, "the fees stay accrued [D10]");
        assertEq(usdc.balanceOf(address(pad)), padBefore, "nothing left the launchpad");
        assertEq(usdc.allowance(address(pad), pad.pluginOf(token)), 0);
    }

    /// @dev The broken token's own life goes on: curve buys and sells, graduation, pool buys and sells.
    function _tradeThroughEverything(address token) internal {
        _curveBuy(carol, token, 2_000e6);
        _curveSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        _graduateVia(dave, token);
        _poolBuy(erin, token, 1_000e6);
        _poolSell(dave, token, IERC20(token).balanceOf(dave) / 3);
    }

    function _isolationScenario(MisbehavingPlugin.Mode mode, bytes memory err) internal {
        MisbehavingPlugin broken = new MisbehavingPlugin(IERC20(address(usdc)));
        _trackUsdc(address(broken));
        address bad = _launchWith(alice, 1000, address(broken), "", 1_000e6);
        assertTrue(pad.curves(bad).pluginHooks);
        _launchGoodTokens();
        broken.setMode(mode);

        _curveBuy(bob, bad, 3_000e6);
        _assertStranded(bad, err);
        _exerciseGoodTokens();
        _tradeThroughEverything(bad);
        _assertStranded(bad, err);
        _exerciseGoodTokens();
        _collectFees(); // platform fees of every token, the broken one included
        _assertSystem();

        // Stranded, not lost: were the plugin to behave, exactly the accrued fees would go through.
        broken.setMode(MisbehavingPlugin.Mode.Exact);
        uint256 owed = pad.pendingCreatorFees(bad);
        assertEq(_collect(bad), owed);
        _assertSystem();
    }

    function test_isolation_revertingPlugin() public {
        _isolationScenario(MisbehavingPlugin.Mode.Revert, bytes("plugin broken"));
    }

    function test_isolation_underPullingPlugin() public {
        _isolationScenario(
            MisbehavingPlugin.Mode.PullLess, abi.encodeWithSelector(IArchitexLaunchpad.PluginPullMismatch.selector)
        );
    }

    function test_isolation_pluginRefundingPartOfItsPull() public {
        _isolationScenario(
            MisbehavingPlugin.Mode.PullThenRefundOne,
            abi.encodeWithSelector(IArchitexLaunchpad.PluginPullMismatch.selector)
        );
    }

    /// @dev A Combo entry that breaks strands only its token; another token on the same Combo and Split keeps working.
    function test_isolation_comboWithABrokenEntryStrandsOnlyThatToken() public {
        MisbehavingPlugin broken = new MisbehavingPlugin(IERC20(address(usdc)));
        _trackUsdc(address(broken));
        address x = _launchWith(
            alice,
            800,
            address(combo),
            abi.encode(_addrs(address(split), address(broken)), _u16s(5000, 5000), _datas(_splitData(), "")),
            1_000e6
        );
        address y = _launchWith(
            alice,
            800,
            address(combo),
            abi.encode(_addrs(address(split), address(holder)), _u16s(5000, 5000), _datas(_splitData(), "")),
            1_000e6
        );
        broken.setMode(MisbehavingPlugin.Mode.Revert);
        _curveBuy(bob, x, 2_000e6);
        _curveBuy(bob, y, 2_000e6);
        _assertStranded(x, bytes("plugin broken"));
        _collect(y);
        _releaseAll(y);
        _tradeThroughEverything(x);
        _assertStranded(x, bytes("plugin broken"));
        _collect(y);
        _assertSystem();
    }

    /// @dev If USDC blocklists one token's contract (its dividend pool), the Holder plugin cannot distribute for that
    ///      token: its drips revert, and so does any collection that has an old due to release first. Its fees wait at
    ///      the launchpad and in the plugin; another token on the same Holder plugin is unaffected; trading goes on.
    function test_isolation_blocklistedTokenStrandsOnlyItsOwnStream() public {
        address a = _launch(Kind.Holder, 1000, 2_000e6);
        address b = _launch(Kind.Holder, 1000, 2_000e6);
        _collect(a);
        _collect(b);
        usdc.setBlocked(a, true);

        _warp(12 hours);
        assertGt(holder.releasable(a), 0);
        vm.prank(keeper);
        vm.expectRevert(bytes("blocklisted"));
        holder.drip(a);
        _curveBuy(bob, a, 3_000e6); // trading the blocked token still works
        _assertStranded(a, bytes("blocklisted")); // its collection must release the old due first, and cannot

        _drip(b);
        _curveBuy(bob, b, 3_000e6);
        _collect(b);
        assertEq(usdc.balanceOf(address(holder)), holder.unreleased(a) + holder.unreleased(b));

        usdc.setBlocked(a, false);
        _drip(a);
        _collect(a);
        _assertSystem();
    }

    /// @dev V13-SPEC §9: a blocklisted Split payee only blocks their own release.
    function test_isolation_blocklistedSplitPayeeOnlyBlocksTheirOwnRelease() public {
        address token = _launch(Kind.Split, 1000, 1_000e6);
        _curveBuy(bob, token, 4_000e6);
        usdc.setBlocked(dave, true);
        _collect(token); // collecting never pays payees, so it works
        vm.expectRevert(bytes("blocklisted"));
        split.release(token, dave);
        split.release(token, carol);
        split.release(token, erin);
        _curveBuy(bob, token, 1_000e6);
        _collect(token);
        usdc.setBlocked(dave, false);
        _releaseAll(token);
        _assertSystem();
    }

    /// @dev V13-SPEC §9: a blocklisted plain Combo entry blocks that token's collections; another token on the same
    ///      Combo is unaffected.
    function test_isolation_blocklistedPlainComboEntryStrandsOnlyThatToken() public {
        address x = _launch(Kind.Combo, 600, 1_000e6); // its plain entry is the creator wallet
        address y = _launchWith(
            alice,
            600,
            address(combo),
            abi.encode(_addrs(address(split), erin), _u16s(5000, 5000), _datas(_splitData(), "")),
            1_000e6
        );
        usdc.setBlocked(creatorWallet, true);
        _assertStranded(x, bytes("blocklisted"));
        _collect(y);
        _tradeThroughEverything(x);
        _assertStranded(x, bytes("blocklisted"));
        usdc.setBlocked(creatorWallet, false);
        _collect(x);
        _assertSystem();
    }
}
