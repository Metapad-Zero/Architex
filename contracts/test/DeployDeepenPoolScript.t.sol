// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../script/DeployDeepenPool.s.sol";
import "./launchpad/LaunchpadV13Base.sol";

/// @notice Runs the Deepen pool deploy script in-process: it refuses a launchpad that is not there or not initialized,
///         and what it deploys is wired to that launchpad, declares the plugin interface, has the documented pacing
///         constants, and works end to end for a token launched with it.
contract DeployDeepenPoolScriptTest is LaunchpadV13Base {
    /// @dev forge's default broadcaster when a script runs without --sender.
    address constant DEFAULT_SENDER_FOR_SCRIPTS = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev One test on purpose: the script reads process environment variables, which parallel tests would share.
    function test_deployScript() public {
        DeployDeepenPool script = new DeployDeepenPool();

        // 1. A launchpad with no code on this chain.
        vm.setEnv("LAUNCHPAD", vm.toString(makeAddr("nothing")));
        vm.expectRevert(bytes("LAUNCHPAD has no code on this chain"));
        script.run();

        // 2. A launchpad that was never initialized (no pair factory, no router).
        ArchitexLaunchpad bare = new ArchitexLaunchpad(address(usdc), feeTo, setter, 0);
        vm.setEnv("LAUNCHPAD", vm.toString(address(bare)));
        vm.expectRevert(bytes("launchpad is not initialized"));
        script.run();

        // 3. The live suite: one broadcast, then the wiring checks the script makes itself.
        vm.setEnv("LAUNCHPAD", vm.toString(address(pad)));
        address predicted =
            vm.computeCreateAddress(DEFAULT_SENDER_FOR_SCRIPTS, vm.getNonce(DEFAULT_SENDER_FOR_SCRIPTS));
        script.run();
        DeepenPoolPlugin deepen = DeepenPoolPlugin(predicted);
        assertGt(predicted.code.length, 0, "deployed");
        assertEq(deepen.launchpad(), address(pad));
        assertEq(deepen.usdc(), address(usdc));
        assertTrue(deepen.supportsInterface(type(IArchitexFeePlugin).interfaceId));
        assertEq(deepen.CAP_BPS(), 25);
        assertEq(deepen.RUN_INTERVAL(), 1 hours);
        assertEq(deepen.MIN_RUN_USDC(), 3);
        assertEq(deepen.LP_RECIPIENT(), DEAD);

        // 4. It serves a token launched with it: configured at launch, fees collected, a run buys and burns.
        address token = _create(500, address(deepen));
        assertTrue(deepen.isConfigured(token));
        vm.prank(bob);
        pad.buy(token, 5_000e6, 0, bob, type(uint256).max);
        uint256 owed = pad.pendingCreatorFees(token);
        assertGt(owed, 0);
        pad.collectCreatorFees(token);
        assertEq(deepen.usdcHeld(token), owed);
        uint256 supply = IERC20(token).totalSupply();
        (uint256 spent, uint256 burned, uint256 liquidity) = deepen.run(token);
        assertGt(spent, 0);
        assertEq(IERC20(token).totalSupply(), supply - burned);
        assertEq(liquidity, 0, "still on the curve");
        _assertSolvent();
    }
}
