// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Scenarios} from "./Scenarios.sol";

/// @notice Claude review #9, I1: planting a victim's bid above the market and selling into it (regression tests).
///         Before the fix (6a49fea) a window buy's bid was placed from half the price just before that buy, so a
///         front-run pump lifted the victim's bid and the back-run sold into it. Measured then at block 19, against a
///         100,000 USDC victim with no minimum out: the back-run took 1,675, 3,014 and 3,746 USDC of his 4,500 bid for
///         pumps of 50k, 100k and 200k (the bid's loss at the final price 617, 1,999 and 3,088), and 4,095 with a 400k
///         pump split into 50 buys. Reaching the bid at all needed a victim who accepts 36% to 43% of the tokens he was
///         quoted (pumps of 15,014 to 30,438 USDC for victims of 5,000 to 100,000).
///         Since review #9's L1 fix (82d410d) a window bid starts from the cheaper of the pre-buy price and the graduation
///         price. With the market at or above half the graduation price no pump lifts the victim's bid above where the
///         back-run ends, so it takes nothing (asserted below), and the sandwich still pays less in the window than the
///         same trades after it.
///         Residual, not fixed by the cap: once a dump has taken the market under half the graduation price inside the
///         window, a pump can still lift a victim's bid from half the crashed price up to half the graduation price,
///         above the market. Measured at block 19 (100,000 USDC victim): after a 150M-token dump (the price at about a
///         third of graduation) the back-run takes 208, 507 and 639 of the 4,500 bid for 50k, 100k and 200k pumps (the
///         bid's loss 9, 56 and 89); after 300M, 1,418 and 1,673 for 50k and 200k (loss 442 and 616); after 600M (about a
///         sixteenth of graduation), 2,551 and 2,669 (loss 1,432 and 1,567). The victim keeps at most 16% of his quote in
///         every one of those. The residual test bounds it.
abstract contract WindowHarvestTest is Scenarios {
    /// @dev Review #8's pump inside the window, alone: 40,000 USDC, then 10,000 more, then sell everything. Before the fix
    ///      it got back 4,726 (block 0), 15,938 (5), 27,358 (10), 38,593 (15), 45,179 (18) and 47,347 (19) of 50,000; now
    ///      4,726, 15,919, 27,113, 38,307, 45,023 and 47,262 (the second buy's bid no longer sits above where the dump
    ///      ends, so none of its surcharge comes back).
    function test_aPumpAndDumpAloneLosesAtEveryBlockOfTheWindow() public {
        uint256[] memory buys = new uint256[](2);
        (buys[0], buys[1]) = (40_000e6, 10_000e6);
        uint256[6] memory blocks = [uint256(0), 5, 10, 15, 18, 19];
        console2.log("review #8's pump (40,000 then 10,000, then sell all), USDC back of 50,000 (whole USDC):");
        for (uint256 i; i < blocks.length; ++i) {
            (uint256 putIn, uint256 back) = _pumpAndDump(blocks[i], buys);
            console2.log("  block of the window", blocks[i], "back", back / 1e6);
            assertLt(back, putIn, "a loss");
        }
    }

    // ─── The fix: nothing is taken ────────────────────────────────────────────

    /// @dev Block 19 (4.5%), market at graduation: a 100,000 USDC victim with no minimum out, front-run by pumps of
    ///      every size in one buy and in 50: the back-run never takes anything from his bid, and the sandwich pays less
    ///      in the window than the same trades after it.
    function test_aFrontRunTakesNothingFromTheVictimsBid() public {
        console2.log("victim 100,000 USDC at block 19 (4.5%), no minimum out:");
        this.oneFrontRun(10_000e6, 1);
        this.oneFrontRun(25_000e6, 1);
        this.oneFrontRun(50_000e6, 1);
        this.oneFrontRun(100_000e6, 1);
        this.oneFrontRun(200_000e6, 1);
        this.oneFrontRun(50_000e6, 50);
        this.oneFrontRun(100_000e6, 50);
        this.oneFrontRun(200_000e6, 50);
        this.oneFrontRun(400_000e6, 50);
    }

    /// @dev One front-run (external so each runs in its own frame).
    function oneFrontRun(uint256 pump, uint256 chunks) external {
        require(msg.sender == address(this));
        Run memory w = _sandwich(Attack(0, 19, 100_000e6, pump, chunks));
        Run memory a = _sandwich(Attack(0, 20, 100_000e6, pump, chunks));
        console2.log("  pump (USDC), in buys", pump / 1e6, chunks);
        console2.log("    attacker P&L in the window, then the same trades after it (USDC):");
        console2.logInt(w.attackerPnl / 1e6);
        console2.logInt(a.attackerPnl / 1e6);
        console2.log("    victim's bid: placed, taken by the back-run (USDC)", w.victimBidUsdc / 1e6, w.bidTaken / 1e6);
        assertTrue(w.placed, "the victim's window buy placed a bid");
        assertEq(w.bidTaken, 0, "the back-run takes nothing from the victim's bid");
        assertLt(w.attackerPnl, a.attackerPnl, "the window's sandwich pays less than the same one after it");
    }

    /// @dev Market at graduation, block 19: for victims of 5,000 to 100,000 USDC, no pump from 1,000 to 400,000 USDC
    ///      lets the back-run reach the victim's bid (before the fix, 15,014 to 30,438 did).
    function test_noPumpLetsTheBackRunReachTheBid() public {
        uint256[4] memory victims = [uint256(5_000e6), 20_000e6, 50_000e6, 100_000e6];
        for (uint256 v; v < victims.length; ++v) {
            this.sweepPumps(victims[v]);
        }
    }

    function sweepPumps(uint256 victim) external {
        require(msg.sender == address(this));
        for (uint256 pump = 1_000e6; pump <= 400_000e6; pump += pump / 4) {
            Run memory w = _sandwich(Attack(0, 19, victim, pump, 1));
            assertEq(w.bidTaken, 0, "no pump reaches the bid");
        }
    }

    // ─── The residual, bounded ────────────────────────────────────────────────

    /// @dev After a dump under half the graduation price inside the window, a pump can still lift a victim's bid up to
    ///      half the graduation price, above the crashed market, and the back-run takes part of it. Bounded here by the
    ///      measured figures with room (the bid's loss at the final price, bps of the bid), and only ever with a victim
    ///      who accepts a small fraction of his quote.
    function test_afterACrashUnderHalfGraduationTheTakeStaysSmall() public {
        console2.log("after a dump in the opening block, victim 100,000 USDC at block 19, no minimum out:");
        this.oneCrashedFrontRun(100_000_000e18, 200_000e6, 100); // about 44% of graduation: measured loss 2
        this.oneCrashedFrontRun(150_000_000e18, 50_000e6, 100); // about 33%: measured 9
        this.oneCrashedFrontRun(150_000_000e18, 200_000e6, 500); // measured 89
        this.oneCrashedFrontRun(300_000_000e18, 50_000e6, 1_500); // about 16%: measured 442
        this.oneCrashedFrontRun(300_000_000e18, 200_000e6, 2_000); // measured 616
        this.oneCrashedFrontRun(600_000_000e18, 50_000e6, 4_000); // about 6%: measured 1,432
        this.oneCrashedFrontRun(600_000_000e18, 200_000e6, 4_500); // measured 1,567
    }

    function oneCrashedFrontRun(uint256 crash, uint256 pump, uint256 maxLossBps) external {
        require(msg.sender == address(this));
        Run memory base = _sandwich(Attack(crash, 19, 100_000e6, 0, 1));
        Run memory w = _sandwich(Attack(crash, 19, 100_000e6, pump, 1));
        uint256 keptBps = w.victimTokens * 1e4 / base.victimTokens;
        console2.log("  dump (M tokens), pump (USDC)", crash / 1e24, pump / 1e6);
        console2.log(
            "    bid placed, taken (USDC), victim keeps (bps of quote)",
            w.victimBidUsdc / 1e6,
            w.bidTaken / 1e6,
            keptBps
        );
        console2.log("    the bid's loss at the final price (USDC):");
        console2.logInt(w.bidLoss / 1e6);
        assertEq(base.bidTaken, 0, "unattacked, the victim's bid sits under the market");
        uint256 loss = w.bidLoss > 0 ? uint256(w.bidLoss) : 0;
        assertLt(loss * 1e4, maxLossBps * w.victimBidUsdc, "the bid's loss stays within the measured bound");
        if (w.bidTaken != 0) assertLt(keptBps, 2_000, "and only a victim accepting under a fifth of his quote");
    }
}

contract WindowHarvestUsdcLowTest is WindowHarvestTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract WindowHarvestUsdcHighTest is WindowHarvestTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
