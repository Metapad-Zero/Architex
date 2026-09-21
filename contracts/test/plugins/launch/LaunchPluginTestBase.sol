// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IArchitexFeePlugin} from "../../../interfaces/IArchitexFeePlugin.sol";
import {ILaunchFeePlugin} from "../../../interfaces/plugins/ILaunchFeePlugin.sol";
import {TestToken} from "../../../TestToken.sol";
import {MockLaunchpad, MockLaunchRouter, MockLaunchToken, MockLaunchPair, ConfiguringContract} from "./LaunchPluginMocks.sol";

/// @notice Shared setup: USDC (the repo's TestToken, 6 decimals), the mock launchpad and launch router, actors and
///         helpers to launch tokens and deliver fees the two ways V13-SPEC allows (launchpad collection, direct).
abstract contract LaunchPluginTestBase is Test {
    TestToken internal usdc;
    MockLaunchpad internal launchpad;
    MockLaunchRouter internal router;

    address internal creator = makeAddr("creator");
    address internal attacker = makeAddr("attacker");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        usdc = new TestToken("USD Coin", "USDC", 6, 0, address(this));
        launchpad = new MockLaunchpad(address(usdc));
        router = new MockLaunchRouter(launchpad);
        launchpad.setRouter(address(router));
    }

    // ─── Launching and paying ─────────────────────────────────────────────────

    function _newToken() internal returns (MockLaunchToken token) {
        token = new MockLaunchToken(address(usdc), address(launchpad));
    }

    /// @dev Launches a token with `plugin` the way createToken does: the pair exists and the curve (plugin
    ///      included) is registered before onLaunch is called.
    function _launch(address plugin, bytes memory data) internal returns (MockLaunchToken token) {
        token = _newToken();
        MockLaunchPair pair = new MockLaunchPair();
        token.setPair(address(pair));
        launchpad.launch(address(token), creator, plugin, address(pair), data);
    }

    function _pairOf(MockLaunchToken token) internal view returns (MockLaunchPair) {
        return MockLaunchPair(launchpad.pairOf(address(token)));
    }

    /// @dev The launchpad collecting `amount` of `token`'s creator fees to its plugin (V13-SPEC §2.1 flow, with the
    ///      launchpad's own exact-pull and zero-allowance checks).
    function _collect(MockLaunchToken token, uint256 amount) internal {
        usdc.mint(address(launchpad), amount);
        launchpad.collect(address(token), amount);
    }

    /// @dev Anyone delivering fees straight to a plugin's onFees with their own USDC.
    function _payDirect(address plugin, address token, address payer, uint256 amount) internal {
        usdc.mint(payer, amount);
        vm.startPrank(payer);
        usdc.approve(plugin, amount);
        IArchitexFeePlugin(plugin).onFees(token, amount);
        vm.stopPrank();
    }

    // ─── Array helpers ────────────────────────────────────────────────────────

    function _addrs(address a) internal pure returns (address[] memory r) {
        r = new address[](1);
        r[0] = a;
    }

    function _addrs(address a, address b) internal pure returns (address[] memory r) {
        r = new address[](2);
        (r[0], r[1]) = (a, b);
    }

    function _addrs(address a, address b, address c) internal pure returns (address[] memory r) {
        r = new address[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _addrs(address a, address b, address c, address d) internal pure returns (address[] memory r) {
        r = new address[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }

    function _uints(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _uints(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    function _uints(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _u16s(uint16 a) internal pure returns (uint16[] memory r) {
        r = new uint16[](1);
        r[0] = a;
    }

    function _u16s(uint16 a, uint16 b) internal pure returns (uint16[] memory r) {
        r = new uint16[](2);
        (r[0], r[1]) = (a, b);
    }

    function _u16s(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[] memory r) {
        r = new uint16[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _u16s(uint16 a, uint16 b, uint16 c, uint16 d) internal pure returns (uint16[] memory r) {
        r = new uint16[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }

    function _datas(bytes memory a) internal pure returns (bytes[] memory r) {
        r = new bytes[](1);
        r[0] = a;
    }

    function _datas(bytes memory a, bytes memory b) internal pure returns (bytes[] memory r) {
        r = new bytes[](2);
        (r[0], r[1]) = (a, b);
    }

    function _datas(bytes memory a, bytes memory b, bytes memory c) internal pure returns (bytes[] memory r) {
        r = new bytes[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _datas(bytes memory a, bytes memory b, bytes memory c, bytes memory d)
        internal
        pure
        returns (bytes[] memory r)
    {
        r = new bytes[](4);
        (r[0], r[1], r[2], r[3]) = (a, b, c, d);
    }
}

/// @notice The V13-SPEC §2.1 rules every reference plugin follows, run against each plugin by its test file.
abstract contract PluginConformanceTest is LaunchPluginTestBase {
    ILaunchFeePlugin internal plugin;

    function _deployPlugin(address launchpad_) internal virtual returns (ILaunchFeePlugin);

    /// @dev A configuration this plugin accepts.
    function _validData() internal view virtual returns (bytes memory);

    function setUp() public virtual override {
        super.setUp();
        plugin = _deployPlugin(address(launchpad));
    }

    // ─── Construction ─────────────────────────────────────────────────────────

    function test_conformance_constructorReadsUsdcFromLaunchpad() public view {
        assertEq(plugin.launchpad(), address(launchpad));
        assertEq(plugin.usdc(), address(usdc));
    }

    function test_conformance_constructorRejectsZeroLaunchpad() public {
        vm.expectRevert(ILaunchFeePlugin.ZeroAddress.selector);
        _deployPlugin(address(0));
    }

    function test_conformance_constructorRejectsLaunchpadWithoutUsdc() public {
        MockLaunchpad noUsdc = new MockLaunchpad(address(0));
        vm.expectRevert(ILaunchFeePlugin.ZeroAddress.selector);
        _deployPlugin(address(noUsdc));
    }

    // ─── ERC-165 ──────────────────────────────────────────────────────────────

    function test_conformance_supportsInterface() public view {
        assertTrue(plugin.supportsInterface(type(IArchitexFeePlugin).interfaceId), "IArchitexFeePlugin");
        assertTrue(plugin.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertFalse(plugin.supportsInterface(0xffffffff), "0xffffffff");
        assertFalse(plugin.supportsInterface(0x00000000), "0x00000000");
        assertFalse(plugin.supportsInterface(type(ILaunchFeePlugin).interfaceId), "unadvertised");
        // What the launchpad (and a Combo) use to decide whether to call the hooks.
        assertTrue(ERC165Checker.supportsInterface(address(plugin), type(IArchitexFeePlugin).interfaceId));
    }

    function test_conformance_hookInterfaceIdIsTheTwoHooks() public pure {
        assertEq(
            type(IArchitexFeePlugin).interfaceId,
            IArchitexFeePlugin.onLaunch.selector ^ IArchitexFeePlugin.onFees.selector
        );
    }

    // ─── onLaunch: authentication and write-once ──────────────────────────────

    function test_conformance_launchConfiguresToken() public {
        MockLaunchToken token = _launch(address(plugin), _validData());
        assertTrue(plugin.isConfigured(address(token)));
    }

    function test_conformance_launchEmitsConfigured() public {
        MockLaunchToken token = _newToken();
        vm.expectEmit(true, true, false, false, address(plugin));
        emit ILaunchFeePlugin.Configured(address(token), creator);
        launchpad.launch(address(token), creator, address(plugin), address(0), _validData());
    }

    /// @dev Launch-token addresses are predictable. An attacker who configures the plugin for the next token before
    ///      it exists must be rejected, and the creator's launch at that address must still work.
    function test_conformance_attackerCannotPreconfigurePredictedToken() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.UnknownToken.selector, predicted));
        plugin.onLaunch(predicted, attacker, _validData());

        MockLaunchToken token = _launch(address(plugin), _validData());
        assertEq(address(token), predicted, "prediction was right");
        assertTrue(plugin.isConfigured(address(token)));
    }

    /// @dev Nor through a contract the attacker registered as the plugin of a token of their own.
    function test_conformance_registeredPluginCannotPreconfigurePredictedToken() public {
        ConfiguringContract evil = new ConfiguringContract();
        _launch(address(evil), "");
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));

        // Pranked: an un-pranked call from this test contract would bump its nonce and move the next token.
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.UnknownToken.selector, predicted));
        evil.configure(address(plugin), predicted, attacker, _validData());

        MockLaunchToken token = _launch(address(plugin), _validData());
        assertEq(address(token), predicted, "prediction was right");
        assertTrue(plugin.isConfigured(address(token)));
    }

    function test_conformance_attackerCannotConfigureTokenThatUsesAnotherPlugin() public {
        MockLaunchToken token = _launch(alice, ""); // "Creator wallet": fees go to alice, no hooks
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.Unauthorized.selector, attacker));
        plugin.onLaunch(address(token), attacker, _validData());
        assertFalse(plugin.isConfigured(address(token)));
    }

    function test_conformance_registeredPluginOfAnotherTokenCannotConfigure() public {
        ConfiguringContract evil = new ConfiguringContract();
        _launch(address(evil), ""); // the attacker's own token
        MockLaunchToken victim = _launch(alice, "");
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.Unauthorized.selector, address(evil)));
        evil.configure(address(plugin), address(victim), attacker, _validData());
    }

    function test_conformance_launchpadCannotConfigureTokenWhosePluginIsAnother() public {
        MockLaunchToken token = _launch(alice, "");
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotTokenPlugin.selector, address(token)));
        launchpad.callOnLaunch(address(plugin), address(token), creator, _validData());
    }

    function test_conformance_launchpadCannotConfigureUnknownToken() public {
        address unknown = makeAddr("unknown token");
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.UnknownToken.selector, unknown));
        launchpad.callOnLaunch(address(plugin), unknown, creator, _validData());
    }

    function test_conformance_configurationIsWriteOnce() public {
        MockLaunchToken token = _launch(address(plugin), _validData());

        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.AlreadyConfigured.selector, address(token)));
        launchpad.callOnLaunch(address(plugin), address(token), creator, _validData());

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.AlreadyConfigured.selector, address(token)));
        plugin.onLaunch(address(token), attacker, _validData());
    }

    /// @dev The Combo case: a token's registered plugin may configure other plugins for that token, once.
    function test_conformance_tokensRegisteredPluginCanConfigureOnce() public {
        ConfiguringContract registered = new ConfiguringContract();
        MockLaunchToken token = _launch(address(registered), "");
        registered.configure(address(plugin), address(token), creator, _validData());
        assertTrue(plugin.isConfigured(address(token)));

        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.AlreadyConfigured.selector, address(token)));
        registered.configure(address(plugin), address(token), creator, _validData());
    }

    // ─── onFees ───────────────────────────────────────────────────────────────

    function test_conformance_onFeesRejectsTokenNotConfiguredForThisPlugin() public {
        MockLaunchToken token = _launch(alice, "");
        usdc.mint(keeper, 1e6);
        vm.startPrank(keeper);
        usdc.approve(address(plugin), 1e6);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotConfigured.selector, address(token)));
        plugin.onFees(address(token), 1e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(keeper), 1e6);
    }

    function test_conformance_onFeesRejectsNeverLaunchedToken() public {
        address unknown = makeAddr("unknown token");
        usdc.mint(keeper, 1e6);
        vm.startPrank(keeper);
        usdc.approve(address(plugin), 1e6);
        vm.expectRevert(abi.encodeWithSelector(ILaunchFeePlugin.NotConfigured.selector, unknown));
        plugin.onFees(unknown, 1e6);
        vm.stopPrank();
    }

    /// @dev The launchpad's collection (V13-SPEC §2.1) checks exactly `amount` left and the allowance is zero.
    function test_conformance_collectionPullsExactlyTheAmount() public {
        MockLaunchToken token = _launch(address(plugin), _validData());
        _collect(token, 1_234_567);
        assertEq(usdc.balanceOf(address(launchpad)), 0);
        assertEq(usdc.allowance(address(launchpad), address(plugin)), 0);
        assertEq(usdc.balanceOf(address(plugin)), plugin.usdcHeld(address(token)));
    }

    /// @dev Any caller may deliver fees; the plugin takes exactly `amount` even from an unlimited approval.
    function test_conformance_anyCallerCanDeliverFeesAndIsPulledExactly() public {
        MockLaunchToken token = _launch(address(plugin), _validData());
        usdc.mint(keeper, 5e6);
        vm.startPrank(keeper);
        usdc.approve(address(plugin), type(uint256).max);
        vm.expectEmit(true, true, false, true, address(plugin));
        emit ILaunchFeePlugin.FeesReceived(address(token), keeper, 3e6);
        plugin.onFees(address(token), 3e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(keeper), 2e6);
    }

    function test_conformance_onFeesWithoutApprovalReverts() public {
        MockLaunchToken token = _launch(address(plugin), _validData());
        usdc.mint(keeper, 1e6);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(plugin), 0, 1e6)
        );
        plugin.onFees(address(token), 1e6);
        assertEq(plugin.usdcHeld(address(token)), 0);
    }

    function test_conformance_onFeesZeroIsANoop() public {
        MockLaunchToken token = _launch(address(plugin), _validData());
        vm.recordLogs();
        vm.prank(keeper);
        plugin.onFees(address(token), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
        assertEq(plugin.usdcHeld(address(token)), 0);
    }

    /// @dev Two tokens' fees are accounted apart, and the plugin's USDC is exactly what it holds for its tokens.
    function testFuzz_conformance_balanceEqualsSumOfHeld(uint64 a, uint64 b, uint64 c) public {
        MockLaunchToken tokenA = _launch(address(plugin), _validData());
        MockLaunchToken tokenB = _launch(address(plugin), _validData());
        _collect(tokenA, a);
        _payDirect(address(plugin), address(tokenB), keeper, b);
        _collect(tokenA, c);
        assertEq(
            usdc.balanceOf(address(plugin)), plugin.usdcHeld(address(tokenA)) + plugin.usdcHeld(address(tokenB))
        );
    }
}
