// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArchitexLaunchpad} from "../../../interfaces/IArchitexLaunchpad.sol";
import {BuybackBurnPlugin} from "../../../plugins/launch/BuybackBurnPlugin.sol";
import {LaunchpadV13Base} from "../../launchpad/LaunchpadV13Base.sol";

/// @notice Front-running Buyback & burn on the real v1.3 launchpad, curve and launch pool (V13-SPEC §2.2). A trader
///         buys, the buyback runs, the trader sells. The exact numbers come from the exact-integer model of the curve
///         and pool that the documented hold times were computed with, so these tests also pin the contracts to it.
contract BuybackBurnFrontRunTest is LaunchpadV13Base {
    uint256 internal constant HOUR = 3600;
    uint256 internal constant START = 1_700_000_000;
    uint256 internal constant PLENTY = 1_000_000e6;

    BuybackBurnPlugin internal buyback;
    address internal keeper = makeAddr("keeper");
    address internal funder = makeAddr("funder");

    function setUp() public override {
        super.setUp();
        buyback = new BuybackBurnPlugin(address(pad));
        vm.warp(START);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// @dev A token whose creator fees go to Buyback & burn, `pre` USDC already bought on its curve by carol, and
    ///      `waiting` USDC in the plugin for it (delivered straight to onFees, which anyone may do).
    function _setUpToken(uint16 c, uint256 pre, uint256 waiting) internal returns (address token) {
        token = _create(c, address(buyback));
        if (pre != 0) {
            vm.prank(carol);
            pad.buy(token, pre, 0, carol, type(uint256).max);
        }
        usdc.mint(funder, waiting);
        vm.startPrank(funder);
        usdc.approve(address(buyback), waiting);
        buyback.onFees(token, waiting);
        vm.stopPrank();
    }

    /// @dev A keeper runs the buyback if it has a budget; the spend is exactly what previewRun promised.
    function _run(address token) internal returns (uint256 spent) {
        (uint256 offered,) = buyback.previewRun(token);
        if (offered == 0) return 0;
        vm.prank(keeper);
        (spent,) = buyback.run(token);
        assertEq(spent, offered, "previewRun == run");
    }

    /// @dev Runs once now (a full cap: the token never ran), then once after each gap, each in a new block.
    function _runs(address token, uint256[] memory gaps) internal {
        _run(token);
        for (uint256 i; i < gaps.length; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + gaps[i]);
            _run(token);
        }
    }

    /// @dev mallory buys `size` on the curve, holds through the runs, and sells everything she bought.
    function _attackOnCurve(address token, uint256 size, uint256[] memory gaps) internal returns (int256 pnl) {
        uint256 before = usdc.balanceOf(mallory);
        vm.prank(mallory);
        (uint256 got,) = pad.buy(token, size, 0, mallory, type(uint256).max);
        _runs(token, gaps);
        assertFalse(pad.isGraduated(token), "still on the curve");
        vm.prank(mallory);
        pad.sell(token, got, 0, mallory, type(uint256).max);
        pnl = int256(usdc.balanceOf(mallory)) - int256(before);
    }

    /// @dev The same in the launch pool, through the router.
    function _attackInPool(address token, uint256 size, uint256[] memory gaps) internal returns (int256 pnl) {
        uint256 before = usdc.balanceOf(mallory);
        vm.prank(mallory);
        uint256 got = router.buy(token, size, 0, mallory, vm.getBlockTimestamp());
        _runs(token, gaps);
        vm.prank(mallory);
        router.sell(token, got, 0, mallory, vm.getBlockTimestamp());
        pnl = int256(usdc.balanceOf(mallory)) - int256(before);
    }

    function _gaps(uint256 count, uint256 secs) internal pure returns (uint256[] memory gaps) {
        gaps = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            gaps[i] = secs;
        }
    }

    /// @dev `count` runs spread evenly over `hold` seconds.
    function _spread(uint256 hold, uint256 count) internal pure returns (uint256[] memory gaps) {
        gaps = _gaps(count, hold / count);
        gaps[count - 1] += hold % count;
    }

    /// @dev 90% of the documented bound ((0.5% + c) / 0.25% - 1) hours, i.e. (25 + c) * 144 seconds.
    function _underTheBound(uint256 c) internal pure returns (uint256) {
        return ((25 + c) * 144 * 9) / 10;
    }

    /// @dev The plugin's ledger and the launchpad's books after the attack.
    function _assertLedger(address token, uint256 delivered) internal view {
        assertEq(buyback.usdcHeld(token) + buyback.totalUsdcSpent(token), delivered, "held + spent == delivered");
        assertEq(usdc.balanceOf(address(buyback)), buyback.usdcHeld(token));
        assertEq(IERC20(token).balanceOf(address(buyback)), 0, "everything bought was burned");
        assertEq(
            IERC20(token).totalSupply(), TOTAL_SUPPLY - buyback.totalTokensBurned(token), "supply fell by the burn"
        );
        _assertSolvent();
    }

    // ─── The chain attack ─────────────────────────────────────────────────────

    /// @dev The reviewer's example against the per-block cap: 1% creator fee, 1,000 USDC waiting, buy 8,000 USDC on a
    ///      curve at ~10k virtual USDC, run in each of the next 22 blocks, sell: +436 USDC, 44% of the pile. Paced by
    ///      time, blocks a second apart (the most runs whole-second timestamps allow) add a second's budget each to
    ///      the one full cap: 45 USDC spent, and the trader loses 208.
    function test_chainAttack_reviewersExampleNowLoses() public {
        address token = _setUpToken(100, 1_700e6, 1_000e6);
        int256 pnl = _attackOnCurve(token, 8_000e6, _gaps(21, 1));
        assertEq(pnl, -208_203_877, "the exact-integer model");
        assertEq(buyback.totalUsdcSpent(token), 44_981_075);
        _assertLedger(token, 1_000e6);
    }

    /// @dev Buy, run in each of the next 50 blocks, sell, at every creator fee the spec quotes and three sizes. Every
    ///      combination loses, by exactly what the model says.
    function test_chainAttack_fiftyBlocksLosesAtEveryCreatorFee() public {
        uint16[5] memory fees = [uint16(50), 100, 200, 500, 1000];
        uint256[3] memory sizes = [uint256(2_000e6), 8_000e6, 20_000e6];
        int256[3][5] memory model = [
            [int256(-30_767_699), -128_529_007, -332_288_972],
            [int256(-50_651_093), -207_971_270, -530_734_034],
            [int256(-90_113_978), -365_643_281, -924_597_284],
            [int256(-206_071_909), -828_960_868, -2_081_975_437],
            [int256(-391_235_676), -1_568_837_138, -3_930_253_484]
        ];
        for (uint256 i; i < fees.length; ++i) {
            for (uint256 j; j < sizes.length; ++j) {
                address token = _setUpToken(fees[i], 1_700e6, 1_000e6);
                int256 pnl = _attackOnCurve(token, sizes[j], _gaps(49, 1));
                assertLt(pnl, 0, "the chain attack loses");
                assertEq(pnl, model[i][j], "the exact-integer model");
            }
        }
    }

    /// @dev So the losses above are not vacuous: a trader who holds through the documented hours does profit, like
    ///      any holder of a token whose fees buy it back. At 1% the shortest profitable hold is 5.2 h; holding 8 h
    ///      with a run every 10 minutes makes +20.92 USDC on 2,000.
    function test_holdingPastTheBoundProfits() public {
        address token = _setUpToken(100, 1_700e6, 1_000e6);
        int256 pnl = _attackOnCurve(token, 2_000e6, _gaps(48, 600));
        assertEq(pnl, 20_920_189, "the exact-integer model");
        assertEq(buyback.totalUsdcSpent(token), 272_421_942);
        _assertLedger(token, 1_000e6);
    }

    // ─── The documented bound ─────────────────────────────────────────────────

    /// @dev Buy S on the curve, k runs spread over a hold of T, sell: never a profit while T stays under the
    ///      documented bound for the token's creator fee (with a 10% margin), whatever the fee, the size, the curve's
    ///      starting point and the number of runs. The pile never limits a run (the worst case).
    function testFuzz_holdUnderTheBoundNeverProfits_curve(
        uint16 feeRaw,
        uint64 preRaw,
        uint64 sizeRaw,
        uint8 runsRaw,
        uint32 holdRaw
    ) public {
        uint16 c = uint16(bound(feeRaw, 0, 1000));
        uint256 pre = preRaw % 4 == 0 ? 0 : bound(preRaw, 1e6, 8_000e6); // a fresh curve, or one others bought into
        uint256 size = bound(sizeRaw, 1e6, 12_000e6);
        uint256 k = bound(runsRaw, 1, 48);
        uint256 hold = bound(holdRaw, 0, _underTheBound(c));
        address token = _setUpToken(c, pre, PLENTY);

        int256 pnl = _attackOnCurve(token, size, _spread(hold, k));
        assertEq(vm.getBlockTimestamp(), START + hold, "held for T");
        assertLe(pnl, 0, "no profit under the bound");
        _assertLedger(token, PLENTY);
    }

    /// @dev The same in the launch pool after graduation, through the router.
    function testFuzz_holdUnderTheBoundNeverProfits_pool(uint16 feeRaw, uint64 sizeRaw, uint8 runsRaw, uint32 holdRaw)
        public
    {
        uint16 c = uint16(bound(feeRaw, 0, 1000));
        uint256 size = bound(sizeRaw, 1e6, 20_000e6);
        uint256 k = bound(runsRaw, 1, 48);
        uint256 hold = bound(holdRaw, 0, _underTheBound(c));
        address token = _setUpToken(c, 0, PLENTY);
        _graduate(token);

        int256 pnl = _attackInPool(token, size, _spread(hold, k));
        assertEq(vm.getBlockTimestamp(), START + hold, "held for T");
        assertLe(pnl, 0, "no profit under the bound");
        _assertLedger(token, PLENTY);
    }

    // ─── Sell-out ─────────────────────────────────────────────────────────────

    /// @dev A run can be the curve's sell-out buy: the launchpad takes only what the last tokens cost and graduates
    ///      the token in the same call, the rest stays waiting, and the next run, prorated from that one, buys in the
    ///      launch pool through the router.
    function test_runThatSellsOutTheCurve_thenAPacedRunInThePool() public {
        uint16 c = 100;
        address token = _setUpToken(c, 0, 1_000e6);
        // carol brings the curve to about 20 USDC short of selling out
        IArchitexLaunchpad.Curve memory cv = pad.curves(token);
        uint256 remaining = CURVE_SUPPLY - cv.tokensSold;
        uint256 k = uint256(cv.virtualUsdc) * uint256(cv.virtualTokens);
        uint256 net = _divCeil(k, uint256(cv.virtualTokens) - remaining) - uint256(cv.virtualUsdc);
        uint256 gross = net + _divCeil(net * (FEE_BPS + c), BPS - FEE_BPS - c);
        vm.prank(carol);
        pad.buy(token, gross - 20e6, 0, carol, type(uint256).max);
        assertFalse(pad.isGraduated(token));
        uint256 left = CURVE_SUPPLY - pad.curves(token).tokensSold;

        (uint256 offered, bool graduated) = buyback.previewRun(token);
        assertFalse(graduated);
        assertEq(offered, (pad.virtualUsdcOf(token) * 25) / BPS, "a full cap");
        vm.prank(keeper);
        (uint256 spent, uint256 burned) = buyback.run(token);
        assertTrue(pad.isGraduated(token), "the run sold the curve out");
        assertLt(spent, offered, "and took only what the last tokens cost");
        assertGt(spent, 19e6);
        assertEq(burned, left, "it bought and burned the curve's last tokens");
        assertEq(buyback.usdcHeld(token), 1_000e6 - spent);
        assertEq(buyback.lastRunAt(token), START);

        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + 30 minutes);
        (uint112 reserveToken, uint112 reserveUsdc,) = _pairOf(token).getReserves();
        assertEq(reserveToken, POOL_SUPPLY);
        (offered, graduated) = buyback.previewRun(token);
        assertTrue(graduated);
        assertEq(offered, ((uint256(reserveUsdc) * 25) / BPS) / 2, "half an hour: half the pool's cap");
        vm.prank(keeper);
        (uint256 poolSpent,) = buyback.run(token);
        assertEq(poolSpent, offered);
        _assertLedger(token, 1_000e6);
    }
}
