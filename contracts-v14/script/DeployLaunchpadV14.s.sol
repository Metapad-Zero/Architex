// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ArchitexLaunchpadV14} from "../src/ArchitexLaunchpadV14.sol";
import {ArchitexLaunchHook} from "../src/ArchitexLaunchHook.sol";
import {ArchitexV4Router} from "../src/ArchitexV4Router.sol";
import {SplitPlugin} from "../../contracts/plugins/launch/SplitPlugin.sol";
import {HolderDistributionPlugin} from "../../contracts/plugins/launch/HolderDistributionPlugin.sol";
import {ComboPlugin} from "../../contracts/plugins/launch/ComboPlugin.sol";

/// @notice Deploys launchpad v1.4 (V14-SPEC §11): the launchpad, the Uniswap v4 hook at a mined address, the router,
///         the wiring, and the three plugins v1.3 lists that run unchanged (Split, Distribute to holders, Combo). The
///         deployer gets no role; `feeTo` and `feeToSetter` hold the only admin power (the platform fee's destination
///         and the launch fee), as in v1.3.
///
///   FEE_TO=0x… FEE_TO_SETTER=0x… forge script contracts-v14/script/DeployLaunchpadV14.s.sol:DeployLaunchpadV14 \
///     --rpc-url <RPC_URL> --broadcast --interactive      (FOUNDRY_PROFILE=v14; drop --broadcast to simulate)
///   Optional: USDC (default Arc's 0x3600…), POOL_MANAGER (default Uniswap's on Arc), LAUNCH_FEE (default 1 USDC).
///
/// The hook must live at an address whose low 14 bits are exactly its permission flags. It is deployed through the
/// deterministic CREATE2 deployer (0x4e59…956C, on Arc mainnet and testnet) with a salt mined here. Anyone could deploy
/// the same code with the same salt first (the same contract, the same launchpad in its constructor), which would only
/// make this deploy revert; nothing could be hijacked.
contract DeployLaunchpadV14 is Script {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant ARC_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_DONATE_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    struct Deployment {
        address launchpad;
        address hook;
        address router;
        address split;
        address holders;
        address combo;
    }

    function run() external returns (Deployment memory d) {
        address usdc = vm.envOr("USDC", ARC_USDC);
        address poolManager = vm.envOr("POOL_MANAGER", ARC_POOL_MANAGER);
        address feeTo = vm.envAddress("FEE_TO");
        address feeToSetter = vm.envAddress("FEE_TO_SETTER");
        uint256 launchFee = vm.envOr("LAUNCH_FEE", uint256(1e6));
        require(poolManager.code.length > 0, "POOL_MANAGER has no code on this chain");
        require(usdc.code.length > 0 || usdc == ARC_USDC, "USDC has no code on this chain");
        require(CREATE2_FACTORY.code.length > 0, "no CREATE2 deployer on this chain");

        vm.startBroadcast();
        d.launchpad = address(new ArchitexLaunchpadV14(usdc, poolManager, feeTo, feeToSetter, launchFee));

        bytes memory args = abi.encode(poolManager, d.launchpad, usdc);
        (address expected, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, HOOK_FLAGS, type(ArchitexLaunchHook).creationCode, args);
        d.hook = address(new ArchitexLaunchHook{salt: salt}(IPoolManager(poolManager), d.launchpad, usdc));
        require(d.hook == expected, "hook landed at an unexpected address");

        d.router = address(new ArchitexV4Router(d.launchpad, usdc, poolManager));
        ArchitexLaunchpadV14(payable(d.launchpad)).initialize(d.hook, d.router);

        d.split = address(new SplitPlugin(d.launchpad));
        d.holders = address(new HolderDistributionPlugin(d.launchpad));
        d.combo = address(new ComboPlugin(d.launchpad));
        vm.stopBroadcast();

        // Read the wiring back.
        ArchitexLaunchpadV14 pad = ArchitexLaunchpadV14(payable(d.launchpad));
        require(pad.hook() == d.hook && pad.router() == d.router, "launchpad wiring");
        require(pad.feeTo() == feeTo && pad.feeToSetter() == feeToSetter && pad.launchFee() == launchFee, "admin");
        require(uint160(d.hook) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS, "hook permission bits");
        require(ArchitexLaunchHook(d.hook).launchpad() == d.launchpad, "hook launchpad");

        // solhint-disable-next-line no-console
        console.log(
            string.concat(
                '{"launchpad":"',
                vm.toString(d.launchpad),
                '","hook":"',
                vm.toString(d.hook),
                '","router":"',
                vm.toString(d.router),
                '","split":"',
                vm.toString(d.split),
                '","holders":"',
                vm.toString(d.holders),
                '","combo":"',
                vm.toString(d.combo),
                '"}'
            )
        );
    }
}
