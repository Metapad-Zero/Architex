// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";

/// @notice Fee destinations (V13-SPEC §2.1, §2.2 [review]). The first e2e run showed Split accepting the token's own
///         (predictable) launch pair as a payee, where anyone could skim the fees, and the launch router, where they
///         would be stuck. Now every path refuses every address that could never pass fees on, whether it is the
///         token's plugin, a Split payee or a Combo entry (or a payee of a Combo's Split): the token's own launch pair,
///         another token's live or graduated pair, the launch router, the pair factory, another launch token and the
///         new token itself. The launch reverts and nothing is recorded.
contract DestinationsE2ETest is E2EBase {
    address internal liveToken;
    address internal gradToken;

    function setUp() public override {
        super.setUp();
        liveToken = _launch(Kind.Eoa, 100, 1_000e6);
        gradToken = _launch(Kind.Eoa, 100, 0);
        _graduateVia(bob, gradToken);
    }

    function _predictToken() internal view returns (address) {
        return vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
    }

    function _predictPair() internal view returns (address) {
        return vm.computeCreateAddress(address(pairFactory), vm.getNonce(address(pairFactory)));
    }

    /// @dev Every refused destination, computed fresh for the next launch, with what each one is.
    function _refused() internal view returns (address[8] memory bad, string[8] memory names) {
        bad = [
            _predictPair(),
            pad.pairOf(liveToken),
            pad.pairOf(gradToken),
            address(router),
            address(pairFactory),
            liveToken,
            gradToken,
            _predictToken()
        ];
        names = [
            "its own launch pair",
            "a live token's pair",
            "a graduated token's pair",
            "the launch router",
            "the pair factory",
            "a live launch token",
            "a graduated launch token",
            "the new token itself"
        ];
    }

    function _assertNothingLaunched(uint256 n, address wouldBePair) internal view {
        assertEq(pad.tokensLength(), n, "nothing launched");
        assertFalse(pad.isLaunchPair(wouldBePair), "nothing recorded");
    }

    function test_destinations_createTokenRefusesThemAsThePlugin() public {
        (address[8] memory bad,) = _refused();
        uint256 n = pad.tokensLength();
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(IArchitexLaunchpad.InvalidPlugin.selector);
            pad.createToken("Bad", "BAD", "", 500, bad[i], "", 1_000e6, 0, LAUNCH_FEE);
            _assertNothingLaunched(n, bad[0]);
        }
        assertTrue(pad.isLaunchPair(pad.pairOf(liveToken)) && pad.isLaunchPair(pad.pairOf(gradToken)));
        assertFalse(pad.isLaunchPair(liveToken) || pad.isLaunchPair(address(router)));
        // USDC, zero and the launchpad too.
        address[3] memory more = [address(usdc), address(0), address(pad)];
        for (uint256 i; i < more.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(IArchitexLaunchpad.InvalidPlugin.selector);
            pad.createToken("Bad", "BAD", "", 500, more[i], "", 0, 0, LAUNCH_FEE);
        }
    }

    function test_destinations_splitRefusesThemAsPayees() public {
        (address[8] memory bad,) = _refused();
        uint256 n = pad.tokensLength();
        for (uint256 i; i < bad.length; ++i) {
            bytes memory data = abi.encode(_addrs(carol, bad[i]), _uints(1, 1));
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad[i]));
            pad.createToken("Bad", "BAD", "", 500, address(split), data, 1_000e6, 0, LAUNCH_FEE);
            _assertNothingLaunched(n, bad[0]);
        }
    }

    function test_destinations_comboRefusesThemAsEntries() public {
        (address[8] memory bad,) = _refused();
        uint256 n = pad.tokensLength();
        for (uint256 i; i < bad.length; ++i) {
            bytes memory data = abi.encode(_addrs(creatorWallet, bad[i]), _u16s(5000, 5000), _datas("", ""));
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad[i]));
            pad.createToken("Bad", "BAD", "", 500, address(combo), data, 1_000e6, 0, LAUNCH_FEE);
            _assertNothingLaunched(n, bad[0]);
        }
    }

    function test_destinations_aCombosSplitRefusesThemAsPayees() public {
        (address[8] memory bad,) = _refused();
        uint256 n = pad.tokensLength();
        for (uint256 i; i < bad.length; ++i) {
            bytes memory splitData = abi.encode(_addrs(carol, bad[i]), _uints(1, 1));
            bytes memory data =
                abi.encode(_addrs(address(split), creatorWallet), _u16s(5000, 5000), _datas(splitData, ""));
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad[i]));
            pad.createToken("Bad", "BAD", "", 500, address(combo), data, 0, 0, LAUNCH_FEE);
            _assertNothingLaunched(n, bad[0]);
        }
    }

    /// @dev pluginData for an address that does not declare the hooks (a wallet, a plain contract, a Safe-like
    ///      wallet, the dead address) reverts DataForNonPlugin: nothing would ever read it, so the address is likely a
    ///      mistyped plugin. With empty data they launch.
    function test_destinations_dataForANonPluginReverts() public {
        address[4] memory plain = [creatorWallet, address(plainWallet), address(safeWallet), DEAD];
        for (uint256 i; i < plain.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(IArchitexLaunchpad.DataForNonPlugin.selector);
            pad.createToken("Typo", "TYPO", "", 500, plain[i], _splitData(), 0, 0, LAUNCH_FEE);
            _launchWith(alice, 500, plain[i], "", 0);
        }
    }

    /// @dev The dead address stays allowed: burning the creator fees is a choice. Collections send them there.
    function test_destinations_deadAddressBurnsTheFees() public {
        address token = _launchWith(alice, 1000, DEAD, "", 1_000e6);
        _trackUsdc(DEAD);
        _curveBuy(bob, token, 2_000e6);
        uint256 owed = pad.pendingCreatorFees(token);
        uint256 before = usdc.balanceOf(DEAD);
        _collect(token);
        assertEq(usdc.balanceOf(DEAD) - before, owed);
        _assertSystem();
    }

    /// @dev What the refusals protect: the launch pairs hold exactly their reserves throughout a full life with every
    ///      listed plugin (no plain transfer ever lands in a pair to be skimmed).
    function test_destinations_pairsOnlyEverHoldTheirReserves() public {
        address[] memory t = new address[](4);
        t[0] = _launch(Kind.Split, 1000, 1_000e6);
        t[1] = _launch(Kind.Buyback, 1000, 1_000e6);
        t[2] = _launch(Kind.Holder, 1000, 1_000e6);
        t[3] = _launch(Kind.Combo, 1000, 1_000e6);
        for (uint256 i; i < t.length; ++i) {
            _graduateVia(carol, t[i]);
            _collect(t[i]);
            _poolBuy(dave, t[i], 3_000e6);
            _collect(t[i]);
            LaunchPair pair = _pairOf(t[i]);
            uint256 before = usdc.balanceOf(mallory);
            vm.prank(mallory);
            pair.skim(mallory);
            assertEq(usdc.balanceOf(mallory), before, "nothing to skim");
        }
        _warp(RUN_INTERVAL);
        _run(t[1]);
        _releaseAll(t[0]);
        _assertSystem(); // includes: every pair's USDC == its reserve
    }
}
