// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {DeployLaunchpadV14} from "../script/DeployLaunchpadV14.s.sol";
import {ArchitexLaunchpadV14} from "../src/ArchitexLaunchpadV14.sol";
import {ArchitexLaunchHook} from "../src/ArchitexLaunchHook.sol";
import {MockUSDC} from "./utils/MockUSDC.sol";

/// @notice The deploy script, end to end, against Uniswap's PoolManager code and a USDC at Arc's address: the hook lands
///         at a mined address carrying exactly its permission bits, everything is wired, and a token launches, graduates
///         into Uniswap and trades.
contract DeployLaunchpadV14ScriptTest is Test {
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function test_deployScriptWiresEverythingAndATokenGraduates() public {
        vm.etch(POOL_MANAGER, vm.parseBytes(vm.readFile("contracts-v14/test/fixtures/PoolManager.arc.hex")));
        deployCodeTo("MockUSDC.sol:MockUSDC", "", ARC_USDC);
        address feeTo = makeAddr("feeTo");
        vm.setEnv("FEE_TO", vm.toString(feeTo));
        vm.setEnv("FEE_TO_SETTER", vm.toString(feeTo));

        DeployLaunchpadV14.Deployment memory d = new DeployLaunchpadV14().run();

        assertEq(uint160(d.hook) & Hooks.ALL_HOOK_MASK, uint160(0x28CC), "exactly the hook's permission bits");
        ArchitexLaunchpadV14 pad = ArchitexLaunchpadV14(payable(d.launchpad));
        assertEq(pad.hook(), d.hook);
        assertEq(pad.router(), d.router);
        assertEq(pad.usdc(), ARC_USDC);
        assertEq(pad.poolManager(), POOL_MANAGER);
        assertEq(ArchitexLaunchHook(d.hook).launchpad(), d.launchpad);

        address creator = makeAddr("creator");
        MockUSDC(ARC_USDC).mint(creator, 2_000_000e6);
        vm.startPrank(creator);
        MockUSDC(ARC_USDC).approve(d.launchpad, type(uint256).max);
        address token = pad.createToken("Deployed", "DPL", "", 100, d.split, _oneSplit(creator), false, 0, 0, 1e6);
        vm.roll(block.number + 25);
        pad.buy(token, 1_000_000e6, 0, creator, type(uint256).max);
        vm.stopPrank();
        assertTrue(pad.isGraduated(token));
    }

    function _oneSplit(address payee) internal pure returns (bytes memory) {
        address[] memory payees = new address[](1);
        payees[0] = payee;
        uint256[] memory shares = new uint256[](1);
        shares[0] = 1;
        return abi.encode(payees, shares);
    }
}
