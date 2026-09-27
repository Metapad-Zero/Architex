// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "../interfaces/IArchitexFeePlugin.sol";
import "../interfaces/IArchitexLaunchpad.sol";
import "../interfaces/plugins/ILaunchFeePlugin.sol";
import "../interfaces/plugins/IDeepenPoolPlugin.sol";
import "../plugins/launch/DeepenPoolPlugin.sol";

/// @notice Foundry broadcast script that deploys the Deepen pool creator-fee plugin (V13-SPEC §2.3) for one launchpad
///         v1.3. Like the other reference plugins it is a singleton: one deployment serves every token that picks it,
///         with configuration and USDC kept per token. It has no owner and no admin setting, so nothing needs handing
///         over after the deploy, and it changes nothing about the launchpad already deployed.
///
/// Run it after the launchpad suite is live, from any funded account (the deployer gets no role):
///   export LAUNCHPAD=<launchpad address>
///   forge script contracts/script/DeployDeepenPool.s.sol:DeployDeepenPool --rpc-url <RPC_URL> \
///     --broadcast --ledger --sender <ledger-address>      # hardware wallet
///     --broadcast --interactive                            # or: prompts for the key, not echoed
///   Drop --broadcast for a free simulation.
///
/// Logs one JSON line: {"deepenPool":"0x…"}
contract DeployDeepenPool is Script {
    function run() external {
        address launchpad = vm.envAddress("LAUNCHPAD");

        // A wrong address or an uninitialized launchpad fails here, before any gas is spent. A run reads the launch
        // router and the token's launch pair from the launchpad, so the launchpad must already be wired.
        require(launchpad.code.length > 0, "LAUNCHPAD has no code on this chain");
        IArchitexLaunchpad pad = IArchitexLaunchpad(launchpad);
        address usdc = pad.usdc();
        require(usdc != address(0), "launchpad reports no USDC");
        require(pad.router() != address(0) && pad.pairFactory() != address(0), "launchpad is not initialized");

        vm.startBroadcast();
        address deepenPool = address(new DeepenPoolPlugin(launchpad));
        vm.stopBroadcast();

        // The launchpad calls a plugin's hooks only if it declares IArchitexFeePlugin at launch, so a plugin that
        // failed this would silently receive plain transfers instead.
        require(ILaunchFeePlugin(deepenPool).launchpad() == launchpad, "plugin wired to the wrong launchpad");
        require(ILaunchFeePlugin(deepenPool).usdc() == usdc, "plugin wired to the wrong USDC");
        require(
            IERC165(deepenPool).supportsInterface(type(IArchitexFeePlugin).interfaceId),
            "plugin does not declare IArchitexFeePlugin"
        );
        // The pacing constants a creator and the site rely on (V13-SPEC §2.2, §2.3).
        IDeepenPoolPlugin plugin = IDeepenPoolPlugin(deepenPool);
        require(plugin.CAP_BPS() == 25 && plugin.RUN_INTERVAL() == 1 hours, "unexpected pacing");
        require(plugin.MIN_RUN_USDC() == 3, "unexpected minimum run");
        require(plugin.LP_RECIPIENT() == 0x000000000000000000000000000000000000dEaD, "LP must go to the burn address");

        // solhint-disable-next-line no-console
        console.log(string.concat('{"deepenPool":"', vm.toString(deepenPool), '"}'));
    }
}
