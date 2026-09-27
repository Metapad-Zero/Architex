// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILaunchPair} from "../../../interfaces/ILaunchPair.sol";
import {IDeepenPoolPlugin} from "../../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {DeepenPoolPlugin} from "../../../plugins/launch/DeepenPoolPlugin.sol";
import {BuybackBurnPlugin} from "../../../plugins/launch/BuybackBurnPlugin.sol";
import {ComboPlugin} from "../../../plugins/launch/ComboPlugin.sol";
import {LaunchpadV13Base} from "../../launchpad/LaunchpadV13Base.sol";

/// @notice Front-running Deepen pool on the real v1.3 launchpad, curve, launch pool and router (V13-SPEC §2.3). A
///         trader buys, the runs happen, the trader sells. The exact numbers come from the exact-integer model of the
///         curve and pool the documented hold times were computed with, so these tests also pin the contracts to it.
///
///         In the pool every token a run buys goes back into the pool with the add, so the pool's token reserve ends
///         where it was: a run raises the USDC reserve and nothing else. The round trip's result is therefore the same
///         share of the position at every size, and the bound is the time it takes the runs to lift the price by the
///         2 * (0.5% + c) the round trip costs.
contract DeepenPoolFrontRunTest is LaunchpadV13Base {
    uint256 internal constant HOUR = 3600;
    uint256 internal constant START = 1_700_000_000;
    uint256 internal constant PLENTY = 1_000_000e6;

    DeepenPoolPlugin internal deepen;
    BuybackBurnPlugin internal buyback;
    ComboPlugin internal combo;
    address internal keeper = makeAddr("keeper");
    address internal funder = makeAddr("funder");

    function setUp() public override {
        super.setUp();
        deepen = new DeepenPoolPlugin(address(pad));
        buyback = new BuybackBurnPlugin(address(pad));
        combo = new ComboPlugin(address(pad));
        vm.warp(START);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _fund(address plugin, address token, uint256 amount) internal {
        if (amount == 0) return;
        usdc.mint(funder, amount);
        vm.startPrank(funder);
        usdc.approve(plugin, amount);
        IDeepenPoolPlugin(plugin).onFees(token, amount);
        vm.stopPrank();
    }

    /// @dev A token whose creator fees go to Deepen pool with burn share `burnBps`, `pre` USDC already bought on its
    ///      curve by carol, `waiting` USDC in the plugin for it (delivered straight to onFees, which anyone may do).
    function _setUpToken(uint16 c, uint16 burnBps, uint256 pre, uint256 waiting) internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken(
            "Deepen", "DPN", "", c, address(deepen), abi.encode(burnBps), 0, 0, type(uint256).max
        );
        if (pre != 0) {
            vm.prank(carol);
            pad.buy(token, pre, 0, carol, type(uint256).max);
        }
        _fund(address(deepen), token, waiting);
    }

    /// @dev A token whose creator fees a Combo splits between Deepen pool and Buyback & burn, both pots filled to
    ///      `waiting` (the worst case: a Combo would split the same fees between them).
    function _setUpComboToken(uint16 c, uint256 waiting) internal returns (address token) {
        address[] memory targets = new address[](2);
        (targets[0], targets[1]) = (address(deepen), address(buyback));
        uint16[] memory bps = new uint16[](2);
        (bps[0], bps[1]) = (5000, 5000);
        bytes[] memory datas = new bytes[](2); // both entries take their defaults
        vm.prank(alice);
        token = pad.createToken(
            "Combo", "CMB", "", c, address(combo), abi.encode(targets, bps, datas), 0, 0, type(uint256).max
        );
        _fund(address(deepen), token, waiting);
        _fund(address(buyback), token, waiting);
    }

    /// @dev A keeper runs the plugin if it has a budget. In the pool a run spends its offer but for the split's
    ///      rounding (at most 4 units), on the curve exactly (less only on the sell-out buy).
    function _run(address token) internal returns (uint256 spent) {
        (uint256 offered,,,) = deepen.previewRun(token);
        if (offered == 0) return 0;
        vm.prank(keeper);
        (spent,,) = deepen.run(token);
        assertLe(spent, offered, "a run never spends more than previewRun offered");
        if (pad.isGraduated(token)) assertLe(offered - spent, 4, "and at most rounding stays behind");
    }

    function _runBuyback(address token) internal {
        (uint256 offered,) = buyback.previewRun(token);
        if (offered == 0) return;
        vm.prank(keeper);
        buyback.run(token);
    }

    /// @dev Runs once now (a full cap: the token never ran), then once after each gap, each in a new block.
    function _runs(address token, uint256[] memory gaps, bool withBuyback) internal {
        _run(token);
        if (withBuyback) _runBuyback(token);
        for (uint256 i; i < gaps.length; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.warp(vm.getBlockTimestamp() + gaps[i]);
            _run(token);
            if (withBuyback) _runBuyback(token);
        }
    }

    /// @dev mallory buys `size` in the launch pool, holds through the runs, and sells everything she bought.
    function _attackInPool(address token, uint256 size, uint256[] memory gaps) internal returns (int256 pnl) {
        return _attackInPool(token, size, gaps, false);
    }

    function _attackInPool(address token, uint256 size, uint256[] memory gaps, bool withBuyback)
        internal
        returns (int256 pnl)
    {
        uint256 before = usdc.balanceOf(mallory);
        vm.prank(mallory);
        uint256 got = router.buy(token, size, 0, mallory, vm.getBlockTimestamp());
        _runs(token, gaps, withBuyback);
        vm.prank(mallory);
        router.sell(token, got, 0, mallory, vm.getBlockTimestamp());
        pnl = int256(usdc.balanceOf(mallory)) - int256(before);
    }

    /// @dev The same on the curve, where a run is Buyback & burn's.
    function _attackOnCurve(address token, uint256 size, uint256[] memory gaps, bool withBuyback)
        internal
        returns (int256 pnl)
    {
        uint256 before = usdc.balanceOf(mallory);
        vm.prank(mallory);
        (uint256 got,) = pad.buy(token, size, 0, mallory, type(uint256).max);
        _runs(token, gaps, withBuyback);
        assertFalse(pad.isGraduated(token), "still on the curve");
        vm.prank(mallory);
        pad.sell(token, got, 0, mallory, type(uint256).max);
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

    /// @dev 90% of the documented pool bound: 2 * (0.5% + c) / (0.25% * lift) - 1 hours, where `lift` counts how fast
    ///      the runs raise the price in units of 0.25% per cap: 1e4 + burnBps for one Deepen pool (burning lifts twice
    ///      as fast per USDC as deepening), plus another 2e4 if Buyback & burn is paced alongside it.
    function _underTheBound(uint256 c, uint256 liftUnits) internal pure returns (uint256) {
        uint256 num = 2 * (50 + c) * 10_000 * 3600;
        uint256 den = 25 * liftUnits;
        if (num <= den * 3600) return 0;
        return ((num - den * 3600) * 9) / (den * 10);
    }

    function _underThePoolBound(uint256 c, uint256 burnBps) internal pure returns (uint256) {
        return _underTheBound(c, 10_000 + burnBps);
    }

    /// @dev 90% of the documented curve bound, Buyback & burn's ((0.5% + c) / 0.25% - 1) hours.
    function _underTheCurveBound(uint256 c) internal pure returns (uint256) {
        return ((25 + c) * 144 * 9) / 10;
    }

    /// @dev The plugin's ledger and the launchpad's books after an attack.
    function _assertLedger(address token, uint256 delivered) internal view {
        assertEq(deepen.usdcHeld(token) + deepen.totalUsdcSpent(token), delivered, "held + spent == delivered");
        assertEq(usdc.balanceOf(address(deepen)), deepen.usdcHeld(token));
        assertEq(IERC20(token).balanceOf(address(deepen)), 0, "no token kept");
        assertEq(ILaunchPair(pad.pairOf(token)).balanceOf(address(deepen)), 0, "no LP kept");
        assertEq(
            ILaunchPair(pad.pairOf(token)).balanceOf(DEAD),
            ILaunchPair(pad.pairOf(token)).totalSupply(),
            "every LP token is locked at the burn address"
        );
        _assertSolvent();
    }

    // ─── Sandwiching one run ──────────────────────────────────────────────────

    /// @dev Front-run one full-cap run with a buy of any size, back-run it with the sell: always a loss, at every
    ///      creator fee, every size and every burn share, because a full cap lifts the price by at most about 0.5%
    ///      (all of it burning) while the round trip costs 2 * (0.5% + c).
    function test_sandwichingOneRunLoses_everySizeFeeAndBurnShare() public {
        uint16[6] memory fees = [uint16(0), 50, 100, 200, 500, 1000];
        uint256[5] memory sizes = [uint256(1), 100, 2_000, 20_000, 200_000];
        uint16[3] memory burns = [uint16(0), 5_000, 10_000];
        for (uint256 i; i < fees.length; ++i) {
            for (uint256 j; j < sizes.length; ++j) {
                uint256 snap = vm.snapshotState();
                address token = _setUpToken(fees[i], burns[j % 3], 0, PLENTY);
                _graduate(token);
                int256 pnl = _attackInPool(token, sizes[j] * 1e6, _gaps(0, 0));
                assertLt(pnl, 0, "sandwiching one run loses");
                _assertLedger(token, PLENTY);
                vm.revertToState(snap);
            }
        }
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_sandwichingOneRunLoses_inPool(uint64 sizeRaw, uint16 feeRaw, uint16 burnRaw) public {
        uint16 c = uint16(bound(feeRaw, 0, 1000));
        uint16 burnBps = uint16(bound(burnRaw, 0, 10_000));
        uint256 size = bound(sizeRaw, 1e6, 500_000e6);
        address token = _setUpToken(c, burnBps, 0, PLENTY);
        _graduate(token);
        int256 pnl = _attackInPool(token, size, _gaps(0, 0));
        assertLt(pnl, 0, "sandwiching one run loses money");
        _assertLedger(token, PLENTY);
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_sandwichingOneRunLoses_onCurve(uint64 sizeRaw, uint16 feeRaw) public {
        uint16 c = uint16(bound(feeRaw, 0, 1000));
        uint256 size = bound(sizeRaw, 1e6, 15_000e6);
        address token = _setUpToken(c, 5_000, 2_000e6, PLENTY);
        int256 pnl = _attackOnCurve(token, size, _gaps(0, 0), false);
        assertLt(pnl, 0, "sandwiching one run loses money");
        _assertLedger(token, PLENTY);
    }

    // ─── Chaining runs block after block ──────────────────────────────────────

    /// @dev Buy, run in each of the next 50 blocks (a second apart, the most whole-second timestamps allow), sell, at
    ///      the default half-and-half burn share. Every combination loses, by exactly what the exact-integer model
    ///      says.
    function test_chainAttack_fiftyBlocksLosesAtEveryCreatorFee() public {
        uint16[6] memory fees = [uint16(0), 50, 100, 200, 500, 1000];
        uint256[3] memory sizes = [uint256(2_000e6), 8_000e6, 20_000e6];
        int256[3][6] memory model = [
            [int256(-12_633_350), -52_214_307, -135_585_441],
            [int256(-32_586_079), -131_994_281, -334_951_664],
            [int256(-52_437_890), -211_370_975, -533_310_600],
            [int256(-91_838_743), -368_914_542, -927_006_643],
            [int256(-207_619_540), -831_867_590, -2_083_922_358],
            [int256(-392_516_676), -1_571_202_578, -3_931_551_643]
        ];
        for (uint256 i; i < fees.length; ++i) {
            for (uint256 j; j < sizes.length; ++j) {
                uint256 snap = vm.snapshotState();
                address token = _setUpToken(fees[i], 5_000, 0, PLENTY);
                _graduate(token);
                int256 pnl = _attackInPool(token, sizes[j], _gaps(49, 1));
                assertLt(pnl, 0, "the chain attack loses");
                assertEq(pnl, model[i][j], "the exact-integer model");
                _assertLedger(token, PLENTY);
                vm.revertToState(snap);
            }
        }
    }

    // ─── The documented bound ─────────────────────────────────────────────────

    /// @dev Buy S in the pool, k runs spread over a hold of T, sell: never a profit while T stays under the documented
    ///      bound for the token's creator fee and burn share (with a 10% margin), whatever the fee, the share, the
    ///      size and the number of runs. The pot never limits a run (the worst case).
    function testFuzz_holdUnderTheBoundNeverProfits_pool(
        uint16 feeRaw,
        uint16 burnRaw,
        uint64 sizeRaw,
        uint8 runsRaw,
        uint32 holdRaw
    ) public {
        uint16 c = uint16(bound(feeRaw, 0, 1000));
        uint16 burnBps = uint16(bound(burnRaw, 0, 10_000));
        uint256 size = bound(sizeRaw, 1e6, 50_000e6);
        uint256 k = bound(runsRaw, 1, 48);
        uint256 hold = bound(holdRaw, 0, _underThePoolBound(c, burnBps));
        address token = _setUpToken(c, burnBps, 0, PLENTY);
        _graduate(token);

        int256 pnl = _attackInPool(token, size, _spread(hold, k));
        assertEq(vm.getBlockTimestamp(), START + hold, "held for T");
        assertLe(pnl, 0, "no profit under the bound");
        _assertLedger(token, PLENTY);
    }

    /// @dev On the curve a run is Buyback & burn's whatever the burn share, so its bound is Buyback & burn's too.
    function testFuzz_holdUnderTheBoundNeverProfits_curve(
        uint16 feeRaw,
        uint16 burnRaw,
        uint64 preRaw,
        uint64 sizeRaw,
        uint8 runsRaw,
        uint32 holdRaw
    ) public {
        uint16 c = uint16(bound(feeRaw, 0, 1000));
        uint16 burnBps = uint16(bound(burnRaw, 0, 10_000));
        uint256 pre = preRaw % 4 == 0 ? 0 : bound(preRaw, 1e6, 8_000e6);
        uint256 size = bound(sizeRaw, 1e6, 12_000e6);
        uint256 k = bound(runsRaw, 1, 48);
        uint256 hold = bound(holdRaw, 0, _underTheCurveBound(c));
        address token = _setUpToken(c, burnBps, pre, PLENTY);

        int256 pnl = _attackOnCurve(token, size, _spread(hold, k), false);
        assertEq(vm.getBlockTimestamp(), START + hold, "held for T");
        assertLe(pnl, 0, "no profit under the bound");
        _assertLedger(token, PLENTY);
    }

    /// @dev So the losses above are not vacuous: past the bound a trader profits, like any holder of a token whose
    ///      fees buy it back and deepen its pool. At the default burn share and a 1% creator fee the shortest
    ///      profitable hold is 7.2 h; holding 12 h with a run every 10 minutes makes +33.73 USDC on 2,000, and 6 h
    ///      still loses 9.87.
    function test_holdingPastTheBoundProfits_pool() public {
        uint256 snap = vm.snapshotState();
        address token = _setUpToken(100, 5_000, 0, PLENTY);
        _graduate(token);
        assertEq(_attackInPool(token, 2_000e6, _gaps(36, 600)), -9_866_538, "6 h: the exact-integer model");
        vm.revertToState(snap);

        token = _setUpToken(100, 5_000, 0, PLENTY);
        _graduate(token);
        int256 pnl = _attackInPool(token, 2_000e6, _gaps(72, 600));
        assertEq(pnl, 33_727_796, "12 h: the exact-integer model");
        assertGt(pnl, 0);
        _assertLedger(token, PLENTY);
    }

    /// @dev With no burn share the runs give back every token they buy, so the pool's token reserve never moves and
    ///      the round trip returns the same share of the position at any size. A burn share takes tokens out of the
    ///      pool, which makes the pool shallower and bigger positions worse off, never better.
    function test_howTheResultScalesWithSize() public {
        uint256[4] memory sizes = [uint256(10e6), 1_000e6, 20_000e6, 200_000e6];
        int256 firstBps;
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            address token = _setUpToken(100, 0, 0, PLENTY);
            _graduate(token);
            int256 bps = (_attackInPool(token, sizes[i], _gaps(12, 600)) * 10_000) / int256(sizes[i]);
            if (i == 0) firstBps = bps;
            else assertApproxEqAbs(bps, firstBps, 1, "pure deepening: the same loss in basis points at any size");
            vm.revertToState(snap);
        }
        int256 previous;
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            address token = _setUpToken(100, 10_000, 0, PLENTY);
            _graduate(token);
            int256 bps = (_attackInPool(token, sizes[i], _gaps(12, 600)) * 10_000) / int256(sizes[i]);
            if (i != 0) assertLe(bps, previous, "with a burn share, bigger positions do no better");
            previous = bps;
            vm.revertToState(snap);
        }
    }

    // ─── Two paced plugins on one token ───────────────────────────────────────

    /// @dev What the burn share replaces. A Combo holding both Deepen pool and Buyback & burn paces each separately,
    ///      so the token's price is lifted about twice as fast and the bound roughly halves: at a 1% creator fee a
    ///      four-hour hold, which loses against Deepen pool alone (its curve bound is 5.1 h), profits when
    ///      Buyback & burn runs alongside it. Both pots are full here, which is the worst case; a Combo splits the
    ///      same fees between them.
    function test_twoPacedPluginsHalveTheBound_curve() public {
        uint256 snap = vm.snapshotState();
        address token = _setUpToken(100, 5_000, 0, PLENTY);
        int256 alone = _attackOnCurve(token, 2_000e6, _spread(4 hours, 24), false);
        assertLt(alone, 0, "Deepen pool alone: the curve bound is 5.1 h, so four hours still loses");
        vm.revertToState(snap);

        token = _setUpComboToken(100, PLENTY);
        int256 together = _attackOnCurve(token, 2_000e6, _spread(4 hours, 24), true);
        assertGt(together, 0, "with Buyback & burn running too, the same hold profits");
        assertGt(together, alone);
    }

    /// @dev In the pool, the same: two paced plugins lift the price by (1 + burnBps / 1e4) + 2 units of 0.25% per
    ///      hour instead of (1 + burnBps / 1e4), so the combined bound is that much shorter. Under 90% of it a hold
    ///      still loses, at every creator fee.
    function testFuzz_twoPacedPluginsStillLoseUnderTheCombinedBound(uint16 feeRaw, uint64 sizeRaw, uint32 holdRaw)
        public
    {
        uint16 c = uint16(bound(feeRaw, 0, 1000));
        uint256 size = bound(sizeRaw, 1e6, 50_000e6);
        // The Combo's Deepen entry takes the default burn share, so the lift is (1e4 + 5e3) + 2e4 units.
        uint256 hold = bound(holdRaw, 0, _underTheBound(c, 35_000));
        address token = _setUpComboToken(c, PLENTY);
        _graduate(token);

        int256 pnl = _attackInPool(token, size, _spread(hold == 0 ? 1 : hold, 8), true);
        assertLe(pnl, 0, "no profit under the combined bound");
        _assertLedger(token, PLENTY);
    }

    /// @dev And the point of the burn share: one plugin doing both jobs under one budget is strictly better protected
    ///      than the two paced separately. At a 1% creator fee, a three-hour hold that profits against the pairing
    ///      still loses against a single Deepen pool at the same mix.
    function test_oneBudgetBeatsTwoPacedPlugins() public {
        uint256 snap = vm.snapshotState();
        address paired = _setUpComboToken(100, PLENTY);
        _graduate(paired);
        int256 together = _attackInPool(paired, 2_000e6, _spread(3 hours, 18), true);
        assertGt(together, 0, "two paced plugins: three hours already pays");
        vm.revertToState(snap);

        address single = _setUpToken(100, 5_000, 0, PLENTY);
        _graduate(single);
        int256 alone = _attackInPool(single, 2_000e6, _spread(3 hours, 18));
        assertLt(alone, 0, "one plugin, one budget: the same hold still loses");
    }
}
