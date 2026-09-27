// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IDeepenPoolPlugin} from "../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {Review3Base, Op, Ledger, R3Attacker} from "./Review3Base.sol";

/// @notice Exact-integer sweep of the one-transaction push / [park] / run / [unpark] / sell attack against the FIXED
///         Deepen pool, over pool shape x creator fee x burn share x push size x park. The pot never binds (100M USDC)
///         and the run gets a full cap, the attacker's best case. Every cell must lose; the log shows how close each
///         cell gets (best absolute P&L, and best P&L per USDC pushed, in parts per million).
contract R3SweepTest is Review3Base {
    struct Cell {
        int256 best;
        uint256 bestPush;
        bool bestPark;
        int256 bestPpm;
        uint256 bestPpmPush;
        bool bestPpmPark;
        uint256 tried;
        uint256 skipped;
    }

    function _pushes() internal pure returns (uint256[13] memory p) {
        p = [
            uint256(1e6),
            5e6,
            20e6,
            100e6,
            500e6,
            2_000e6,
            6_000e6,
            15_000e6,
            40_000e6,
            100_000e6,
            400_000e6,
            2_000_000e6,
            10_000_000e6
        ];
    }

    function _cell(Pool p, uint16 c, uint16 burnBps) internal returns (Cell memory cell) {
        uint256 snap0 = vm.snapshotState();
        address token = _graduatedToken(c, burnBps, 0);
        _shape(token, p);
        _topUp(token, 100_000_000e6);
        _step(HOUR);
        atk = _newAttacker();
        cell.best = type(int256).min;
        cell.bestPpm = type(int256).min;
        uint256[13] memory pushes = _pushes();
        for (uint256 i; i < pushes.length; ++i) {
            for (uint256 k; k < 2; ++k) {
                bool park = k == 1;
                _pushParkProgram(token, address(deepen), pushes[i], park, false);
                uint256 snap = vm.snapshotState();
                try atk.exec(_prog) returns (int256 pnl) {
                    ++cell.tried;
                    assertTrue(atk.flat(token), "attacker ends flat");
                    if (pnl > cell.best) (cell.best, cell.bestPush, cell.bestPark) = (pnl, pushes[i], park);
                    int256 ppm = pnl * 1e6 / int256(pushes[i]);
                    if (ppm > cell.bestPpm) (cell.bestPpm, cell.bestPpmPush, cell.bestPpmPark) = (ppm, pushes[i], park);
                } catch {
                    ++cell.skipped; // a park beyond the attacker's 10 billion USDC
                }
                vm.revertToState(snap);
            }
        }
        vm.revertToState(snap0);
    }

    function _sweepPool(Pool p) internal {
        uint16[4] memory fees = [uint16(0), 50, 100, 1_000];
        uint16[3] memory shares = [uint16(0), 5_000, 10_000];
        int256 worstCase = type(int256).min;
        int256 worstPpm = type(int256).min;
        for (uint256 f; f < fees.length; ++f) {
            for (uint256 s; s < shares.length; ++s) {
                Cell memory cell = _cell(p, fees[f], shares[s]);
                emit log_string(string.concat(
                    "pool=", _poolName(p), " c=", vm.toString(fees[f]), " burnBps=", vm.toString(shares[s]),
                    " | best P&L=", vm.toString(cell.best), " at push=", vm.toString(cell.bestPush),
                    cell.bestPark ? " park" : " nopark",
                    " | best ppm=", vm.toString(cell.bestPpm), " at push=", vm.toString(cell.bestPpmPush),
                    cell.bestPpmPark ? " park" : " nopark",
                    " | tried=", vm.toString(cell.tried), " skipped=", vm.toString(cell.skipped)
                ));
                assertLt(cell.best, 0, "no cell pays");
                if (cell.best > worstCase) worstCase = cell.best;
                if (cell.bestPpm > worstPpm) worstPpm = cell.bestPpm;
            }
        }
        emit log_named_int("closest to break-even, absolute (units)", worstCase);
        emit log_named_int("closest to break-even, P&L per USDC pushed (ppm)", worstPpm);
    }

    function test_sweep_freshPool() public {
        _sweepPool(Pool.Fresh);
    }

    function test_sweep_shrunkPool() public {
        _sweepPool(Pool.Shrunk);
    }

    function test_sweep_grownPool() public {
        _sweepPool(Pool.Grown);
    }

    function test_sweep_crowdedPool() public {
        _sweepPool(Pool.Crowded);
    }

    /// @dev The thinnest margin: c = 0, pure burn, a shrunk pool, 60 push sizes from 1 USDC to ~50,000 (geometric),
    ///      park and no park, with and without sweeping pending creator fees first.
    function test_fineSweep_c0_pureBurn_shrunk() public {
        address token = _graduatedToken(0, 10_000, 0);
        _shape(token, Pool.Shrunk);
        _topUp(token, 100_000_000e6);
        _step(HOUR);
        atk = _newAttacker();
        int256 bestPpm = type(int256).min;
        int256 best = type(int256).min;
        uint256 push = 1e6;
        for (uint256 i; i < 60; ++i) {
            for (uint256 k; k < 2; ++k) {
                _pushParkProgram(token, address(deepen), push, k == 1, false);
                (int256 pnl,) = _try();
                assertLt(pnl, 0, "never pays");
                int256 ppm = pnl * 1e6 / int256(push);
                if (ppm > bestPpm) bestPpm = ppm;
                if (pnl > best) best = pnl;
            }
            push = push * 6 / 5;
        }
        emit log_named_int("c=0 pure burn shrunk: best P&L (units)", best);
        emit log_named_int("c=0 pure burn shrunk: best P&L per USDC pushed (ppm)", bestPpm);
    }

    /// @dev Any push, park, creator fee, burn share, pool shape, pot and elapsed time (the budget's proration).
    function testFuzz_anyShapeNeverPays(
        uint64 pushRaw,
        bool park,
        uint16 c,
        uint16 burnBps,
        uint8 shape,
        uint32 potRaw,
        uint16 elapsedRaw,
        bool sweep
    ) public {
        c = uint16(bound(c, 0, 1_000));
        burnBps = uint16(bound(burnBps, 0, 10_000));
        uint256 push = bound(pushRaw, 1e3, 2_000_000e6); // below ~0.001 USDC the router refuses the buy (ZeroAmount)
        uint256 pot = bound(potRaw, 3, 4_000_000_000) * 1e3;
        Pool p = Pool(bound(shape, 0, 3));
        address token = _graduatedToken(c, burnBps, 0);
        _shape(token, p);
        // Organic volume leaves creator fees pending, so a sweep has something to take.
        if (c != 0) {
            vm.startPrank(carol);
            uint256 got = router.buy(token, 50_000e6, 0, carol, block.timestamp);
            router.sell(token, got, 0, carol, block.timestamp);
            vm.stopPrank();
        }
        _topUp(token, pot);
        // A run an hour ago, then a prorated budget (or a full cap once an hour has passed).
        _step(HOUR);
        if (deepen.usdcHeld(token) >= 3) {
            (uint256 offered,,,) = deepen.previewRun(token);
            if (offered != 0) deepen.run(token);
        }
        _step(bound(elapsedRaw, 1, 2 * HOUR));
        atk = _newAttacker();
        _pushParkProgram(token, address(deepen), push, park, sweep);
        // A program the pot or the pacing makes impossible (NothingToBuy) is no attack; nothing else may fail.
        try atk.exec(_prog) returns (int256 pnl) {
            assertLt(pnl, 0, "USDC in, less USDC out");
        } catch (bytes memory err) {
            assertEq(bytes4(err), IDeepenPoolPlugin.NothingToBuy.selector, "only an empty budget stops the program");
        }
    }
}
