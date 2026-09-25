// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SplitPlugin} from "../../contracts/plugins/launch/SplitPlugin.sol";
import {HolderDistributionPlugin} from "../../contracts/plugins/launch/HolderDistributionPlugin.sol";
import {ComboPlugin} from "../../contracts/plugins/launch/ComboPlugin.sol";
import {ILaunchTokenExtensions} from "../../contracts/interfaces/ILaunchTokenExtensions.sol";
import {IArchitexLaunchpadV14} from "../src/interfaces/IArchitexLaunchpadV14.sol";
import {V14Base} from "./V14Base.sol";

/// @notice v1.3's Split, Distribute to holders and Combo plugins run unchanged against the v1.4 launchpad (they only use
///         IArchitexLaunchpadLite), with creator fees from the curve and from the Uniswap pool alike.
contract PluginsV14Test is V14Base {
    SplitPlugin internal split;
    HolderDistributionPlugin internal holders;
    ComboPlugin internal combo;

    address internal payeeA = makeAddr("payeeA");
    address internal payeeB = makeAddr("payeeB");

    function _usdcAt() internal pure override returns (address) {
        return 0x3600000000000000000000000000000000000000; // Arc's own USDC address, as on mainnet
    }

    function setUp() public override {
        super.setUp();
        split = new SplitPlugin(address(pad));
        holders = new HolderDistributionPlugin(address(pad));
        combo = new ComboPlugin(address(pad));
    }

    function _tradeOnBothSides(address token) internal {
        _step(pad.SNIPE_BLOCKS());
        vm.prank(carol);
        pad.buy(token, 2_000e6, 0, carol, MAX); // curve
        vm.prank(bob);
        pad.buy(token, 1_000_000e6, 0, bob, MAX); // sells out: graduates
        _step(hook.SNIPE_BLOCKS());
        vm.startPrank(carol);
        uint256 got = router.buy(token, 3_000e6, 0, carol, MAX); // pool
        router.sell(token, got / 2, 0, carol, MAX);
        vm.stopPrank();
    }

    function test_splitCollectsCurveAndPoolFees() public {
        address[] memory payees = new address[](2);
        (payees[0], payees[1]) = (payeeA, payeeB);
        uint256[] memory shares = new uint256[](2);
        (shares[0], shares[1]) = (3, 1);
        address token = _launch(500, address(split), abi.encode(payees, shares), false, 0);
        _tradeOnBothSides(token);

        uint256 pending = pad.pendingCreatorFees(token);
        assertGt(pending, 0);
        pad.collectCreatorFees(token);
        assertEq(pad.pendingCreatorFees(token), 0);
        split.release(token, payeeA);
        split.release(token, payeeB);
        assertApproxEqAbs(usdc.balanceOf(payeeA), pending * 3 / 4, 1);
        assertApproxEqAbs(usdc.balanceOf(payeeB), pending / 4, 1);
        _assertSolvent();
    }

    function test_holdersStreamTheFeesAndThePoolEarnsNone() public {
        address token = _launch(1000, address(holders), "", false, 0);
        _tradeOnBothSides(token);
        uint256 pending = pad.pendingCreatorFees(token);
        pad.collectCreatorFees(token);
        assertEq(IERC20(address(usdc)).balanceOf(token), pending, "the token holds the stream");

        vm.warp(block.timestamp + 1 days);
        ILaunchTokenExtensions t = ILaunchTokenExtensions(token);
        assertEq(t.claimable(POOL_MANAGER), 0, "the pool never earns");
        assertEq(t.claimable(address(hook)), 0, "the hook never earns");
        uint256 claimable = t.claimable(bob) + t.claimable(carol);
        assertApproxEqAbs(claimable, pending, 2, "holders earn all of it over the day");
        _assertSolvent();
    }

    function test_comboPaysAWalletAndSplit() public {
        address[] memory payees = new address[](1);
        payees[0] = payeeA;
        uint256[] memory shares = new uint256[](1);
        shares[0] = 1;
        address[] memory targets = new address[](2);
        (targets[0], targets[1]) = (creatorWallet, address(split));
        uint16[] memory bps = new uint16[](2);
        (bps[0], bps[1]) = (6_000, 4_000);
        bytes[] memory datas = new bytes[](2);
        (datas[0], datas[1]) = ("", abi.encode(payees, shares));
        address token = _launch(300, address(combo), abi.encode(targets, bps, datas), false, 0);
        _tradeOnBothSides(token);

        uint256 pending = pad.pendingCreatorFees(token);
        pad.collectCreatorFees(token);
        split.release(token, payeeA);
        assertApproxEqAbs(usdc.balanceOf(creatorWallet), pending * 6 / 10, 1);
        assertApproxEqAbs(usdc.balanceOf(payeeA), pending * 4 / 10, 1);
        _assertSolvent();
    }

    function test_theHookAndThePoolManagerAreRefusedAsDestinations() public {
        vm.startPrank(alice);
        vm.expectRevert(IArchitexLaunchpadV14.InvalidPlugin.selector);
        pad.createToken("X", "X", "", 0, POOL_MANAGER, "", false, 0, 0, MAX);
        vm.expectRevert(IArchitexLaunchpadV14.InvalidPlugin.selector);
        pad.createToken("X", "X", "", 0, address(hook), "", false, 0, 0, MAX);
        vm.expectRevert(IArchitexLaunchpadV14.InvalidPlugin.selector);
        pad.createToken("X", "X", "", 0, address(router), "", false, 0, 0, MAX);
        vm.stopPrank();

        // and a Split refuses them as payees (IArchitexLaunchpadLite.isLaunchPair)
        address[] memory payees = new address[](1);
        payees[0] = POOL_MANAGER;
        uint256[] memory shares = new uint256[](1);
        shares[0] = 1;
        vm.prank(alice);
        vm.expectRevert();
        pad.createToken("X", "X", "", 0, address(split), abi.encode(payees, shares), false, 0, 0, MAX);
    }
}
