// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../interfaces/IArchitexFactory.sol";
import "../launchpad/ArchitexLaunchpad.sol";

/// @notice Foundry broadcast script that deploys the Architex launchpad next to an existing factory.
///
/// Usage (the script holds no key; never pass one on the command line, it lands in shell history):
///   export FACTORY=<architex-factory>        # src/deployments/<network>.json
///   export FEE_TO=<address-that-receives-fees>
///   export FEE_TO_SETTER=<admin-address>     # can change feeTo and the launch fee; keep it, do not renounce
///   export LAUNCH_FEE=1000000                # USDC base units (6 decimals): 1000000 = 1 USDC, max 100 USDC
///   forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url <RPC_URL> \
///     --broadcast --ledger --sender <ledger-address>      # hardware wallet
///     --broadcast --interactive                            # or: prompts for the key, not echoed
///   Drop --broadcast for a free simulation.
///
///   USDC defaults to Arc's USDC ERC-20 (same address on testnet and mainnet); override with USDC=.
///
/// Logs one JSON line: {"launchpad":"0x…"}
contract DeployLaunchpad is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        address usdc = vm.envOr("USDC", ARC_USDC);
        address factory = vm.envAddress("FACTORY");
        address feeTo = vm.envAddress("FEE_TO");
        address feeToSetter = vm.envAddress("FEE_TO_SETTER");
        uint256 launchFee = vm.envUint("LAUNCH_FEE");

        // Wrong-network and wrong-address mistakes fail here, before any gas is spent.
        require(usdc.code.length > 0, "USDC has no code on this chain");
        require(IERC20Metadata(usdc).decimals() == 6, "USDC must have 6 decimals");
        require(factory.code.length > 0, "FACTORY has no code on this chain");
        IArchitexFactory(factory).allPairsLength();

        vm.startBroadcast();
        ArchitexLaunchpad launchpad = new ArchitexLaunchpad(usdc, factory, feeTo, feeToSetter, launchFee);
        vm.stopBroadcast();

        require(launchpad.factory() == factory && launchpad.usdc() == usdc, "deployed with wrong wiring");

        // solhint-disable-next-line no-console
        console.log(string.concat('{"launchpad":"', vm.toString(address(launchpad)), '"}'));
    }
}
