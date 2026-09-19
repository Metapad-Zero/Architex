// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../ArchitexFactory.sol";
import "../ArchitexPair.sol";
import "../TestToken.sol";

contract ArchitexFactoryTest is Test {
    ArchitexFactory factory;
    TestToken tokenA;
    TestToken tokenB;
    TestToken tokenC;
    address deployer = address(this);
    address alice    = address(0xA11CE);

    function setUp() public {
        factory = new ArchitexFactory(deployer);
        tokenA  = new TestToken("Token A", "TKA", 18, 1000, deployer);
        tokenB  = new TestToken("Token B", "TKB", 18, 1000, deployer);
        tokenC  = new TestToken("Token C", "TKC", 18, 1000, deployer);
    }

    // ─── createPair ───────────────────────────────────────────────────────────

    function test_createPair_basic() public {
        address pair = factory.createPair(address(tokenA), address(tokenB));
        assertTrue(pair != address(0));
        assertEq(factory.allPairsLength(), 1);
        assertEq(factory.allPairs(0), pair);
        // symmetric lookup
        assertEq(factory.getPair(address(tokenA), address(tokenB)), pair);
        assertEq(factory.getPair(address(tokenB), address(tokenA)), pair);
    }

    function test_createPair_ordering() public {
        // pair is stored as (token0 < token1)
        address pair = factory.createPair(address(tokenB), address(tokenA));
        ArchitexPair p = ArchitexPair(pair);
        address t0 = address(tokenA) < address(tokenB) ? address(tokenA) : address(tokenB);
        address t1 = address(tokenA) < address(tokenB) ? address(tokenB) : address(tokenA);
        assertEq(p.token0(), t0);
        assertEq(p.token1(), t1);
    }

    function test_createPair_emitsEvent() public {
        (address t0, address t1) = address(tokenA) < address(tokenB)
            ? (address(tokenA), address(tokenB))
            : (address(tokenB), address(tokenA));
        // Only check indexed params (t0, t1) and the last data param (allPairsLength=1).
        // Skip checking the pair address (3rd param) since we don't know it in advance.
        vm.expectEmit(true, true, false, false);
        emit IArchitexFactory.PairCreated(t0, t1, address(0), 0);
        factory.createPair(address(tokenA), address(tokenB));
    }

    function test_createPair_revertDuplicate() public {
        factory.createPair(address(tokenA), address(tokenB));
        vm.expectRevert(IArchitexFactory.PairExists.selector);
        factory.createPair(address(tokenA), address(tokenB));
    }

    function test_createPair_revertDuplicateReversed() public {
        factory.createPair(address(tokenA), address(tokenB));
        vm.expectRevert(IArchitexFactory.PairExists.selector);
        factory.createPair(address(tokenB), address(tokenA));
    }

    function test_createPair_revertIdentical() public {
        vm.expectRevert(IArchitexFactory.IdenticalAddresses.selector);
        factory.createPair(address(tokenA), address(tokenA));
    }

    function test_createPair_revertZeroAddress() public {
        vm.expectRevert(IArchitexFactory.ZeroAddress.selector);
        factory.createPair(address(0), address(tokenA));
    }

    function test_createPair_revertZeroAddressB() public {
        vm.expectRevert(IArchitexFactory.ZeroAddress.selector);
        factory.createPair(address(tokenA), address(0));
    }

    function test_createPair_multiplePairs() public {
        factory.createPair(address(tokenA), address(tokenB));
        factory.createPair(address(tokenA), address(tokenC));
        factory.createPair(address(tokenB), address(tokenC));
        assertEq(factory.allPairsLength(), 3);
    }

    // ─── feeTo / feeToSetter ──────────────────────────────────────────────────

    function test_setFeeTo_ownerCanSet() public {
        factory.setFeeTo(alice);
        assertEq(factory.feeTo(), alice);
    }

    function test_setFeeTo_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit IArchitexFactory.FeeToUpdated(alice);
        factory.setFeeTo(alice);
    }

    function test_setFeeTo_revertForbidden() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexFactory.Forbidden.selector);
        factory.setFeeTo(alice);
    }

    function test_setFeeToSetter_ownerCanTransfer() public {
        factory.setFeeToSetter(alice);
        assertEq(factory.feeToSetter(), alice);
    }

    function test_setFeeToSetter_revertForbidden() public {
        vm.prank(alice);
        vm.expectRevert(IArchitexFactory.Forbidden.selector);
        factory.setFeeToSetter(alice);
    }

    function test_feeToStartsAtZero() public view {
        assertEq(factory.feeTo(), address(0));
    }
}
