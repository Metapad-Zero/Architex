// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArchitexLaunchpad} from "../../../interfaces/IArchitexLaunchpad.sol";
import {ILaunchRouter} from "../../../interfaces/ILaunchRouter.sol";
import {IBuybackBurnPlugin} from "../../../interfaces/plugins/IBuybackBurnPlugin.sol";
import {BuybackBurnPlugin} from "../../../plugins/launch/BuybackBurnPlugin.sol";
import {LaunchpadV13Base} from "../../launchpad/LaunchpadV13Base.sol";

/// @notice Buyback & burn's minimum offer, MIN_RUN_USDC = 3 units, on the real launchpad and launch router. Fees round
///         up, so a smaller buy pays them all and buys nothing (the launchpad or router reverts ZeroAmount); below the
///         minimum previewRun is 0 and run reverts NothingToBuy, so the site never offers a run that would fail.
contract BuybackBurnDustTest is LaunchpadV13Base {
    uint256 internal constant MIN = 3;

    BuybackBurnPlugin internal buyback;
    address internal keeper = makeAddr("keeper");
    address internal funder = makeAddr("funder");

    function setUp() public override {
        super.setUp();
        buyback = new BuybackBurnPlugin(address(pad));
    }

    /// @dev A token whose fees go to Buyback & burn, on the curve or graduated into its pool, with `held` waiting.
    function _token(uint16 c, bool inPool, uint256 held) internal returns (address token) {
        token = _create(c, address(buyback));
        if (inPool) _graduate(token);
        if (held != 0) {
            usdc.mint(funder, held);
            vm.startPrank(funder);
            usdc.approve(address(buyback), held);
            buyback.onFees(token, held);
            vm.stopPrank();
        }
    }

    function test_minimumIsExposed() public view {
        assertEq(buyback.MIN_RUN_USDC(), MIN);
    }

    /// @dev 1 or 2 units waiting, at 0% and 10%, on the curve and in the pool: nothing to preview, nothing to run, and
    ///         the dust stays where it is.
    function test_dustBelowTheMinimum_previewsZeroAndRunRevertsNothingToBuy() public {
        uint16[2] memory fees = [uint16(0), 1000];
        for (uint256 f; f < 2; ++f) {
            for (uint256 p; p < 2; ++p) {
                for (uint256 dust = 1; dust < MIN; ++dust) {
                    address token = _token(fees[f], p == 1, dust);
                    (uint256 offered, bool graduated) = buyback.previewRun(token);
                    assertEq(offered, 0, "no offer below the minimum");
                    assertEq(graduated, p == 1);
                    vm.prank(keeper);
                    vm.expectRevert(abi.encodeWithSelector(IBuybackBurnPlugin.NothingToBuy.selector, token));
                    buyback.run(token);
                    assertEq(buyback.usdcHeld(token), dust);
                    assertEq(buyback.lastRunAt(token), 0);
                }
            }
        }
    }

    /// @dev Exactly the minimum runs, at 0% and 10%, on the curve and in the pool, and burns at least one token.
    function test_exactlyTheMinimumRuns() public {
        uint16[2] memory fees = [uint16(0), 1000];
        for (uint256 f; f < 2; ++f) {
            for (uint256 p; p < 2; ++p) {
                address token = _token(fees[f], p == 1, MIN);
                (uint256 offered,) = buyback.previewRun(token);
                assertEq(offered, MIN);
                uint256 supply = IERC20(token).totalSupply();
                vm.prank(keeper);
                (uint256 spent, uint256 burned) = buyback.run(token);
                assertEq(spent, MIN);
                assertGe(burned, 1, "bought and burned something");
                assertEq(IERC20(token).totalSupply(), supply - burned);
                assertEq(buyback.usdcHeld(token), 0, "nothing left behind");
                _assertSolvent();
            }
        }
    }

    /// @dev Why 3: at a 10% creator fee, 2 units pay ceil(0.01) + ceil(0.2) = 1 + 1 in fees and buy nothing, on the
    ///      curve and in the pool; at 0%, 1 unit pays 1. 3 units leave 1 net unit, which buys tokens.
    function test_whyTheMinimumIsThree() public {
        address onCurve = _create(1000, creatorWallet);
        address inPool = _create(1000, creatorWallet);
        address zeroFee = _create(0, creatorWallet);
        _graduate(inPool);
        vm.startPrank(alice);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.buy(onCurve, 2, 0, alice, type(uint256).max);
        vm.expectRevert(ILaunchRouter.ZeroAmount.selector);
        router.buy(inPool, 2, 0, alice, type(uint256).max);
        vm.expectRevert(IArchitexLaunchpad.ZeroAmount.selector);
        pad.buy(zeroFee, 1, 0, alice, type(uint256).max);
        (uint256 curveOut,) = pad.buy(onCurve, 3, 0, alice, type(uint256).max);
        uint256 poolOut = router.buy(inPool, 3, 0, alice, type(uint256).max);
        vm.stopPrank();
        assertGt(curveOut, 0);
        assertGt(poolOut, 0);
    }

    /// @dev The minimum runs at any creator fee and wherever the market is: anywhere on the curve short of selling out,
    ///      or in the pool after someone buys up to 90M USDC into it (its USDC reserve 3,600x the graduation seed).
    function testFuzz_theMinimumAlwaysRuns(uint16 feeRaw, bool inPool, uint64 moveRaw) public {
        uint16 c = uint16(bound(feeRaw, 0, 1000));
        address token = _token(c, inPool, MIN);
        vm.startPrank(carol);
        if (inPool) {
            uint256 move = bound(moveRaw, 0, 90_000_000e6);
            if (move >= 1e6) router.buy(token, move, 0, carol, type(uint256).max);
        } else {
            uint256 move = bound(moveRaw, 0, 25_000e6); // short of the sell-out at any fee
            if (move >= 1e6) pad.buy(token, move, 0, carol, type(uint256).max);
        }
        vm.stopPrank();
        assertEq(pad.isGraduated(token), inPool);

        (uint256 offered,) = buyback.previewRun(token);
        assertEq(offered, MIN);
        vm.prank(keeper);
        (uint256 spent, uint256 burned) = buyback.run(token);
        assertEq(spent, MIN);
        assertGe(burned, 1);
        assertEq(buyback.usdcHeld(token), 0);
    }
}
