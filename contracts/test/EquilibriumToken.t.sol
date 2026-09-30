// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "forge-std/Test.sol";
import "../equilibrium/EquilibriumToken.sol";

contract EquilibriumTokenTest is Test {
    function test_sameIdentityIssuesOnce() public {
        EquilibriumIssuanceFactory factory = new EquilibriumIssuanceFactory(address(this));
        address token = factory.issue(bytes32(uint256(1)), bytes32(uint256(2)), "Equilibrium", "EQL", address(this), 1_000_000e6);
        assertEq(factory.issue(bytes32(uint256(1)), bytes32(uint256(2)), "Equilibrium", "EQL", address(this), 1_000_000e6), token);
        assertEq(EquilibriumCanonical(token).totalSupply(), 1_000_000e6);
        vm.expectRevert("Identity conflict");
        factory.issue(bytes32(uint256(1)), bytes32(uint256(3)), "Equilibrium", "EQL", address(this), 1_000_000e6);
        vm.expectRevert("Identity conflict");
        factory.issue(bytes32(uint256(1)), bytes32(uint256(2)), "Equilibrium", "EQL", address(this), 1e6);
        vm.prank(address(0xBAD)); vm.expectRevert("Operator only");
        factory.issue(bytes32(uint256(5)), bytes32(uint256(2)), "Equilibrium", "EQL", address(this), 1e6);
    }
    function test_spokeAuthorityBindsOnceAndCannotInflatePastCap() public {
        EquilibriumSpoke spoke = new EquilibriumSpoke("Equilibrium", "EQL", address(this), 100e6);
        vm.prank(address(0xBAD)); vm.expectRevert("Mint forbidden"); spoke.mint(address(this), 1);
        spoke.setMinter(address(this));
        vm.expectRevert("Minter binding forbidden"); spoke.setMinter(address(this));
        spoke.mint(address(this), 100e6);
        vm.expectRevert("Mint forbidden"); spoke.mint(address(this), 1);
        spoke.burn(20e6); assertEq(spoke.totalSupply(), 80e6);
        vm.prank(address(0xBAD)); vm.expectRevert("Burn forbidden"); spoke.burn(1);
    }
    function test_canonicalHasNoMintOrFaucet() public {
        EquilibriumCanonical token = new EquilibriumCanonical("Equilibrium", "EQL", address(this), 100e6);
        (bool mintOk,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
        (bool faucetOk,) = address(token).call(abi.encodeWithSignature("faucet()"));
        assertFalse(mintOk); assertFalse(faucetOk); assertEq(token.decimals(), 6);
    }
}
