// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../launchpad/ArchitexLaunchpad.sol";
import "../launchpad/LaunchPairFactory.sol";
import "../launchpad/LaunchRouter.sol";

/// @notice Foundry broadcast script that deploys the Architex launchpad v1.3 suite in one broadcast, in the order
///         V13-SPEC §5 fixes: ArchitexLaunchpad, LaunchPairFactory(launchpad), LaunchRouter(launchpad, factory, usdc),
///         then launchpad.initialize(factory, router) from the same sender (initialize is deployer-only).
///
/// Usage (the script holds no key; never pass one on the command line, it lands in shell history):
///   export FEE_TO=<address-that-receives-platform-fees>
///   export FEE_TO_SETTER=<admin-address>     # can change feeTo and the launch fee; keep it, do not renounce
///   export LAUNCH_FEE=1000000                # USDC base units (6 decimals): 1000000 = 1 USDC, max 100 USDC
///   forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url <RPC_URL> \
///     --broadcast --ledger --sender <ledger-address>      # hardware wallet
///     --broadcast --interactive                            # or: prompts for the key, not echoed
///   Drop --broadcast for a free simulation.
///
///   USDC defaults to Arc's USDC ERC-20 (same address on testnet and mainnet). USDC=<address> overrides it for a
///   testnet rehearsal on a mintable test USDC; the override is refused on Arc mainnet (chain 5042), where only
///   Arc's USDC is accepted.
///
/// Logs one JSON line: {"launchpad":"0x…","pairFactory":"0x…","router":"0x…","usdc":"0x…"}
contract DeployLaunchpad is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 constant ARC_MAINNET_CHAIN_ID = 5042;

    function run() external {
        address usdc = vm.envOr("USDC", ARC_USDC);
        address feeTo = vm.envAddress("FEE_TO");
        address feeToSetter = vm.envAddress("FEE_TO_SETTER");
        uint256 launchFee = vm.envUint("LAUNCH_FEE");

        // Wrong-network and wrong-address mistakes fail here, before any gas is spent.
        require(block.chainid != ARC_MAINNET_CHAIN_ID || usdc == ARC_USDC, "USDC override refused on Arc mainnet");
        require(usdc.code.length > 0, "USDC has no code on this chain");
        require(IERC20Metadata(usdc).decimals() == 6, "USDC must have 6 decimals");

        vm.startBroadcast();
        ArchitexLaunchpad launchpad = new ArchitexLaunchpad(usdc, feeTo, feeToSetter, launchFee);
        LaunchPairFactory pairFactory = new LaunchPairFactory(address(launchpad));
        LaunchRouter router = new LaunchRouter(address(launchpad), address(pairFactory), usdc);
        launchpad.initialize(address(pairFactory), address(router));
        vm.stopBroadcast();

        require(
            launchpad.usdc() == usdc && launchpad.pairFactory() == address(pairFactory)
                && launchpad.router() == address(router) && pairFactory.launchpad() == address(launchpad)
                && pairFactory.usdc() == usdc && router.launchpad() == address(launchpad)
                && router.factory() == address(pairFactory) && router.usdc() == usdc,
            "deployed with wrong wiring"
        );
        require(
            launchpad.feeTo() == feeTo && launchpad.feeToSetter() == feeToSetter && launchpad.launchFee() == launchFee,
            "deployed with wrong admin settings"
        );

        // solhint-disable-next-line no-console
        console.log(
            string.concat(
                '{"launchpad":"',
                vm.toString(address(launchpad)),
                '","pairFactory":"',
                vm.toString(address(pairFactory)),
                '","router":"',
                vm.toString(address(router)),
                '","usdc":"',
                vm.toString(usdc),
                '"}'
            )
        );
    }
}
