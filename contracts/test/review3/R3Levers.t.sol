// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {Review3Base, Op, Ledger, R3Attacker} from "./Review3Base.sol";

/// @notice Every way I could find to move the locked part, reserve * LP(0x…dEaD) / LP supply, inside one transaction,
///         and whether any of them pays. Two attackers:
///         - a USDC-only attacker (flash liquidity), P&L measured from zero;
///         - a WHALE holding the curve's 800M tokens (four times the pool), which can recover USDC it puts into the
///           pool by dumping its bag afterwards. Its baseline is the best honest thing it can do: trigger the run, then
///           dump (a holder's legitimate share of a buyback). A manipulation is only worth anything if it beats that.
contract R3LeversTest is Review3Base {
    address internal token;
    address internal pair;

    function _setUpToken(uint16 c, uint16 burnBps) internal {
        token = _graduatedToken(c, burnBps, 0);
        pair = pad.pairOf(token);
        _topUp(token, 10_000_000e6);
        _step(HOUR);
    }

    function _whale() internal {
        atk = _newAttacker();
        vm.prank(bob);
        IERC20(token).transfer(address(atk), 800_000_000e18);
    }

    function _baselineW1() internal returns (int256 pnl) {
        _clear();
        _runOp(token, address(deepen));
        _add(Op.SellAll, token, 0);
        (pnl,) = _try();
    }

    function _baselineW0() internal returns (int256 pnl) {
        _clear();
        _add(Op.SellAll, token, 0);
        (pnl,) = _try();
    }

    function _report(string memory label, uint256 size, int256 pnl, int256 base) internal {
        emit log_string(string.concat(
            label, " size=", vm.toString(size), " | P&L=", vm.toString(pnl), " | vs honest run+dump=",
            vm.toString(pnl - base)
        ));
    }

    /// @dev Runs the current program; reports it and returns the better edge, or skips it if it cannot execute.
    function _whaleOne(string memory label, uint256 size, int256 w1, int256 bestEdge) internal returns (int256) {
        (bool ok, int256 pnl,) = _tryOk();
        if (!ok) {
            emit log_string(string.concat(label, " size=", vm.toString(size), " | not executable (bag too small)"));
            return bestEdge;
        }
        _report(label, size, pnl, w1);
        return pnl - w1 > bestEdge ? pnl - w1 : bestEdge;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // The whale: every lever that puts USDC into the pool and takes it back by dumping the bag
    // ═════════════════════════════════════════════════════════════════════════

    function _whaleLevers(uint16 c, uint16 burnBps) internal {
        _setUpToken(c, burnBps);
        _whale();
        int256 w0 = _baselineW0();
        int256 w1 = _baselineW1();
        emit log_string(string.concat("WHALE c=", vm.toString(c), " burnBps=", vm.toString(burnBps)));
        emit log_named_int("  dump alone (W0)                      ", w0);
        emit log_named_int("  honest run, then dump (W1)           ", w1);
        emit log_named_int("  what the honest run gave the whale   ", w1 - w0);
        int256 bestEdge = type(int256).min;
        uint256[4] memory sizes = [uint256(1_000e6), 25_000e6, 250_000e6, 2_500_000e6];
        for (uint256 i; i < sizes.length; ++i) {
            // M1: push, park the whole bag, run, unpark, dump
            _clear();
            _add(Op.Buy, token, sizes[i]);
            _add(Op.ParkAll, token, 0);
            _runOp(token, address(deepen));
            _add(Op.Unpark, token, 0);
            _add(Op.SellAll, token, 0);
            bestEdge = _whaleOne("  M1 push+park+run+unpark+dump", sizes[i], w1, bestEdge);
            // M3: liquidity minted straight to 0x…dEaD at the current price (a permanent gift), run, dump
            _clear();
            _add(Op.MintToDeadUsdc, token, sizes[i]);
            _runOp(token, address(deepen));
            _add(Op.SellAll, token, 0);
            bestEdge = _whaleOne("  M3 mint-to-dEaD+run+dump", sizes[i], w1, bestEdge);
            // M4: donate USDC and sync, run, dump
            _clear();
            _add(Op.DonateUsdc, token, sizes[i]);
            _add(Op.Sync, token, 0);
            _runOp(token, address(deepen));
            _add(Op.SellAll, token, 0);
            bestEdge = _whaleOne("  M4 donate+sync+run+dump", sizes[i], w1, bestEdge);
            // M5: donate USDC, no sync (the run's own sync folds it in after the budget is read), run, dump
            _clear();
            _add(Op.DonateUsdc, token, sizes[i]);
            _runOp(token, address(deepen));
            _add(Op.SellAll, token, 0);
            bestEdge = _whaleOne("  M5 donate(unsynced)+run+dump", sizes[i], w1, bestEdge);
            // M6: park the bag (whale = 80% LP), donate and sync, run, unpark, dump
            _clear();
            _add(Op.ParkAll, token, 0);
            _add(Op.DonateUsdc, token, sizes[i]);
            _add(Op.Sync, token, 0);
            _runOp(token, address(deepen));
            _add(Op.Unpark, token, 0);
            _add(Op.SellAll, token, 0);
            bestEdge = _whaleOne("  M6 park+donate+sync+run+unpark+dump", sizes[i], w1, bestEdge);
            // M7: park 99% of the bag (99,000 USDC side), an unbalanced (USDC-heavy) mint, run, unpark, dump
            _clear();
            _add(Op.ParkUsdc, token, 99_000e6);
            _add(Op.MintRaw, token, sizes[i], 1e18);
            _runOp(token, address(deepen));
            _add(Op.Unpark, token, 0);
            _add(Op.SellAll, token, 0);
            bestEdge = _whaleOne("  M7 park+unbalanced mint+run+unpark+dump", sizes[i], w1, bestEdge);
        }
        // M2: push, then gift part of the bag as liquidity to 0x…dEaD AT THE PUSHED PRICE (raising the locked part),
        //     run, dump: the dump takes the gift's USDC back out of dEaD's share as the price falls.
        uint256[3] memory pushes = [uint256(25_000e6), 250_000e6, 1_410_000e6];
        uint256[3] memory gifts = [uint256(50_000_000e18), 200_000_000e18, 400_000_000e18];
        for (uint256 i; i < pushes.length; ++i) {
            for (uint256 j; j < gifts.length; ++j) {
                _clear();
                _add(Op.Buy, token, pushes[i]);
                _add(Op.MintToDeadTokens, token, gifts[j]);
                _runOp(token, address(deepen));
                _add(Op.SellAll, token, 0);
                (bool ok, int256 pnl, Ledger memory l) = _tryOk();
                if (!ok) continue;
                emit log_string(string.concat(
                    "  M2 push=", vm.toString(pushes[i]), " gift tokens=", vm.toString(gifts[j] / 1e18),
                    " (USDC side ", vm.toString(l.gifted), ") pot spent=", vm.toString(l.potSpent),
                    " | vs honest run+dump=", vm.toString(pnl - w1)
                ));
                if (pnl - w1 > bestEdge) bestEdge = pnl - w1;
            }
        }
        emit log_named_int("  BEST edge of any manipulation over the honest run+dump", bestEdge);
        assertLt(bestEdge, 0, "no lever beats triggering the run honestly and dumping");
    }

    function test_whale_c0_pureBurn() public {
        _whaleLevers(0, 10_000);
    }

    function test_whale_c0_default() public {
        _whaleLevers(0, 5_000);
    }

    function test_whale_c0_pureDeepen() public {
        _whaleLevers(0, 0);
    }

    function test_whale_c1pct_default() public {
        _whaleLevers(100, 5_000);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // USDC-only attacker: LP gifts and donations layered on push + park
    // ═════════════════════════════════════════════════════════════════════════

    function test_usdcOnly_giftAndDonateOnTopOfPushPark() public {
        _setUpToken(0, 10_000);
        atk = _newAttacker();
        int256 best = type(int256).min;
        uint256[4] memory pushes = [uint256(5_000e6), 50_000e6, 500_000e6, 1_410_000e6];
        uint256[4] memory giftBps = [uint256(10), 100, 1_000, 5_000];
        for (uint256 i; i < pushes.length; ++i) {
            for (uint256 j; j < giftBps.length; ++j) {
                // U1: push, park, give a slice of the parked LP to 0x…dEaD (raising the locked part), run, unpark, sell
                _clear();
                _add(Op.Buy, token, pushes[i]);
                _add(Op.ParkAll, token, 0);
                _add(Op.GiftLpBps, token, giftBps[j]);
                _runOp(token, address(deepen));
                _add(Op.Unpark, token, 0);
                _add(Op.SellAll, token, 0);
                (int256 pnl, Ledger memory l) = _try();
                emit log_string(string.concat(
                    "U1 push=", vm.toString(pushes[i]), " gift bps of parked LP=", vm.toString(giftBps[j]),
                    " pot spent=", vm.toString(l.potSpent), " | P&L=", vm.toString(pnl)
                ));
                if (pnl > best) best = pnl;
            }
            // U2: push, park, donate 10x the pushed amount and sync (the attacker gets most of it back as the big LP), run
            _clear();
            _add(Op.Buy, token, pushes[i]);
            _add(Op.ParkAll, token, 0);
            _add(Op.DonateUsdc, token, pushes[i] * 10);
            _add(Op.Sync, token, 0);
            _runOp(token, address(deepen));
            _add(Op.Unpark, token, 0);
            _add(Op.SellAll, token, 0);
            (int256 pnl2, Ledger memory l2) = _try();
            emit log_string(string.concat(
                "U2 push=", vm.toString(pushes[i]), " park+donate 10x+sync, pot spent=", vm.toString(l2.potSpent),
                " | P&L=", vm.toString(pnl2)
            ));
            if (pnl2 > best) best = pnl2;
            // U3: push, donate the same again unsynced (the run's own sync folds it in after the budget), run, sell
            _clear();
            _add(Op.Buy, token, pushes[i]);
            _add(Op.DonateUsdc, token, pushes[i]);
            _runOp(token, address(deepen));
            _add(Op.SellAll, token, 0);
            (int256 pnl3, Ledger memory l3) = _try();
            emit log_string(string.concat(
                "U3 push=", vm.toString(pushes[i]), " + unsynced donation, pot spent=", vm.toString(l3.potSpent),
                " | P&L=", vm.toString(pnl3)
            ));
            if (pnl3 > best) best = pnl3;
        }
        emit log_named_int("best USDC-only P&L", best);
        assertLt(best, 0, "no combination pays");
    }

    /// @dev LaunchPair.burn and mint round in the pool's favour. Grinding mint/burn cycles to push the locked part up
    ///      by rounding: the dust it adds is less than the dust it costs, and 0.25% of it is what the cap gains.
    function test_usdcOnly_lpRoundingGrind() public {
        _setUpToken(0, 10_000);
        atk = _newAttacker();
        vm.prank(bob);
        IERC20(token).transfer(address(atk), 100_000_000e18);
        uint256 lockedBefore = _lockedPart(token);
        _clear();
        for (uint256 i; i < 40; ++i) {
            // About 1 USDC and 8,000 tokens (the pool's ratio), a little off it each time.
            _add(Op.MintRaw, token, 1_000_003 + i * 7, 8_000e18 + i * 13e15);
            _add(Op.Unpark, token, 0);
        }
        uint256 snap = vm.snapshotState();
        int256 pnl = atk.exec(_prog);
        uint256 lockedAfter = _lockedPart(token);
        vm.revertToState(snap);
        emit log_named_uint("locked part before (units)", lockedBefore);
        emit log_named_uint("locked part after 40 cycles", lockedAfter);
        emit log_named_int("attacker's USDC P&L        ", pnl);
        assertLe(int256(lockedAfter - lockedBefore), -pnl, "the locked part gains no more than the attacker loses");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Doc check: "A large LP ... loses about n^2 / R against holding for a run of n into a USDC side of R"
    // ═════════════════════════════════════════════════════════════════════════

    function test_docCheck_largeLpLossPerRun() public {
        _setUpToken(0, 10_000);
        vm.prank(bob);
        IERC20(token).transfer(lp, 600_000_000e18);
        (, uint256 r0) = _reserves(token);
        uint256 minted = _addLiquidity(token, lp, r0 * 3); // lp owns 3/4 of the pool
        (uint256 tA, uint256 uA) = _reserves(token);
        uint256 supply = _lpSupply(token);
        uint256 lpTokens = tA * minted / supply;
        uint256 lpUsdc = uA * minted / supply;
        vm.prank(keeper);
        deepen.run(token);
        (uint256 tB, uint256 uB) = _reserves(token);
        uint256 n = uB - uA; // net USDC the run put into the pool
        (uint256 outT, uint256 outU) = _removeLiquidity(token, lp);
        // Value both at the post-run price (USDC per token = uB / tB).
        uint256 heldValue = lpUsdc + lpTokens * uB / tB;
        uint256 lpValue = outU + outT * uB / tB;
        uint256 predicted = n * n * minted / supply / uA;
        emit log_named_uint("run's net USDC into the pool (n)", n);
        emit log_named_uint("pool USDC side before (R)       ", uA);
        emit log_named_uint("LP value vs holding, lost        ", heldValue - lpValue);
        emit log_named_uint("share * n^2 / R                  ", predicted);
    }
}
