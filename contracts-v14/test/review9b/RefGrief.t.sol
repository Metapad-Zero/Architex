// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {RawSwapper} from "../V14Base.sol";
import {Review9bBase} from "./Review9bBase.sol";

/// @notice Claude review #9b, attack 2 (measured): lowering the pool's bid reference on purpose.
///         The reference only moves down, so one dump inside the window followed by one buy that pays a snipe fee
///         (any size) places every later window bid from half the dumped price, whatever the price does afterwards.
abstract contract RefGriefTest is Review9bBase {
    // ─── What it costs ────────────────────────────────────────────────────────

    /// @dev At `blocksIn`, the griefer (holding `push` tokens) sells them, buys 0.001 USDC (paying a snipe fee, so the
    ///      reference moves to the dumped price), and buys the `push` tokens back `undoAfter` blocks later (0: in the same
    ///      block, paying that block's surcharge). With `dipBuyers`, two snipers buy 2,000 USDC each at blocks 10 and
    ///      15 while the price is down. Returns the griefer's USDC cost and the reference's price after, as bps of the
    ///      graduation price (USDC per token).
    function _poison(uint256 blocksIn, uint256 push, uint256 undoAfter, bool dipBuyers)
        internal
        returns (uint256 cost, uint256 refBps)
    {
        uint256 snap = vm.snapshotState();
        address t = _open(0, blocksIn);
        uint256 openBlk = block.number - blocksIn;
        RawSwapper g = new RawSwapper(manager);
        vm.prank(bob);
        IERC20(t).transfer(address(g), push);
        usdc.mint(address(g), 1e9 * 1e6);
        uint256 u0 = usdc.balanceOf(address(g));
        g.swap(_key(t), _sellIn(t, push));
        g.swap(_key(t), _buyIn(t, 1_000)); // a window buy that pays a snipe fee: the reference follows the dump
        refBps = _priceBps(t, _refOf(t), _gradTick(t));
        if (dipBuyers) {
            _step(openBlk + 10 - block.number);
            vm.prank(carol);
            router.buy(t, 2_000e6, 0, carol, MAX);
            _step(5);
            vm.prank(alice);
            router.buy(t, 2_000e6, 0, alice, MAX);
        }
        if (undoAfter != 0) {
            _step(openBlk + blocksIn + undoAfter > block.number ? openBlk + blocksIn + undoAfter - block.number : 1);
        }
        uint256 bag = IERC20(t).balanceOf(address(g));
        g.swap(_key(t), _buyExactOut(t, push));
        cost = u0 - usdc.balanceOf(address(g));
        assertGe(IERC20(t).balanceOf(address(g)), bag + push, "the bag is back");
        _assertHookClean(t);
        vm.revertToState(snap);
    }

    /// @dev Price at tick `a` over price at tick `b`, USDC per token, in bps.
    function _priceBps(address t, int24 a, int24 b) internal view returns (uint256) {
        int256 d = _usdcIs0(t) ? int256(b) - a : int256(a) - b;
        if (d > 0) d = 0; // only ever at or under
        uint256 r = uint256(TickMath.getSqrtPriceAtTick(int24(d)));
        return FullMath.mulDiv(r * r, 1e4, 1 << 192);
    }

    function test_whatLoweringTheReferenceCosts() public {
        console2.log(
            "push 82M tokens (about half the price) or 300M (about a sixth), buy 0.001 USDC, buy the push back:"
        );
        uint256[5] memory blocks = [uint256(0), 5, 10, 15, 19];
        for (uint256 i; i < blocks.length; ++i) {
            (uint256 c82, uint256 r82) = _poison(blocks[i], 82_000_000e18, 0, false);
            (uint256 c300, uint256 r300) = _poison(blocks[i], 300_000_000e18, 0, false);
            console2.log("  block, undone in the same block: cost 82M / 300M (USDC)", blocks[i], c82 / 1e6, c300 / 1e6);
            console2.log("    reference after, bps of graduation (82M / 300M)", r82, r300);
        }
        (uint256 h300, uint256 hr300) = _poison(1, 300_000_000e18, 19, false);
        (uint256 d300,) = _poison(1, 300_000_000e18, 19, true);
        console2.log(
            "  300M at block 1, bought back when the window closes: cost with nobody buying the dip", h300 / 1e6
        );
        console2.log("    with two snipers buying 2,000 USDC each in the dip", d300 / 1e6);
        console2.log("    reference after, bps of graduation", hr300);
        assertLt(h300, 300e6, "held across the window with no buyers in between it costs only the fees");
        assertGt(d300, 10 * h300, "buyers in the dip make it cost what they gain");
        assertLt(hr300, 2_000, "every later window bid starts from under a fifth of the graduation price");
    }

    // ─── What it does ─────────────────────────────────────────────────────────

    struct Outcome {
        uint256 sniperBidTopBps; // the later snipers' bid top, bps of the market when they bought
        uint256 dumpUsdc; // what a holder's post-window dump of 450M tokens got
        uint256 bottomBuyCost; // USDC to buy 100M tokens right after that dump
        uint256 poisonCost;
    }

    /// @dev Graduation; optionally a one-transaction poison at block 9 (push 300M, 0.001 USDC buy, buy back, so the price
    ///      is where it was and only the reference moved); snipers buy 20,000 USDC at block 10 and 20,000 at block 15;
    ///      after the window a holder dumps 450M tokens; then someone buys 100M tokens at the bottom.
    function _story(bool poison) internal returns (Outcome memory o) {
        uint256 snap = vm.snapshotState();
        address t = _open(0, 9);
        if (poison) {
            RawSwapper g = new RawSwapper(manager);
            vm.prank(bob);
            IERC20(t).transfer(address(g), 300_000_000e18);
            usdc.mint(address(g), 1e9 * 1e6);
            uint256 u0 = usdc.balanceOf(address(g));
            g.swap(_key(t), _sellIn(t, 300_000_000e18));
            g.swap(_key(t), _buyIn(t, 1_000));
            g.swap(_key(t), _buyExactOut(t, 300_000_000e18));
            o.poisonCost = u0 - usdc.balanceOf(address(g));
            vm.prank(address(g));
            IERC20(t).transfer(bob, 300_000_000e18); // the same holder as in the honest story
        }
        _step(1); // block 10
        uint256 m = _priceE18(t);
        vm.recordLogs();
        vm.prank(carol);
        router.buy(t, 20_000e6, 0, carol, MAX);
        _step(5); // block 15
        vm.prank(alice);
        router.buy(t, 20_000e6, 0, alice, MAX);
        Bid[] memory bids = _bidsIn(vm.getRecordedLogs(), t);
        o.sniperBidTopBps = _priceBps(t, _usdcIs0(t) ? bids[0].lower : bids[0].upper, _tickOfPrice(t, m));
        _step(6); // after the window
        vm.prank(bob);
        o.dumpUsdc = router.sell(t, 450_000_000e18, 0, bob, MAX);
        RawSwapper buyer = new RawSwapper(manager);
        usdc.mint(address(buyer), 1e9 * 1e6);
        uint256 b0 = usdc.balanceOf(address(buyer));
        buyer.swap(_key(t), _buyExactOut(t, 100_000_000e18));
        o.bottomBuyCost = b0 - usdc.balanceOf(address(buyer));
        _assertHookClean(t);
        vm.revertToState(snap);
    }

    /// @dev The tick whose price (USDC per whole token, 1e18-scaled, as `_priceE18`) is `p`, near enough for a ratio.
    function _tickOfPrice(address t, uint256 p) internal view returns (int24) {
        // USDC per raw token = p / 1e18 / 1e12 raw units; tick price is currency1 per currency0 in raw units.
        uint256 x96 = _usdcIs0(t) ? FullMath.mulDiv(1e30, 1 << 96, p) : FullMath.mulDiv(p, 1 << 96, 1e30);
        uint160 sqrtP = uint160(_sqrt(x96 << 96));
        return TickMath.getTickAtSqrtPrice(sqrtP);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        y = x;
        uint256 z = (x + 1) / 2;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    /// @dev The honest version: a holder dumps 300M tokens at block 1 and keeps the USDC; someone buys 3,000 USDC at
    ///      block 2 (the reference follows the dump); a 60,000 USDC buy at block 5 lifts the price back far above it;
    ///      snipers then buy 20,000 USDC at blocks 10 and 15. Their bids start from half the dip, however high the
    ///      market has gone since.
    function test_anHonestDipSetsTheLevelForTheRestOfTheWindow() public {
        address t = _open(300_000_000e18, 1);
        _step(1);
        vm.prank(carol);
        router.buy(t, 3_000e6, 0, carol, MAX);
        _step(3);
        vm.prank(dave);
        router.buy(t, 60_000e6, 0, dave, MAX);
        _step(5); // block 10
        uint256 m = _priceE18(t);
        vm.recordLogs();
        vm.prank(alice);
        router.buy(t, 20_000e6, 0, alice, MAX);
        Bid[] memory bids = _bidsIn(vm.getRecordedLogs(), t);
        uint256 topBps = _priceBps(t, _usdcIs0(t) ? bids[0].lower : bids[0].upper, _tickOfPrice(t, m));
        uint256 gradBps = _priceBps(t, _gradTick(t), _tickOfPrice(t, m));
        console2.log(
            "after an honest dip and a recovery: a block-10 sniper's bid top, bps of the market he bought at", topBps
        );
        console2.log("  (the graduation price was then this many bps of the market)", gradBps);
        assertLt(topBps, 1_000, "under a tenth of the market");
        _assertHookClean(t);
    }

    function test_whatLoweringTheReferenceDoesAndWhoGains() public {
        Outcome memory honest = _story(false);
        Outcome memory poisoned = _story(true);
        console2.log(
            "snipers' bids (bps of the market they bought at): honest / poisoned",
            honest.sniperBidTopBps,
            poisoned.sniperBidTopBps
        );
        console2.log(
            "a 450M-token dump after the window got (USDC): honest / poisoned",
            honest.dumpUsdc / 1e6,
            poisoned.dumpUsdc / 1e6
        );
        console2.log(
            "100M tokens bought right after it cost (USDC): honest / poisoned",
            honest.bottomBuyCost / 1e6,
            poisoned.bottomBuyCost / 1e6
        );
        console2.log("the poison cost (USDC)", poisoned.poisonCost / 1e6);
        assertLt(poisoned.sniperBidTopBps, honest.sniperBidTopBps, "later bids start lower");
        assertLe(poisoned.dumpUsdc, honest.dumpUsdc, "a later dump finds less support");
        // Whoever buys after the dump saves less than the poison cost: poisoning does not pay for itself this way.
        uint256 saved =
            honest.bottomBuyCost > poisoned.bottomBuyCost ? honest.bottomBuyCost - poisoned.bottomBuyCost : 0;
        console2.log("  the bottom buyer saved (USDC)", saved / 1e6);
        assertLt(saved, poisoned.poisonCost, "the saving is smaller than what the poison cost");
    }
}

contract RefGriefUsdcLowTest is RefGriefTest {
    function _usdcAt() internal pure override returns (address) {
        return address(0x0000000000000000000000000000000000001000);
    }
}

contract RefGriefUsdcHighTest is RefGriefTest {
    function _usdcAt() internal pure override returns (address) {
        return address(uint160(type(uint160).max - 0xfff));
    }
}
