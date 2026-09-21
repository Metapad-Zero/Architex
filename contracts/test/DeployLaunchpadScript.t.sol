// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../script/DeployLaunchpad.s.sol";
import "./launchpad/LaunchpadV13Base.sol";

/// @notice Runs the v1.3 deploy script in-process: one broadcast deploys and wires the suite, USDC defaults to
///         Arc's address, and a USDC override is refused on Arc mainnet (chain 5042).
contract DeployLaunchpadScriptTest is Test {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    /// @dev forge's default broadcaster when a script runs without --sender
    address constant DEFAULT_SENDER_FOR_SCRIPTS = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev One test on purpose: the script reads process environment variables, which parallel tests would share.
    function test_deployScript() public {
        // A 6-decimal token at Arc's USDC address (a local chain has nothing there)
        BlockableUSDC stand = new BlockableUSDC();
        vm.etch(ARC_USDC, address(stand).code);

        address feeTo = makeAddr("feeTo");
        address setter = makeAddr("setter");
        vm.setEnv("FEE_TO", vm.toString(feeTo));
        vm.setEnv("FEE_TO_SETTER", vm.toString(setter));
        vm.setEnv("LAUNCH_FEE", "1000000");

        // 1. Default USDC, on Arc mainnet's chain id: deploys and wires everything in one broadcast
        vm.chainId(5042);
        DeployLaunchpad script = new DeployLaunchpad();
        vm.recordLogs();
        script.run();
        (ArchitexLaunchpad pad, LaunchPairFactory factory, LaunchRouter router) = _deployed();
        assertEq(pad.usdc(), ARC_USDC);
        assertEq(pad.pairFactory(), address(factory));
        assertEq(pad.router(), address(router));
        assertEq(factory.launchpad(), address(pad));
        assertEq(router.factory(), address(factory));
        assertEq(pad.feeTo(), feeTo);
        assertEq(pad.feeToSetter(), setter);
        assertEq(pad.launchFee(), 1e6);
        // initialize ran exactly once, from the broadcaster: nobody (not even the broadcaster) can run it again
        vm.expectRevert(IArchitexLaunchpad.AlreadyInitialized.selector);
        vm.prank(DEFAULT_SENDER_FOR_SCRIPTS);
        pad.initialize(address(factory), address(router));

        // 2. A USDC override is refused on Arc mainnet
        BlockableUSDC testUsdc = new BlockableUSDC();
        vm.setEnv("USDC", vm.toString(address(testUsdc)));
        vm.expectRevert(bytes("USDC override refused on Arc mainnet"));
        script.run();

        // 3. ...and accepted on Arc testnet (the mintable-USDC rehearsal)
        vm.chainId(5042002);
        vm.recordLogs();
        script.run();
        (ArchitexLaunchpad pad2,,) = _deployed();
        assertEq(pad2.usdc(), address(testUsdc));

        // 4. A token that is not 6-decimal USDC is refused before anything is deployed
        vm.setEnv("USDC", vm.toString(address(new LaunchToken("Not", "USDC", address(testUsdc), address(1)))));
        vm.expectRevert(bytes("USDC must have 6 decimals"));
        script.run();
        vm.setEnv("USDC", vm.toString(makeAddr("empty")));
        vm.expectRevert(bytes("USDC has no code on this chain"));
        script.run();
    }

    /// @dev Finds the suite the last script run deployed, from the launchpad's Initialized event.
    function _deployed() internal view returns (ArchitexLaunchpad pad, LaunchPairFactory factory, LaunchRouter router) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("Initialized(address,address)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 3 && logs[i].topics[0] == topic) {
                pad = ArchitexLaunchpad(payable(logs[i].emitter));
                factory = LaunchPairFactory(address(uint160(uint256(logs[i].topics[1]))));
                router = LaunchRouter(address(uint160(uint256(logs[i].topics[2]))));
            }
        }
        require(address(pad) != address(0), "no Initialized event");
    }
}
