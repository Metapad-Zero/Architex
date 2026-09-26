// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {Review9Base, MultiFlash} from "./Review9Base.sol";

/// @dev Claude review #9's trading scenarios, each run from a snapshot and rolled back, so a test can sweep many. Every
///      scenario graduates a fresh token with no curve snipe (so no graduation bid beyond a unit of rounding), can first
///      have a holder dump into the pool in its opening block (`crash`, tokens; sells pay no surcharge), and checks the
///      hook's books before rolling back.
abstract contract Scenarios is Review9Base {
    /// @dev A holder (bob, who bought the curve out) dumps `tokens` into the pool now, if any.
    function _crash(address token, uint256 tokens) internal {
        if (tokens == 0) return;
        vm.prank(bob);
        router.sell(token, tokens, 0, bob, MAX);
    }

    /// @dev Graduates a fresh token, applies `crash`, then moves `blocksIn` blocks into the pool's window.
    function _open(uint256 crash, uint256 blocksIn) internal returns (address token) {
        token = _graduateWithCurveSnipe(0, false, dave, 0);
        _crash(token, crash);
        if (blocksIn != 0) _step(blocksIn);
    }

    /// @dev `amount` USDC bought in `n` equal buys inside one unlock by the multi-swapper.
    function _buyInChunks(address token, uint256 amount, uint256 n) internal {
        MultiFlash.Step[] memory steps = new MultiFlash.Step[](n);
        for (uint256 i; i < n; ++i) {
            steps[i] = _mstep(token, _buyIn(token, amount / n));
        }
        usdc.mint(address(mflash), amount);
        mflash.run(steps, _currencies(token));
    }

    /// @dev The multi-swapper sells every token it holds.
    function _sellEverything(address token) internal {
        uint256 bag = IERC20(token).balanceOf(address(mflash));
        if (bag == 0) return;
        MultiFlash.Step[] memory dump = new MultiFlash.Step[](1);
        dump[0] = _mstep(token, _sellIn(token, bag));
        mflash.run(dump, _currencies(token));
    }

    // ─── One trader alone ─────────────────────────────────────────────────────

    /// @dev In one unlock at `blocksIn` blocks into the pool's window: buy each of `buys`, then sell everything bought.
    ///      Returns what the round trip put in and got back.
    function _pumpAndDump(uint256 blocksIn, uint256[] memory buys) internal returns (uint256 putIn, uint256 back) {
        uint256 snap = vm.snapshotState();
        address token = _open(0, blocksIn);
        MultiFlash.Step[] memory steps = new MultiFlash.Step[](buys.length + 1);
        for (uint256 i; i < buys.length; ++i) {
            steps[i] = _mstep(token, _buyIn(token, buys[i]));
            putIn += buys[i];
        }
        steps[buys.length] = _sellAllStep(token);
        usdc.mint(address(mflash), putIn);
        uint256 u0 = usdc.balanceOf(address(mflash));
        mflash.run(steps, _currencies(token));
        back = usdc.balanceOf(address(mflash)) - (u0 - putIn);
        assertEq(IERC20(token).balanceOf(address(mflash)), 0, "sold everything");
        _assertHookClean(token);
        vm.revertToState(snap);
    }

    /// @dev After `crash`, a sniper buys `total` USDC in `n` equal window buys at `blocksIn` (one unlock), then dumps
    ///      everything in the first block after the window. Returns the USDC he got back.
    function _snipeThenDump(uint256 crash, uint256 blocksIn, uint256 total, uint256 n) internal returns (uint256 back) {
        uint256 snap = vm.snapshotState();
        address token = _open(crash, blocksIn);
        uint256 u0 = usdc.balanceOf(address(mflash));
        _buyInChunks(token, total, n);
        _step(20 - blocksIn); // the first block after the window
        _sellEverything(token);
        back = usdc.balanceOf(address(mflash)) - u0;
        _assertHookClean(token);
        vm.revertToState(snap);
    }

    // ─── A victim's window buy, sandwiched ────────────────────────────────────

    struct Attack {
        uint256 crash; // tokens a holder dumps in the opening block first
        uint256 blocksIn; // blocks into the pool's window
        uint256 victim; // the victim's router buy, USDC, no minimum out
        uint256 pump; // the attacker's front-run, USDC
        uint256 chunks; // how many buys the pump is split into (one unlock)
    }

    struct Run {
        int256 attackerPnl; // USDC, 6dp
        uint256 victimTokens;
        uint256 victimBidUsdc; // what the victim's surcharge put in its bid
        uint256 bidTaken; // USDC the back-run took out of that bid
        int256 bidLoss; // the bid's loss at the final price: USDC out minus the value of the tokens it now holds
        bool placed; // the victim's buy placed a bid
        Bid bid;
    }

    /// @dev In one block: the attacker's pump, the victim's buy, the attacker's sale of everything he bought.
    function _sandwich(Attack memory a) internal returns (Run memory r) {
        uint256 snap = vm.snapshotState();
        address token = _open(a.crash, a.blocksIn);
        uint256 u0 = usdc.balanceOf(address(mflash));
        if (a.pump != 0) _buyInChunks(token, a.pump, a.chunks);
        _victimBuys(token, a.victim, r);
        _sellEverything(token);
        r.attackerPnl = int256(usdc.balanceOf(address(mflash))) - int256(u0) - int256(a.pump);
        if (r.placed) _score(token, r);
        _assertHookClean(token);
        _assertSolvent();
        vm.revertToState(snap);
    }

    function _victimBuys(address token, uint256 victim, Run memory r) internal {
        vm.recordLogs();
        vm.prank(carol);
        r.victimTokens = router.buy(token, victim, 0, carol, MAX);
        Bid[] memory bids = _bidsIn(vm.getRecordedLogs(), token);
        if (bids.length != 0) (r.placed, r.bid, r.victimBidUsdc) = (true, bids[0], bids[0].usdc);
    }

    /// @dev What the back-run took out of the victim's bid, and the bid's loss at the pool's price now.
    function _score(address token, Run memory r) internal view {
        (uint256 usdcNow, uint256 tokensNow) = _bidHoldings(token, r.bid);
        // Holdings are read rounded down and v4 charged the bid rounded up: 2 units of slack.
        r.bidTaken = r.bid.usdc - usdcNow > 2 ? r.bid.usdc - usdcNow : 0;
        if (r.bidTaken != 0) r.bidLoss = int256(r.bidTaken) - int256(_valueNow(token, tokensNow));
    }

    // ─── Griefing ─────────────────────────────────────────────────────────────

    /// @dev The griefer sells 100M tokens just before carol's 5,000 USDC buy at `blocksIn`, then buys the 100M back
    ///      `undoAfter` blocks later. Returns his cost, and carol's bid top as a fraction (bps) of where it would have
    ///      landed without the push (0 when her buy placed no bid).
    function _grief(uint256 blocksIn, uint256 undoAfter) internal returns (uint256 cost, uint256 topBps) {
        uint256 snap = vm.snapshotState();
        address token = _open(0, blocksIn);
        (, int24 tick0) = _slot0(token);
        int24 honestRef = _cheaper(_usdcIs0(token), tick0, _refOf(token)); // where an unpushed buy's bid would start
        vm.prank(bob);
        IERC20(token).transfer(address(raw), 100_000_000e18);
        uint256 usdc0 = usdc.balanceOf(address(raw));
        raw.swap(_key(token), _sellIn(token, 100_000_000e18));
        vm.recordLogs();
        vm.prank(carol);
        router.buy(token, 5_000e6, 0, carol, MAX);
        Bid[] memory bids = _bidsIn(vm.getRecordedLogs(), token);
        if (undoAfter != 0) _step(undoAfter);
        raw.swap(_key(token), _buyExactOut(token, 100_000_000e18));
        cost = usdc0 - usdc.balanceOf(address(raw));
        if (bids.length != 0) topBps = _topRatioBps(token, bids[0], honestRef);
        vm.revertToState(snap);
    }

    /// @dev A bid's top over the top a bid placed from `honestRef` would have had, in USDC per token (bps).
    function _topRatioBps(address token, Bid memory bid, int24 honestRef) internal view returns (uint256) {
        bool u0 = _usdcIs0(token);
        (int24 lo, int24 hi) = _rangeFrom(u0, honestRef);
        int256 d = u0 ? int256(lo) - bid.lower : int256(bid.upper) - hi; // <= 0: the pushed top is not higher
        uint256 r = uint256(TickMath.getSqrtPriceAtTick(int24(d)));
        return FullMath.mulDiv(r * r, 1e4, 1 << 192);
    }
}
