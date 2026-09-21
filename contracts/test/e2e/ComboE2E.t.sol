// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Theme 6: the Combo against the real launchpad (V13-SPEC §2, [D6]). Its sub-plugins are configured through
///         it inside createToken (each authenticates the Combo through pluginOf); every collection gives each entry
///         exactly its slice, floor(amount * bps / 10,000), the last entry taking the rounding remainder; the Combo
///         keeps nothing; every sub-plugin then works as if it were the token's own plugin.
/// @dev An attacker's own "custom address" plugin: it may call onLaunch on listed plugins, as a Combo does.
contract E2EConfigurer {
    function configure(address plugin, address token, bytes calldata data) external {
        IArchitexFeePlugin(plugin).onLaunch(token, msg.sender, data);
    }
}

contract ComboE2ETest is E2EBase {
    function _comboOf(address[] memory targets, uint16[] memory bps, bytes[] memory datas)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(targets, bps, datas);
    }

    /// @dev The documented rounding, written out: floor(amount * bps / 1e4) per entry, the last takes the rest.
    function _expectedSlices(uint256 amount, uint16[] memory bps) internal pure returns (uint256[] memory s) {
        s = new uint256[](bps.length);
        uint256 rest = amount;
        for (uint256 i; i + 1 < bps.length; ++i) {
            s[i] = amount * bps[i] / BPS;
            rest -= s[i];
        }
        s[bps.length - 1] = rest;
    }

    function test_combo_halfBuybackHalfHolders() public {
        bytes memory data = _comboOf(_addrs(address(buyback), address(holder)), _u16s(5000, 5000), _datas("", ""));
        address predicted = vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
        vm.expectEmit(true, true, false, false, address(combo));
        emit ILaunchFeePlugin.Configured(predicted, alice);
        vm.expectEmit(true, true, false, false, address(buyback));
        emit ILaunchFeePlugin.Configured(predicted, alice);
        vm.expectEmit(true, true, false, false, address(holder));
        emit ILaunchFeePlugin.Configured(predicted, alice);
        address token = _launchWith(alice, 1000, address(combo), data, 2_000e6);
        assertTrue(combo.isConfigured(token) && buyback.isConfigured(token) && holder.isConfigured(token));
        (address[] memory targets, uint16[] memory bps, bool[] memory isPlugin) = combo.allocationOf(token);
        assertEq(targets, _addrs(address(buyback), address(holder)));
        assertEq(bps.length, 2);
        assertTrue(isPlugin[0] && isPlugin[1]);

        // The sub-plugins were configured through the Combo; nobody configures them for this token again.
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.AlreadyConfigured.selector, token));
        holder.onLaunch(token, mallory, "");

        _curveBuy(bob, token, 7_777_777_777); // an odd amount of fees
        uint256 owed = pad.pendingCreatorFees(token);
        uint256[] memory expect = _expectedSlices(owed, bps);
        assertEq(combo.previewSplit(token, owed), expect, "previewSplit is the documented rounding");
        _collect(token); // checks each entry got exactly its slice
        assertEq(buyback.usdcHeld(token), expect[0]);
        assertEq(holder.totalDistributed(token), expect[1]);
        assertEq(ILaunchToken(token).totalDistributed(), expect[1], "the holder slice went into the token's stream");
        assertEq(usdc.balanceOf(address(holder)), 0);

        // Buyback: runs, burns; its trade's creator fee comes back through the Combo, split again.
        _run(token);
        uint256 back = pad.pendingCreatorFees(token);
        assertGt(back, 0);
        _collect(token);

        // Holders: past the stream's end everything delivered to the holder slice is claimable.
        _finishStream(token);
        _claim(token, bob);

        // Graduate, trade in the pool, and run the whole thing again.
        _graduateVia(carol, token);
        _collect(token);
        _poolBuy(dave, token, 3_000e6);
        _collect(token);
        _nextBlock();
        _run(token);
        _collect(token);
        _finishStream(token);
        _assertSystem();
    }

    function test_combo_splitAndHolders() public {
        bytes memory splitData = abi.encode(_addrs(carol, dave), _uints(2, 1));
        uint16[] memory bps = _u16s(7000, 3000);
        address token = _launchWith(
            alice, 750, address(combo), _comboOf(_addrs(address(split), address(holder)), bps, _datas(splitData, "")), 0
        );
        assertTrue(split.isConfigured(token) && holder.isConfigured(token));
        (address[] memory p, uint256[] memory s) = split.payeesOf(token);
        assertEq(p, _addrs(carol, dave));
        assertEq(s, _uints(2, 1));

        _curveBuy(bob, token, 3_333_333_333);
        _curveBuy(erin, token, 1_000_001);
        uint256 owed = pad.pendingCreatorFees(token);
        uint256[] memory expect = _expectedSlices(owed, bps);
        _collect(token);
        assertEq(split.totalReceived(token), expect[0]);
        assertEq(ILaunchToken(token).totalDistributed(), expect[1]);

        _releaseAll(token);
        assertEq(split.released(token, carol), expect[0] * 2 / 3);
        assertEq(split.released(token, dave), expect[0] / 3);
        _finishStream(token);
        _claim(token, bob);
        _graduateVia(frank, token);
        _collect(token);
        _releaseAll(token);
        _assertSystem();
    }

    /// @dev Plain entries (a wallet, a plain contract, a Safe-like wallet) are paid by transfer and never called.
    function test_combo_withPlainAndSafeLikeEntries() public {
        address[] memory targets = _addrs(address(split), address(plainWallet), address(safeWallet), creatorWallet);
        uint16[] memory bps = _u16s(2500, 2500, 2500, 2500);
        bytes memory data = _comboOf(targets, bps, _datas(abi.encode(_addrs(erin), _uints(1)), "", "", ""));
        address token = _launchWith(alice, 1000, address(combo), data, 0);
        (,, bool[] memory isPlugin) = combo.allocationOf(token);
        assertTrue(isPlugin[0]);
        assertFalse(isPlugin[1] || isPlugin[2] || isPlugin[3], "no hooks for plain entries");

        _curveBuy(bob, token, 10_000_000_003);
        _collect(token);
        _graduateVia(carol, token);
        _collect(token);
        assertEq(plainWallet.calls() + safeWallet.calls(), 0, "never called, only paid");
        assertEq(usdc.balanceOf(address(plainWallet)), ghostSlice[token][address(plainWallet)]);
        assertEq(usdc.balanceOf(address(safeWallet)), ghostSlice[token][address(safeWallet)]);
        assertEq(usdc.balanceOf(creatorWallet), ghostSlice[token][creatorWallet]);
        _assertSystem();
    }

    /// @dev "An entry that isn't a plugin must have empty data, which catches a mistyped plugin address [built]".
    function test_combo_dataForAPlainEntryRevertsTheLaunch() public {
        bytes memory data =
            _comboOf(_addrs(address(split), address(safeWallet)), _u16s(5000, 5000), _datas(_splitData(), hex"01"));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IComboPlugin.DataForNonPlugin.selector, address(safeWallet)));
        pad.createToken("Typo", "TYPO", "", 500, address(combo), data, 0, 0, LAUNCH_FEE);
    }

    /// @dev "A Combo inside a Combo can't configure listed plugins": the inner Combo is configured (the outer one is
    ///      the token's plugin), but the listed plugin refuses the inner one, and the whole launch reverts.
    function test_combo_nestedComboCannotConfigureListedPlugins() public {
        ComboPlugin inner = new ComboPlugin(address(pad));
        bytes memory innerData = _comboOf(_addrs(address(split)), _u16s(10_000), _datas(_splitData()));
        bytes memory data = _comboOf(_addrs(address(inner), bob), _u16s(5000, 5000), _datas(innerData, ""));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.Unauthorized.selector, address(inner)));
        pad.createToken("Nest", "NEST", "", 500, address(combo), data, 0, 0, LAUNCH_FEE);
    }

    /// @dev ...while a nested Combo of plain addresses works, and still pays exactly.
    function test_combo_nestedComboOfPlainAddressesPaysExactly() public {
        ComboPlugin inner = new ComboPlugin(address(pad));
        _trackUsdc(address(inner));
        isCombo[address(inner)] = true;
        bytes memory innerData = _comboOf(_addrs(erin, frank), _u16s(3333, 6667), _datas("", ""));
        bytes memory data = _comboOf(_addrs(address(inner), creatorWallet), _u16s(6000, 4000), _datas(innerData, ""));
        address token = _launchWith(alice, 500, address(combo), data, 0);
        _curveBuy(bob, token, 4_444_444_447);
        uint256 owed = pad.pendingCreatorFees(token);
        uint256 erinBefore = usdc.balanceOf(erin);
        uint256 frankBefore = usdc.balanceOf(frank);
        _collect(token);
        uint256 innerSlice = owed * 6000 / BPS;
        assertEq(usdc.balanceOf(creatorWallet), owed - innerSlice);
        assertEq(usdc.balanceOf(erin) - erinBefore, innerSlice * 3333 / BPS);
        assertEq(usdc.balanceOf(frank) - frankBefore, innerSlice - innerSlice * 3333 / BPS);
        assertEq(usdc.balanceOf(address(inner)), 0);
        _assertSystem();
    }

    // ─── onLaunch authentication against the real launchpad ───────────────────

    function _attackerData(uint256 i) internal view returns (bytes memory) {
        if (i == 0) return abi.encode(_addrs(mallory), _uints(1));
        if (i == 3) return abi.encode(_addrs(mallory), _u16s(10_000), _datas(""));
        return "";
    }

    /// @dev Launch-token addresses are predictable (CREATE from the launchpad). Before the launch nobody can configure
    ///      any listed plugin for the predicted address, directly or through a contract the attacker registered as the
    ///      plugin of a token of their own; the creator's launch there then works with the creator's configuration.
    ///      Afterwards nobody reconfigures it, and nobody configures a listed plugin for someone else's token.
    function test_auth_nobodyPreconfiguresOrHijacksAToken() public {
        address[4] memory plugins = [address(split), address(buyback), address(holder), address(combo)];
        E2EConfigurer evil = new E2EConfigurer();
        _launchWith(mallory, 0, address(evil), "", 0); // mallory's own token, with her contract as its plugin
        address predicted = vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));

        for (uint256 i; i < plugins.length; ++i) {
            vm.prank(mallory);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.UnknownToken.selector, predicted));
            ILaunchFeePlugin(plugins[i]).onLaunch(predicted, mallory, _attackerData(i));
            vm.prank(mallory);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.UnknownToken.selector, predicted));
            evil.configure(plugins[i], predicted, _attackerData(i));
        }

        address token = _launch(Kind.Combo, 500, 0);
        assertEq(token, predicted, "the prediction was right");
        (address[] memory p,) = split.payeesOf(token);
        assertEq(p, _addrs(carol, dave), "the creator's configuration, not the attacker's");

        address other = _launch(Kind.Eoa, 500, 0); // a token whose fees go to a wallet
        for (uint256 i; i < plugins.length; ++i) {
            vm.prank(mallory);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.AlreadyConfigured.selector, token));
            ILaunchFeePlugin(plugins[i]).onLaunch(token, mallory, _attackerData(i));
            vm.prank(mallory);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.Unauthorized.selector, address(evil)));
            evil.configure(plugins[i], other, _attackerData(i));
            vm.prank(address(pad)); // even the launchpad, for a token whose plugin is not this one
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotTokenPlugin.selector, other));
            ILaunchFeePlugin(plugins[i]).onLaunch(other, mallory, _attackerData(i));
        }
    }

    /// @dev Random allocations over all three listed plugins and a wallet, random trades on both sides of graduation:
    ///      every collection gives each entry exactly floor(amount*bps/1e4), the last the remainder, and the Combo
    ///      keeps nothing.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_combo_everyEntryGetsExactlyItsSlice(uint16[3] memory weights, uint64[3] memory buys, uint16 bpsRaw)
        public
    {
        uint16[] memory bps = new uint16[](4);
        uint256 left = BPS;
        for (uint256 i; i < 3; ++i) {
            bps[i] = uint16(bound(weights[i], 1, left - (3 - i))); // leave at least 1 bps for each later entry
            left -= bps[i];
        }
        bps[3] = uint16(left);
        address[] memory targets = _addrs(address(split), address(buyback), address(holder), creatorWallet);
        bytes memory data = _comboOf(targets, bps, _datas(_splitData(), "", "", ""));
        address token = _launchWith(alice, uint16(bound(bpsRaw, 1, 1000)), address(combo), data, 0);

        for (uint256 i; i < 3; ++i) {
            _buy(bob, token, bound(buys[i], 1e6, 15_000e6));
            uint256 owed = pad.pendingCreatorFees(token);
            assertEq(combo.previewSplit(token, owed), _expectedSlices(owed, bps));
            _collect(token);
        }
        if (!pad.isGraduated(token)) _graduateVia(carol, token);
        _collect(token);
        _nextBlock();
        (uint256 offer,) = buyback.previewRun(token);
        if (offer != 0) _run(token);
        _finishStream(token);
        _releaseAll(token);
        _assertSystem();
    }
}
