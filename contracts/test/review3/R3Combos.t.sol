// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HolderDistributionPlugin} from "../../plugins/launch/HolderDistributionPlugin.sol";
import {Review3Base, Op, Ledger, R3Attacker} from "./Review3Base.sol";

/// @notice Several plugins on one token, and several tokens, in one transaction.
contract R3CombosTest is Review3Base {
    HolderDistributionPlugin internal holders;

    function setUp() public override {
        super.setUp();
        holders = new HolderDistributionPlugin(address(pad));
    }

    function _comboToken(uint16 c, address[] memory targets, uint16[] memory bps, bytes[] memory datas)
        internal
        returns (address token)
    {
        vm.prank(alice);
        token = pad.createToken(
            "Combo", "CMB", "", c, address(combo), abi.encode(targets, bps, datas), 0, 0, type(uint256).max
        );
        _graduate(token);
    }

    /// @dev A token whose fees a Combo splits 50/50 between Deepen pool (burn share `burnBps`) and the live
    ///      Buyback & burn v1. Both pots topped up directly (anyone may deliver fees to a configured token).
    function _deepenPlusV1(uint16 c, uint16 burnBps, uint256 potEach) internal returns (address token) {
        address[] memory targets = new address[](2);
        uint16[] memory bps = new uint16[](2);
        bytes[] memory datas = new bytes[](2);
        (targets[0], bps[0], datas[0]) = (address(deepen), 5_000, abi.encode(burnBps));
        (targets[1], bps[1], datas[1]) = (address(buyback), 5_000, bytes(""));
        token = _comboToken(c, targets, bps, datas);
        _topUp(token, potEach);
        _topUpBuyback(token, potEach);
        _step(HOUR);
    }

    function _pushFor(address token, uint256 pot, uint16 c) internal view returns (uint256) {
        (, uint256 r) = _reserves(token);
        uint256 root = Math.sqrt(400 * pot * r);
        return (root - r) * 10_000 / (10_000 - 50 - uint256(c)) + 2;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 1. Deepen pool next to the live Buyback & burn v1 in one Combo: v1's H1 pays for the push, Deepen rides along
    // ═════════════════════════════════════════════════════════════════════════

    function test_combo_deepenPlusLiveV1_deepenRidesTheV1Exploit() public {
        address token = _deepenPlusV1(100, 5_000, 200_000e6);
        (uint256 honest,,,) = deepen.previewRun(token);
        atk = _newAttacker();
        uint256 push = _pushFor(token, 200_000e6, 100);

        // A: the v1 exploit alone
        _clear();
        _add(Op.Buy, token, push);
        _add(Op.ParkAll, token, 0);
        _runOp(token, address(buyback));
        _add(Op.Unpark, token, 0);
        _add(Op.SellAll, token, 0);
        (int256 pnlA, Ledger memory lA) = _try();

        // B: the same, with Deepen pool's run added at the pushed price
        _clear();
        _add(Op.Buy, token, push);
        _add(Op.ParkAll, token, 0);
        _runOp(token, address(buyback));
        _runOp(token, address(deepen));
        _add(Op.Unpark, token, 0);
        _add(Op.SellAll, token, 0);
        uint256 snap = vm.snapshotState();
        uint256 deepenHeld0 = deepen.usdcHeld(token);
        int256 pnlB = atk.exec(_prog);
        uint256 deepenSpentB = deepenHeld0 - deepen.usdcHeld(token);
        vm.revertToState(snap);

        // C: Deepen pool alone under the same push and park
        _clear();
        _add(Op.Buy, token, push);
        _add(Op.ParkAll, token, 0);
        _runOp(token, address(deepen));
        _add(Op.Unpark, token, 0);
        _add(Op.SellAll, token, 0);
        (int256 pnlC, Ledger memory lC) = _try();

        emit log_named_uint("Deepen honest offer (untouched pool)          ", honest);
        emit log_named_uint("push                                          ", push);
        emit log_named_uint("A v1 alone: pot spent                         ", lA.potSpent);
        emit log_named_int("A v1 alone: P&L                               ", pnlA);
        emit log_named_uint("B v1 + Deepen: Deepen pot spent               ", deepenSpentB);
        emit log_named_int("B v1 + Deepen: P&L                            ", pnlB);
        emit log_named_int("B - A: what Deepen's run added for the attacker", pnlB - pnlA);
        emit log_named_uint("C Deepen alone, same push/park: pot spent     ", lC.potSpent);
        emit log_named_int("C Deepen alone: P&L                           ", pnlC);
        assertLt(pnlC, 0, "alone, Deepen's run does not pay for the push");
        assertGt(pnlB - pnlA, int256(deepenSpentB * 9 / 10), "next to v1, the attacker takes over 90% of Deepen's run");
        assertGt(deepenSpentB, honest * 50, "and that run is over 50 honest caps");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 2. Two paced buyers, NO park (so v1's cap is the untouched pool's, the same as Deepen's): a zero-hold sandwich
    //    of both runs. V13-SPEC §2.3 accepts this pairing with "0.2 h at c = 0" for the default burn share.
    // ═════════════════════════════════════════════════════════════════════════

    function _twoBuyersSandwich(uint16 c, uint16 burnBps) internal returns (int256 best, uint256 bestPush, int256 bestPpm) {
        uint256 snap0 = vm.snapshotState();
        address token = _deepenPlusV1(c, burnBps, 10_000_000e6);
        atk = _newAttacker();
        best = type(int256).min;
        bestPpm = type(int256).min;
        uint256 push = 1e6;
        for (uint256 i; i < 45; ++i) {
            _clear();
            _add(Op.Buy, token, push);
            _runOp(token, address(buyback));
            _runOp(token, address(deepen));
            _add(Op.SellAll, token, 0);
            (int256 pnl,) = _try();
            if (pnl > best) (best, bestPush) = (pnl, push);
            int256 ppm = pnl * 1e6 / int256(push);
            if (ppm > bestPpm) bestPpm = ppm;
            push = push * 13 / 10;
        }
        vm.revertToState(snap0);
    }

    function test_combo_twoPacedBuyers_zeroHoldSandwich() public {
        uint16[3] memory shares = [uint16(10_000), 5_000, 0];
        uint16[3] memory fees = [uint16(0), 50, 100];
        for (uint256 f; f < fees.length; ++f) {
            for (uint256 s; s < shares.length; ++s) {
                (int256 best, uint256 bestPush, int256 bestPpm) = _twoBuyersSandwich(fees[f], shares[s]);
                emit log_string(string.concat(
                    "v1 + Deepen(burnBps=", vm.toString(shares[s]), ") c=", vm.toString(fees[f]),
                    " | best one-tx sandwich P&L=", vm.toString(best), " at push=", vm.toString(bestPush),
                    " | best ppm of push=", vm.toString(bestPpm)
                ));
            }
        }
    }

    /// @dev The same pairing with a short hold: push, run both, wait `hold` seconds (a later block), run both again
    ///      (prorated budgets), sell. How short a hold pays at c = 0?
    function test_combo_twoPacedBuyers_shortHold() public {
        uint16[2] memory shares = [uint16(10_000), 5_000];
        uint256[6] memory holds = [uint256(10), 30, 60, 120, 300, 720];
        for (uint256 s; s < shares.length; ++s) {
            for (uint256 h; h < holds.length; ++h) {
                uint256 snap0 = vm.snapshotState();
                address token = _deepenPlusV1(0, shares[s], 10_000_000e6);
                address trader = makeAddr("holdTrader");
                usdc.mint(trader, 1_000e6);
                vm.startPrank(trader);
                usdc.approve(address(router), type(uint256).max);
                uint256 u0 = usdc.balanceOf(trader);
                uint256 got = router.buy(token, 1_000e6, 0, trader, block.timestamp);
                buyback.run(token);
                deepen.run(token);
                vm.stopPrank();
                _step(holds[h]);
                vm.startPrank(trader);
                buyback.run(token);
                deepen.run(token);
                router.sell(token, got, 0, trader, block.timestamp);
                vm.stopPrank();
                int256 pnl = int256(usdc.balanceOf(trader)) - int256(u0);
                emit log_string(string.concat(
                    "v1 + Deepen(burnBps=", vm.toString(shares[s]), ") c=0, 1,000 USDC, hold ", vm.toString(holds[h]),
                    " s | P&L=", vm.toString(pnl)
                ));
                vm.revertToState(snap0);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 3. Deepen pool next to HolderDistribution: the push's creator fee streams to holders, nothing comes back in-tx
    // ═════════════════════════════════════════════════════════════════════════

    function test_combo_deepenPlusHolders_attackStillLoses() public {
        address[] memory targets = new address[](2);
        uint16[] memory bps = new uint16[](2);
        bytes[] memory datas = new bytes[](2);
        (targets[0], bps[0], datas[0]) = (address(deepen), 5_000, abi.encode(uint16(5_000)));
        (targets[1], bps[1], datas[1]) = (address(holders), 5_000, bytes(""));
        address token = _comboToken(100, targets, bps, datas);
        _topUp(token, 1_000_000e6);
        _step(HOUR);
        atk = _newAttacker();
        int256 best = type(int256).min;
        uint256[6] memory pushes = [uint256(100e6), 1_000e6, 10_000e6, 100_000e6, 1_000_000e6, 5_000_000e6];
        for (uint256 i; i < pushes.length; ++i) {
            for (uint256 k; k < 2; ++k) {
                _pushParkProgram(token, address(deepen), pushes[i], k == 1, true);
                (int256 pnl,) = _try();
                if (pnl > best) best = pnl;
            }
        }
        emit log_named_int("Deepen + HolderDistribution, best P&L", best);
        assertLt(best, 0, "loses");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 4. Two Deepen tokens attacked in ONE transaction with shared capital
    // ═════════════════════════════════════════════════════════════════════════

    function test_twoTokensOneTransaction() public {
        address t1 = _graduatedToken(0, 10_000, 1_000_000e6);
        address t2 = _graduatedToken(0, 5_000, 1_000_000e6);
        _step(HOUR);
        atk = _newAttacker();
        int256 best = type(int256).min;
        uint256[5] memory pushes = [uint256(1_000e6), 25_000e6, 250_000e6, 1_000_000e6, 3_000_000e6];
        for (uint256 i; i < pushes.length; ++i) {
            _clear();
            // Interleaved: both pushes first, both parks, both runs, then unwind both.
            _add(Op.Buy, t1, pushes[i]);
            _add(Op.Buy, t2, pushes[i]);
            _add(Op.ParkAll, t1, 0);
            _add(Op.ParkAll, t2, 0);
            _runOp(t1, address(deepen));
            _runOp(t2, address(deepen));
            _add(Op.Unpark, t1, 0);
            _add(Op.Unpark, t2, 0);
            _add(Op.SellAll, t1, 0);
            _add(Op.SellAll, t2, 0);
            (int256 pnl, Ledger memory l) = _try();
            emit log_string(string.concat(
                "two tokens, push each=", vm.toString(pushes[i]), " pots spent=", vm.toString(l.potSpent),
                " | P&L=", vm.toString(pnl)
            ));
            if (pnl > best) best = pnl;
        }
        assertLt(best, 0, "two independent losing attacks still lose");
    }
}
