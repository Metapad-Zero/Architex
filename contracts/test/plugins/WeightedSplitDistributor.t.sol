// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../../plugins/fee-distribution/WeightedSplitDistributor.sol";
import "../../plugins/fee-distribution/EqualSplitDistributor.sol";
import "../../TestToken.sol";

contract WeightedSplitDistributorTest is Test {
    TestToken usdc;
    TestToken lp;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    function setUp() public {
        usdc = new TestToken("USD Coin", "USDC", 6, 0, address(this));
        lp = new TestToken("Architex LP", "ATX-LP", 18, 0, address(this));
    }

    function test_constructor_rejectsEmptyPayees() public {
        address[] memory payees = new address[](0);
        uint256[] memory shares = new uint256[](0);
        vm.expectRevert(WeightedSplitDistributor.NoPayees.selector);
        new WeightedSplitDistributor(payees, shares);
    }

    function test_constructor_rejectsMismatchedLengths() public {
        address[] memory payees = new address[](2);
        payees[0] = alice;
        payees[1] = bob;
        uint256[] memory shares = new uint256[](1);
        shares[0] = 1;
        vm.expectRevert(WeightedSplitDistributor.PayeesSharesLengthMismatch.selector);
        new WeightedSplitDistributor(payees, shares);
    }

    function test_constructor_rejectsZeroAddress() public {
        address[] memory payees = new address[](1);
        payees[0] = address(0);
        uint256[] memory shares = new uint256[](1);
        shares[0] = 1;
        vm.expectRevert(WeightedSplitDistributor.ZeroAddress.selector);
        new WeightedSplitDistributor(payees, shares);
    }

    function test_constructor_rejectsZeroShare() public {
        address[] memory payees = new address[](1);
        payees[0] = alice;
        uint256[] memory shares = new uint256[](1);
        shares[0] = 0;
        vm.expectRevert(WeightedSplitDistributor.ZeroShares.selector);
        new WeightedSplitDistributor(payees, shares);
    }

    function test_constructor_rejectsDuplicatePayee() public {
        address[] memory payees = new address[](2);
        payees[0] = alice;
        payees[1] = alice;
        uint256[] memory shares = new uint256[](2);
        shares[0] = 1;
        shares[1] = 1;
        vm.expectRevert(WeightedSplitDistributor.DuplicatePayee.selector);
        new WeightedSplitDistributor(payees, shares);
    }

    function _weighted() internal returns (WeightedSplitDistributor d) {
        address[] memory payees = new address[](3);
        payees[0] = alice;
        payees[1] = bob;
        payees[2] = carol;
        uint256[] memory shares = new uint256[](3);
        shares[0] = 50;
        shares[1] = 30;
        shares[2] = 20;
        d = new WeightedSplitDistributor(payees, shares);
    }

    function test_release_splitsByShare() public {
        WeightedSplitDistributor d = _weighted();
        usdc.mint(address(d), 1000e6);

        assertEq(d.releasable(address(usdc), alice), 500e6);
        assertEq(d.releasable(address(usdc), bob), 300e6);
        assertEq(d.releasable(address(usdc), carol), 200e6);

        d.release(address(usdc), alice);
        assertEq(usdc.balanceOf(alice), 500e6);
        assertEq(d.releasable(address(usdc), alice), 0);
    }

    function test_release_anyoneCanTriggerPayeesRelease() public {
        WeightedSplitDistributor d = _weighted();
        usdc.mint(address(d), 100e6);

        vm.prank(address(0xDEAD));
        d.release(address(usdc), alice);
        assertEq(usdc.balanceOf(alice), 50e6);
    }

    function test_release_revertsWhenNothingOwed() public {
        WeightedSplitDistributor d = _weighted();
        vm.expectRevert(WeightedSplitDistributor.NothingToRelease.selector);
        d.release(address(usdc), alice);
    }

    function test_release_revertsForNonPayee() public {
        WeightedSplitDistributor d = _weighted();
        usdc.mint(address(d), 100e6);
        vm.expectRevert(WeightedSplitDistributor.NothingToRelease.selector);
        d.release(address(usdc), address(0xDEAD));
    }

    function test_release_accountsForFundsArrivingAfterAPriorRelease() public {
        WeightedSplitDistributor d = _weighted();
        usdc.mint(address(d), 100e6);
        d.release(address(usdc), alice); // alice gets 50e6, released[usdc][alice] = 50e6

        usdc.mint(address(d), 100e6); // total received now 200e6, alice's total owed = 100e6
        assertEq(d.releasable(address(usdc), alice), 50e6);
        d.release(address(usdc), alice);
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    function test_release_tracksMultipleTokensIndependently() public {
        WeightedSplitDistributor d = _weighted();
        usdc.mint(address(d), 100e6);
        lp.mint(address(d), 10 ether);

        d.release(address(usdc), alice);
        d.release(address(lp), alice);

        assertEq(usdc.balanceOf(alice), 50e6);
        assertEq(lp.balanceOf(alice), 5 ether);
        assertEq(d.releasable(address(usdc), alice), 0);
        assertEq(d.releasable(address(lp), alice), 0);
    }

    function testFuzz_totalReleasedNeverExceedsBalanceReceived(uint96 amount) public {
        WeightedSplitDistributor d = _weighted();
        vm.assume(amount > 0);
        usdc.mint(address(d), amount);

        uint256 releasedTotal;
        if (d.releasable(address(usdc), alice) > 0) {
            d.release(address(usdc), alice);
            releasedTotal += usdc.balanceOf(alice);
        }
        if (d.releasable(address(usdc), bob) > 0) {
            d.release(address(usdc), bob);
            releasedTotal += usdc.balanceOf(bob);
        }
        if (d.releasable(address(usdc), carol) > 0) {
            d.release(address(usdc), carol);
            releasedTotal += usdc.balanceOf(carol);
        }
        assertLe(releasedTotal, amount);
    }
}

contract EqualSplitDistributorTest is Test {
    TestToken usdc;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    function setUp() public {
        usdc = new TestToken("USD Coin", "USDC", 6, 0, address(this));
    }

    function test_equalSplit_threeWay() public {
        address[] memory payees = new address[](3);
        payees[0] = alice;
        payees[1] = bob;
        payees[2] = carol;
        EqualSplitDistributor d = new EqualSplitDistributor(payees);

        usdc.mint(address(d), 900e6);
        d.release(address(usdc), alice);
        d.release(address(usdc), bob);
        d.release(address(usdc), carol);

        assertEq(usdc.balanceOf(alice), 300e6);
        assertEq(usdc.balanceOf(bob), 300e6);
        assertEq(usdc.balanceOf(carol), 300e6);
    }

    function test_equalSplit_roundsDownConsistently() public {
        address[] memory payees = new address[](3);
        payees[0] = alice;
        payees[1] = bob;
        payees[2] = carol;
        EqualSplitDistributor d = new EqualSplitDistributor(payees);

        usdc.mint(address(d), 100); // 100 / 3 -> 33 each, 1 unit dust stays undistributed
        d.release(address(usdc), alice);
        d.release(address(usdc), bob);
        d.release(address(usdc), carol);

        assertEq(usdc.balanceOf(alice), 33);
        assertEq(usdc.balanceOf(bob), 33);
        assertEq(usdc.balanceOf(carol), 33);
        assertEq(usdc.balanceOf(address(d)), 1);
    }
}
