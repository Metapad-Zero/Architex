// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {SplitPlugin} from "../../../plugins/launch/SplitPlugin.sol";
import {ComboPlugin} from "../../../plugins/launch/ComboPlugin.sol";
import {MockLaunchToken, MockLaunchPair} from "./LaunchPluginMocks.sol";
import {LaunchPluginTestBase} from "./LaunchPluginTestBase.sol";

/// @notice Any call reaching it reverts: a payee the recipient check must never call.
contract Untouchable {
    fallback() external payable {
        revert("called");
    }
}

/// @notice LaunchFeePluginBase._checkRecipient, through Split payees and Combo targets: besides zero, the plugin, the
///         launchpad, USDC and the token, it refuses every launch pair (anyone can skim a plain transfer out of
///         one), the launch router, the pair factory, and any launch token (V13-SPEC §2.1, §2.2).
contract FeeRecipientChecksTest is LaunchPluginTestBase {
    SplitPlugin internal split;
    ComboPlugin internal combo;
    address internal pairFactory = makeAddr("pair factory");

    function setUp() public override {
        super.setUp();
        launchpad.setPairFactory(pairFactory);
        split = new SplitPlugin(address(launchpad));
        combo = new ComboPlugin(address(launchpad));
    }

    function _splitData(address payee) internal view returns (bytes memory) {
        return abi.encode(_addrs(alice, payee), _uints(1, 1));
    }

    function _comboData(address target) internal view returns (bytes memory) {
        return abi.encode(_addrs(alice, target), _u16s(5000, 5000), _datas("", ""));
    }

    /// @dev Launches `token` with its pair registered first (createToken's order) and expects InvalidRecipient(bad).
    function _expectRefused(MockLaunchToken token, MockLaunchPair pair, address plugin, bytes memory data, address bad)
        internal
    {
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.InvalidRecipient.selector, bad));
        launchpad.launch(address(token), creator, plugin, address(pair), data);
        assertFalse(ILaunchFeePlugin(plugin).isConfigured(address(token)));
    }

    function _fresh() internal returns (MockLaunchToken token, MockLaunchPair pair) {
        token = _newToken();
        pair = new MockLaunchPair();
        token.setPair(address(pair));
    }

    // ─── Split ────────────────────────────────────────────────────────────────

    function test_split_refusesTheTokensLaunchPair() public {
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(split), _splitData(address(pair)), address(pair));
    }

    /// @dev Any launch pair, not just the token's own: a live token's and a graduated token's.
    function test_split_refusesAnotherTokensLaunchPair() public {
        address livePair = launchpad.pairOf(address(_launch(carol, "")));
        MockLaunchToken graduated = _launch(carol, "");
        launchpad.setGraduated(address(graduated), true);
        address graduatedPair = launchpad.pairOf(address(graduated));
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(split), _splitData(livePair), livePair);
        _expectRefused(token, pair, address(split), _splitData(graduatedPair), graduatedPair);
    }

    function test_split_refusesTheLaunchRouter() public {
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(split), _splitData(address(router)), address(router));
    }

    function test_split_refusesThePairFactory() public {
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(split), _splitData(pairFactory), pairFactory);
    }

    function test_split_refusesAnyLaunchToken() public {
        MockLaunchToken live = _launch(carol, "");
        MockLaunchToken graduated = _launch(carol, "");
        launchpad.setGraduated(address(graduated), true);
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(split), _splitData(address(live)), address(live));
        _expectRefused(token, pair, address(split), _splitData(address(graduated)), address(graduated));
    }

    /// @dev The check reads the launchpad only: a payee that reverts on any call is still accepted.
    function test_split_neverCallsThePayee() public {
        Untouchable payee = new Untouchable();
        MockLaunchToken token = _launch(address(split), _splitData(address(payee)));
        assertEq(split.sharesOf(address(token), address(payee)), 1);
    }

    // ─── Combo ────────────────────────────────────────────────────────────────

    function test_combo_refusesTheTokensLaunchPair() public {
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(combo), _comboData(address(pair)), address(pair));
    }

    function test_combo_refusesAnotherTokensLaunchPair() public {
        address livePair = launchpad.pairOf(address(_launch(carol, "")));
        MockLaunchToken graduated = _launch(carol, "");
        launchpad.setGraduated(address(graduated), true);
        address graduatedPair = launchpad.pairOf(address(graduated));
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(combo), _comboData(livePair), livePair);
        _expectRefused(token, pair, address(combo), _comboData(graduatedPair), graduatedPair);
    }

    function test_combo_refusesTheLaunchRouter() public {
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(combo), _comboData(address(router)), address(router));
    }

    function test_combo_refusesThePairFactory() public {
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(combo), _comboData(pairFactory), pairFactory);
    }

    function test_combo_refusesAnyLaunchToken() public {
        MockLaunchToken live = _launch(carol, "");
        MockLaunchToken graduated = _launch(carol, "");
        launchpad.setGraduated(address(graduated), true);
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        _expectRefused(token, pair, address(combo), _comboData(address(live)), address(live));
        _expectRefused(token, pair, address(combo), _comboData(address(graduated)), address(graduated));
    }

    /// @dev A Combo's Split entry applies the same check to its own payees.
    function test_combo_splitEntryRefusesThePairToo() public {
        (MockLaunchToken token, MockLaunchPair pair) = _fresh();
        bytes memory data =
            abi.encode(_addrs(address(split), alice), _u16s(5000, 5000), _datas(_splitData(address(pair)), ""));
        _expectRefused(token, pair, address(combo), data, address(pair));
    }

    /// @dev Everything else still launches: ordinary wallets, other plugins, and a contract that is not a registered
    ///      launch pair even though it is one in all but name (the registry, not the code, decides).
    function test_ordinaryDestinationsStillLaunch() public {
        MockLaunchPair unregistered = new MockLaunchPair();
        MockLaunchToken token = _launch(
            address(combo),
            abi.encode(
                _addrs(address(split), bob, address(unregistered)),
                _u16s(5000, 3000, 2000),
                _datas(_splitData(dave), "", "")
            )
        );
        assertTrue(combo.isConfigured(address(token)));
        assertTrue(split.isConfigured(address(token)));
    }
}
