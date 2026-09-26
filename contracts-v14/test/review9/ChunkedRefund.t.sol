// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {IArchitexLaunchHook} from "../../src/interfaces/IArchitexLaunchHook.sol";
import {Scenarios} from "./Scenarios.sol";

/// @notice Claude review #9, L1: a sniper splitting his window buy got part of his own surcharge back (regression tests).
///         Before the fix (6a49fea) each window buy's bid was placed from half the price just before THAT buy, so when
///         one sniper's own buys lifted the price, each later chunk's bid sat higher, and his dump at the window's close
///         sold into every one above where it ended. Measured then (all buys in one transaction, dump in the first block
///         after the window; share of the surcharge back with 50 buys instead of 1):
///         - 20,000 USDC: nothing back; 50,000: 2% (block 10) to 9% (block 19); 100,000: 8% to 23%; 250,000: 24% to 47%;
///         - 1,000,000 in 50 buys: 33% (block 5), 53% (block 10), 67% (block 15), 76% (block 19); at block 10 that was
///           238,626 USDC more back (780,900 against 542,274).
///         Since the fix (82d410d) a window bid starts from the cheaper of the pre-buy price and the graduation price,
///         so no bid starts above half the graduation price. With the market at or above half the graduation price a
///         chunked sniper now gets back no more than one buy does (asserted below for every size and block measured).
///         Bids still follow a crash down, and nothing waits.
///         Residual, not fixed by the cap: once a dump has taken the market under half the graduation price inside the
///         window, chunks that lift the price back above it place their bids at half the graduation price, above the
///         crashed market, and the dump at the close sells into them. Measured at block 19 (share of the surcharge back,
///         50 buys against 1): after a 100M-token dump (about 44% of graduation) 0.1% to 0.2%; after 150M (about 33%)
///         1.2% to 2.7%; after 300M (about 16%) 7.6% to 13.1%; after 600M (about 6%) 21.6% to 33.7%. The residual test
///         bounds it.
abstract contract ChunkedRefundTest is Scenarios {
    /// @dev Back with one buy and with `chunks` buys, and the share of the surcharge the chunks got back (bps).
    function _refund(uint256 crash, uint256 blocksIn, uint256 total, uint256 chunks)
        internal
        returns (uint256 one, uint256 many, uint256 bps)
    {
        one = _snipeThenDump(crash, blocksIn, total, 1);
        many = _snipeThenDump(crash, blocksIn, total, chunks);
        uint256 surcharge = total * (9000 * (20 - blocksIn) / 20) / 1e4;
        bps = many > one ? (many - one) * 1e4 / surcharge : 0;
    }

    // ─── The fix: nothing comes back ──────────────────────────────────────────

    function oneSize(uint256 blocksIn, uint256 total) external {
        require(msg.sender == address(this));
        (uint256 one, uint256 many,) = _refund(0, blocksIn, total, 50);
        console2.log("  block, total USDC", blocksIn, total / 1e6);
        console2.log("    back with 1 buy / with 50 (USDC, 6dp)", one, many);
        assertLe(many, one, "50 buys get back no more than one buy");
    }

    /// @dev Every size and block the review measured the refund at, market at graduation.
    function test_aChunkedSniperGetsBackNoMoreThanOneBuy() public {
        console2.log("snipe then dump at the window's close, 1 buy vs. 50 buys:");
        uint256[3] memory blocks = [uint256(19), 15, 10];
        uint256[4] memory totals = [uint256(20_000e6), 50_000e6, 100_000e6, 250_000e6];
        for (uint256 b; b < blocks.length; ++b) {
            for (uint256 t; t < totals.length; ++t) {
                this.oneSize(blocks[b], totals[t]);
            }
        }
        this.oneSize(19, 1_000_000e6);
        this.oneSize(15, 1_000_000e6);
        this.oneSize(10, 1_000_000e6);
        this.oneSize(5, 1_000_000e6);
    }

    /// @dev What the cap keeps from review #8's fix, and where it binds: after a crash under half the graduation price
    ///      the next window buy's bid follows the price down; above graduation a bid starts from the graduation price.
    function test_bidsFollowACrashDownAndStartNoHigherThanGraduation() public {
        address token = _graduateWithCurveSnipe(0, false, dave, 0);
        (, IArchitexLaunchHook.Launch memory l) = hook.launchOf(token);
        vm.prank(bob);
        router.sell(token, 150_000_000e18, 0, bob, MAX); // under half the graduation price, inside the window
        (, int24 crashed) = _slot0(token);
        vm.recordLogs();
        vm.prank(carol);
        router.buy(token, 3_000e6, 0, carol, MAX);
        Bid[] memory bids = _bidsIn(vm.getRecordedLogs(), token);
        (int24 lo, int24 hi) = _rangeFrom(l.usdcIs0, crashed);
        assertEq(bids.length, 1);
        assertEq(bids[0].lower, lo, "from the crashed price, not the graduation price");
        assertEq(bids[0].upper, hi);
        vm.prank(carol);
        router.buy(token, 200_000e6, 0, carol, MAX); // far above graduation now
        vm.recordLogs();
        vm.prank(alice);
        router.buy(token, 1_000e6, 0, alice, MAX);
        bids = _bidsIn(vm.getRecordedLogs(), token);
        (lo, hi) = _rangeFrom(l.usdcIs0, l.graduationTick);
        assertEq(bids[0].lower, lo, "capped at half the graduation price");
        assertEq(bids[0].upper, hi);
        assertLe(hook.lockHeld(token), 2, "nothing waits");
        _assertHookClean(token);
        _assertSolvent();
    }

    // ─── The residual, bounded ────────────────────────────────────────────────

    function oneCrashed(uint256 crash, uint256 blocksIn, uint256 total, uint256 maxBps) external {
        require(msg.sender == address(this));
        (uint256 one, uint256 many, uint256 bps) = _refund(crash, blocksIn, total, 50);
        console2.log("  dump (M tokens), block, total USDC", crash / 1e24, blocksIn, total / 1e6);
        console2.log("    back with 1 / with 50 (USDC), surcharge back (bps)", one / 1e6, many / 1e6, bps);
        assertLt(bps, maxBps, "within the measured bound");
        assertLt(many, total, "still a loss");
    }

    /// @dev After a dump under half the graduation price in the opening block, chunks that lift the price back above
    ///      it get part of their surcharge back again: bounded by the measured figures with room.
    function test_afterACrashUnderHalfGraduationTheRefundStaysBounded() public {
        console2.log("after a dump in the opening block: snipe then dump at the close, 1 buy vs. 50 buys:");
        this.oneCrashed(100_000_000e18, 19, 100_000e6, 100); // measured 21 bps
        this.oneCrashed(150_000_000e18, 19, 100_000e6, 500); // measured 270
        this.oneCrashed(150_000_000e18, 19, 1_000_000e6, 500); // measured 115
        this.oneCrashed(300_000_000e18, 19, 250_000e6, 2_000); // measured 1,314
        this.oneCrashed(600_000_000e18, 19, 100_000e6, 4_500); // measured 3,371
        this.oneCrashed(600_000_000e18, 19, 1_000_000e6, 3_000); // measured 2,161
        this.oneCrashed(600_000_000e18, 10, 250_000e6, 4_500);
        this.oneCrashed(600_000_000e18, 15, 250_000e6, 4_500);
    }
}

contract ChunkedRefundUsdcLowTest is ChunkedRefundTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract ChunkedRefundUsdcHighTest is ChunkedRefundTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
