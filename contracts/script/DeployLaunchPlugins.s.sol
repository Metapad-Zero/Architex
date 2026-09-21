// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "../interfaces/IArchitexFeePlugin.sol";
import "../interfaces/IArchitexLaunchpad.sol";
import "../interfaces/plugins/ILaunchFeePlugin.sol";
import "../plugins/launch/SplitPlugin.sol";
import "../plugins/launch/BuybackBurnPlugin.sol";
import "../plugins/launch/HolderDistributionPlugin.sol";
import "../plugins/launch/ComboPlugin.sol";

/// @notice Foundry broadcast script that deploys the four reference creator-fee plugins (V13-SPEC §2.2) for one
///         launchpad v1.3: Split, Buyback & burn, Distribute to holders and Combo. Each is a singleton: one deployment
///         serves every token that picks it, with configuration and USDC kept per token. None has an owner or any
///         admin setting, so nothing needs handing over after the deploy.
///
/// Run it after DeployLaunchpad.s.sol, from any funded account (the deployer gets no role):
///   export LAUNCHPAD=<launchpad address from DeployLaunchpad>
///   forge script contracts/script/DeployLaunchPlugins.s.sol:DeployLaunchPlugins --rpc-url <RPC_URL> \
///     --broadcast --ledger --sender <ledger-address>      # hardware wallet
///     --broadcast --interactive                            # or: prompts for the key, not echoed
///   Drop --broadcast for a free simulation.
///
/// Logs one JSON line: {"split":"0x…","buybackBurn":"0x…","holders":"0x…","combo":"0x…"}
contract DeployLaunchPlugins is Script {
    function run() external {
        address launchpad = vm.envAddress("LAUNCHPAD");

        // A wrong address or an uninitialized launchpad fails here, before any gas is spent. Buyback & burn reads the
        // launch router from the launchpad when it runs, so the launchpad must already be wired.
        require(launchpad.code.length > 0, "LAUNCHPAD has no code on this chain");
        IArchitexLaunchpad pad = IArchitexLaunchpad(launchpad);
        address usdc = pad.usdc();
        require(usdc != address(0), "launchpad reports no USDC");
        require(pad.router() != address(0) && pad.pairFactory() != address(0), "launchpad is not initialized");

        vm.startBroadcast();
        address split = address(new SplitPlugin(launchpad));
        address buybackBurn = address(new BuybackBurnPlugin(launchpad));
        address holders = address(new HolderDistributionPlugin(launchpad));
        address combo = address(new ComboPlugin(launchpad));
        vm.stopBroadcast();

        _check(split, launchpad, usdc);
        _check(buybackBurn, launchpad, usdc);
        _check(holders, launchpad, usdc);
        _check(combo, launchpad, usdc);

        // solhint-disable-next-line no-console
        console.log(
            string.concat(
                '{"split":"',
                vm.toString(split),
                '","buybackBurn":"',
                vm.toString(buybackBurn),
                '","holders":"',
                vm.toString(holders),
                '","combo":"',
                vm.toString(combo),
                '"}'
            )
        );
    }

    /// @dev The launchpad calls a plugin's hooks only if it declares IArchitexFeePlugin at launch, so a plugin that
    ///      failed this would silently receive plain transfers instead.
    function _check(address plugin, address launchpad, address usdc) private view {
        require(ILaunchFeePlugin(plugin).launchpad() == launchpad, "plugin wired to the wrong launchpad");
        require(ILaunchFeePlugin(plugin).usdc() == usdc, "plugin wired to the wrong USDC");
        require(IERC165(plugin).supportsInterface(type(IArchitexFeePlugin).interfaceId), "plugin does not declare IArchitexFeePlugin");
    }
}
