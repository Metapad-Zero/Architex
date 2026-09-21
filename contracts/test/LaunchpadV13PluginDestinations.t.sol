// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./launchpad/LaunchpadV13Base.sol";
import {ILaunchFeePlugin} from "../interfaces/plugins/ILaunchFeePlugin.sol";
import {SplitPlugin} from "../plugins/launch/SplitPlugin.sol";
import {ComboPlugin} from "../plugins/launch/ComboPlugin.sol";

/// @notice createToken refuses fee destinations that could never pass fees on, and pluginData that no plugin would
///         read (V13-SPEC §2.1). A new token's address and its launch pair's are predictable (the launchpad's and the
///         pair factory's next CREATE), so they are predicted here the way a confused builder or an attacker would.
contract LaunchpadPluginDestinationTest is LaunchpadV13Base {
    function _predictToken() internal view returns (address) {
        return vm.computeCreateAddress(address(pad), vm.getNonce(address(pad)));
    }

    function _predictPair() internal view returns (address) {
        return vm.computeCreateAddress(address(pairFactory), vm.getNonce(address(pairFactory)));
    }

    /// @dev A launch paying `plugin` reverts InvalidPlugin and leaves nothing behind.
    function _expectInvalid(address plugin) internal {
        uint256 tokens = pad.tokensLength();
        uint256 pairs = pairFactory.allPairsLength();
        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.InvalidPlugin.selector);
        pad.createToken("Bad", "BAD", "", 100, plugin, "", 10e6, 0, type(uint256).max);
        assertEq(pad.tokensLength(), tokens);
        assertEq(pairFactory.allPairsLength(), pairs);
    }

    // ─── InvalidPlugin ────────────────────────────────────────────────────────

    function test_rejectsUsdc() public {
        _expectInvalid(address(usdc));
    }

    function test_rejectsTheLaunchRouter() public {
        _expectInvalid(address(router));
    }

    function test_rejectsThePairFactory() public {
        _expectInvalid(address(pairFactory));
    }

    function test_stillRejectsZeroAndTheLaunchpad() public {
        _expectInvalid(address(0));
        _expectInvalid(address(pad));
    }

    /// @dev The new token itself: the fees would sit in the token's contract, uncredited.
    function test_rejectsTheNewTokenItself() public {
        address predicted = _predictToken();
        _expectInvalid(predicted);
        assertEq(_create(100, creatorWallet), predicted, "the prediction was right");
    }

    /// @dev Its own launch pair: a plain transfer there is anyone's to skim, before or after graduation.
    function test_rejectsItsOwnLaunchPair() public {
        address predicted = _predictPair();
        _expectInvalid(predicted);
        address token = _create(100, creatorWallet);
        assertEq(pad.pairOf(token), predicted, "the prediction was right");
    }

    /// @dev Any other token's launch pair too, live or graduated: the registry knows every pair ever created.
    function test_rejectsAnotherTokensLaunchPair() public {
        address live = _create(500, creatorWallet);
        address graduated = _create(500, creatorWallet);
        _graduate(graduated);
        _expectInvalid(pad.pairOf(live));
        _expectInvalid(pad.pairOf(graduated));
    }

    /// @dev isLaunchPair: true for every pair the factory made (all made inside createToken), false for anything else.
    function test_isLaunchPair_recordsEveryPairAndNothingElse() public {
        address a = _create(100, creatorWallet);
        address b = _create(0, alice);
        _graduate(b);
        assertEq(pairFactory.allPairsLength(), 2);
        for (uint256 i; i < 2; ++i) {
            assertTrue(pad.isLaunchPair(pairFactory.allPairs(i)), "every factory pair");
        }
        assertTrue(pad.isLaunchPair(pad.pairOf(a)), "live");
        assertTrue(pad.isLaunchPair(pad.pairOf(b)), "graduated");
        address[7] memory others = [a, b, address(pad), address(pairFactory), address(router), address(usdc), DEAD];
        for (uint256 i; i < others.length; ++i) {
            assertFalse(pad.isLaunchPair(others[i]));
        }
        assertFalse(pad.isLaunchPair(_predictPair()), "not before its token exists");
        assertEq(IArchitexLaunchpadLite(address(pad)).pairFactory(), address(pairFactory));
    }

    /// @dev A failed launch records nothing: the pair it would have created is not a launch pair.
    function test_isLaunchPair_revertedLaunchRecordsNothing() public {
        address predicted = _predictPair();
        _expectInvalid(address(usdc));
        assertFalse(pad.isLaunchPair(predicted));
    }

    function test_rejectsAnyOtherLaunchToken() public {
        address live = _create(100, creatorWallet);
        address graduated = _create(0, alice);
        _graduate(graduated);
        _expectInvalid(live);
        _expectInvalid(graduated);
    }

    /// @dev The dead address stays allowed: burning the creator fees is a choice.
    function test_deadAddressIsAllowed() public {
        address token = _create(500, DEAD);
        vm.prank(carol);
        pad.buy(token, 1_000e6, 0, carol, type(uint256).max);
        uint256 owed = pad.pendingCreatorFees(token);
        uint256 before = usdc.balanceOf(DEAD);
        assertEq(pad.collectCreatorFees(token), owed);
        assertEq(usdc.balanceOf(DEAD) - before, owed);
        _assertSolvent();
    }

    // ─── DataForNonPlugin ─────────────────────────────────────────────────────

    /// @dev A mistyped Split address: the creator's 50/50 configuration would be dropped and every fee would go to the
    ///      typo. The launch reverts instead; the right address launches, configured.
    function test_pluginDataForANonPluginReverts_mistypedSplit() public {
        SplitPlugin split = new SplitPlugin(address(pad));
        bytes memory config = abi.encode(_two(alice, bob), _twoShares(1, 1));
        address typo = address(uint160(address(split)) ^ 1);

        vm.prank(alice);
        vm.expectRevert(IArchitexLaunchpad.DataForNonPlugin.selector);
        pad.createToken("Typo", "TYPO", "", 300, typo, config, 0, 0, type(uint256).max);

        vm.prank(alice);
        address token = pad.createToken("Right", "RIGHT", "", 300, address(split), config, 0, 0, type(uint256).max);
        assertTrue(split.isConfigured(token));
    }

    /// @dev Contracts without the interface, and the dead address, take empty data only.
    function test_pluginDataForANonPluginReverts_contractsAndDead() public {
        address[3] memory plain = [address(new HooklessRecorder()), address(new GasGuzzlerPlugin()), DEAD];
        for (uint256 i; i < plain.length; ++i) {
            vm.prank(alice);
            vm.expectRevert(IArchitexLaunchpad.DataForNonPlugin.selector);
            pad.createToken("Data", "DATA", "", 100, plain[i], hex"00", 0, 0, type(uint256).max);
            vm.prank(alice);
            pad.createToken("Data", "DATA", "", 100, plain[i], "", 0, 0, type(uint256).max);
        }
    }

    // ─── The plugins' own check, on the real launchpad ────────────────────────

    /// @dev A Split payee or Combo target that is the token's own (predictable) launch pair, another token's launch
    ///      pair, the launch router, the pair factory or another launch token is refused, so the launch reverts.
    function test_splitAndComboRefuseLaunchPairsTheRouterThePairFactoryAndLaunchTokens() public {
        SplitPlugin split = new SplitPlugin(address(pad));
        ComboPlugin combo = new ComboPlugin(address(pad));
        address other = _create(100, creatorWallet);
        // Failed launches create nothing, so the prediction holds for every attempt below.
        address[5] memory bad = [_predictPair(), pad.pairOf(other), address(router), address(pairFactory), other];

        for (uint256 i; i < bad.length; ++i) {
            bytes memory splitData = abi.encode(_two(alice, bad[i]), _twoShares(1, 1));
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad[i]));
            pad.createToken("S", "S", "", 100, address(split), splitData, 0, 0, type(uint256).max);

            uint16[] memory bps = new uint16[](2);
            (bps[0], bps[1]) = (5000, 5000);
            bytes memory comboData = abi.encode(_two(alice, bad[i]), bps, new bytes[](2));
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad[i]));
            pad.createToken("C", "C", "", 100, address(combo), comboData, 0, 0, type(uint256).max);
        }
        assertEq(pad.tokensLength(), 1);
    }

    function _two(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        (r[0], r[1]) = (a, b);
    }

    function _twoShares(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }
}
