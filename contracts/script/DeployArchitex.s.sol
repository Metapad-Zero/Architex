// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../ArchitexFactory.sol";
import "../ArchitexRouter.sol";
import "../ArchitexLens.sol";

/// @notice Foundry broadcast script that deploys the Architex core contracts.
///
/// Usage (the script holds no key; never pass one on the command line, it lands in shell history):
///   export FEE_TO_SETTER=<your-address>
///   forge script contracts/script/DeployArchitex.s.sol:DeployArchitex --rpc-url <RPC_URL> \
///     --broadcast --ledger --sender <ledger-address>      # hardware wallet
///     --broadcast --interactive                            # or: prompts for the key, not echoed
///   Drop --broadcast for a free simulation.
///
/// Logs one JSON line: {"factory":"0x…","router":"0x…","lens":"0x…"}
contract DeployArchitex is Script {
    function run() external {
        address feeToSetter = vm.envAddress("FEE_TO_SETTER");

        vm.startBroadcast();

        ArchitexFactory factory = new ArchitexFactory(feeToSetter);
        ArchitexRouter router = new ArchitexRouter(address(factory));
        ArchitexLens lens = new ArchitexLens(address(factory), address(router));

        vm.stopBroadcast();

        string memory out = string.concat(
            '{"factory":"',
            vm.toString(address(factory)),
            '","router":"',
            vm.toString(address(router)),
            '","lens":"',
            vm.toString(address(lens)),
            '"}'
        );
        // solhint-disable-next-line no-console
        console.log(out);
    }
}
