// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";
import {IDeepenPoolPlugin} from "../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {DeepenPoolPlugin} from "../../plugins/launch/DeepenPoolPlugin.sol";

// ═══════════════════════════════════════════════════════════════════════════════
// Deepen pool against the REAL launchpad, launch tokens, launch pairs and launch router (E2EBase's fixture, with the
// reference plugins alongside). Every run helper recomputes what the run must do from the spec formulas and the pool's
// own state, checks the trade's fees like any other trade, and checks that the plugin ends the call with no token, no
// LP, no allowance and books that match its USDC.
// ═══════════════════════════════════════════════════════════════════════════════

abstract contract DeepenE2EBase is E2EBase {
    DeepenPoolPlugin internal deepen;

    address[] internal deepenTokens;
    mapping(address token => uint256) internal ghostDeepenCredited;

    function setUp() public virtual override {
        super.setUp();
        deepen = new DeepenPoolPlugin(address(pad));
        _trackUsdc(address(deepen));
    }

    // ─── Launching ────────────────────────────────────────────────────────────

    function _launchDeepen(uint16 bps) internal returns (address token) {
        return _launchDeepen(bps, 0);
    }

    function _launchDeepen(uint16 bps, uint256 initialBuy) internal returns (address token) {
        token = _launchWith(alice, bps, address(deepen), "", initialBuy);
        deepenTokens.push(token);
        assertTrue(deepen.isConfigured(token), "configured at launch");
    }

    /// @dev Registers a token whose fees reach Deepen pool through a Combo.
    function _trackDeepenToken(address token) internal {
        deepenTokens.push(token);
    }

    // ─── Deliveries ───────────────────────────────────────────────────────────

    /// @dev The launchpad's collection into the token's plugin (E2EBase checks the exact pull), with Deepen's ghost.
    function _collectDeepen(address token) internal returns (uint256 amount) {
        uint256 before = deepen.usdcHeld(token) + deepen.totalUsdcSpent(token);
        amount = _collect(token);
        ghostDeepenCredited[token] += deepen.usdcHeld(token) + deepen.totalUsdcSpent(token) - before;
    }

    /// @dev Anyone topping a token's pot up: Architex's fee wallet, the creator, a keeper. Checked exact.
    function _topUp(address token, address from, uint256 amount) internal {
        uint256 held = deepen.usdcHeld(token);
        uint256 fromBefore = usdc.balanceOf(from);
        vm.startPrank(from);
        usdc.approve(address(deepen), amount);
        vm.expectEmit(true, true, false, true, address(deepen));
        emit ILaunchFeePlugin.FeesReceived(token, from, amount);
        deepen.onFees(token, amount);
        vm.stopPrank();
        assertEq(deepen.usdcHeld(token) - held, amount, "credited exactly");
        assertEq(fromBefore - usdc.balanceOf(from), amount, "pulled exactly");
        assertEq(usdc.allowance(from, address(deepen)), 0);
        ghostDeepenCredited[token] += amount;
    }

    // ─── Runs ─────────────────────────────────────────────────────────────────

    /// @dev What a Deepen run must do, from the spec formulas and the pool's own state.
    struct DeepenExp {
        bool graduated;
        uint256 offer;
        uint256 toBuy;
        uint256 tokensAdded;
        uint256 usdcAdded;
        uint256 liquidity;
        uint256 tokensBurned;
        uint256 spent;
    }

    struct DeepenSnap {
        uint256 held;
        uint256 cap;
        uint256 budget;
        uint256 supply; // the token's total supply
        uint256 usdc; // the plugin's USDC
        uint256 lpSupply;
        uint256 lpDead;
        uint256 reserveToken;
        uint256 reserveUsdc;
        uint256 spent;
        uint256 burned;
        uint256 added;
        uint256 locked;
        uint256 seed; // what a graduating run seeds the pool with
    }

    /// @dev The run budget (V13-SPEC §2.2, shared with Buyback & burn): cap * min(now - lastRunAt, 1 h) / 1 h, rounded
    ///      down; a full cap for a token's first run.
    function _deepenBudget(address token) internal view returns (uint256 cap, uint256 budget) {
        uint256 reserve;
        if (pad.isGraduated(token)) (, reserve) = _reserves(token);
        else reserve = pad.virtualUsdcOf(token);
        cap = reserve * CAP_BPS / BPS;
        budget = cap;
        uint256 last = deepen.lastRunAt(token);
        if (last != 0) {
            uint256 elapsed = _now() - last;
            if (elapsed < RUN_INTERVAL) budget = cap * elapsed / RUN_INTERVAL;
        }
    }

    /// @dev The run's trade (Exp, checked like any other trade) and what it then does with the tokens.
    function _deepenExpectation(address token) internal view returns (Exp memory e, DeepenExp memory d, DeepenSnap memory r) {
        d.graduated = pad.isGraduated(token);
        r.held = deepen.usdcHeld(token);
        (r.cap, r.budget) = _deepenBudget(token);
        d.offer = r.held < r.budget ? r.held : r.budget;
        assertGe(d.offer, MIN_RUN_USDC, "a run needs at least MIN_RUN_USDC on offer");
        (uint256 pOffer, bool pGrad) = deepen.previewRun(token);
        assertEq(pOffer, d.offer, "previewRun = min(held, budget)");
        assertEq(pGrad, d.graduated);

        (r.reserveToken, r.reserveUsdc) = _reserves(token);
        if (d.graduated) {
            // The run syncs the pair first; these expectations assume nothing is waiting to be synced (no test here
            // donates into a pair before a run, and DeepenPoolInvariant.t.sol covers the case that does).
            assertEq(usdc.balanceOf(pad.pairOf(token)), r.reserveUsdc, "the pair is synced");
            assertEq(IERC20(token).balanceOf(pad.pairOf(token)), r.reserveToken, "the pair is synced");
        }
        (uint256 splitBuy, uint256 splitAdd) = deepen.previewSplit(token, d.offer);
        assertEq(splitBuy + splitAdd, d.offer, "the split covers the offer");
        d.toBuy = splitBuy;
        if (d.graduated) {
            (e.tokens, e.platform, e.creator, e.net) = _expPoolBuy(token, d.toBuy);
            e.gross = d.toBuy;
            (d.tokensAdded, d.usdcAdded, d.liquidity) = _addAmounts(
                e.tokens,
                d.offer - d.toBuy,
                r.reserveToken - e.tokens,
                r.reserveUsdc + e.net,
                ILaunchPair(pad.pairOf(token)).totalSupply()
            );
            d.tokensBurned = e.tokens - d.tokensAdded;
            d.spent = d.toBuy + d.usdcAdded;
        } else {
            assertEq(d.toBuy, d.offer, "on the curve the whole offer buys");
            (e.tokens, e.platform, e.creator, e.gross, e.graduates) = _expCurveBuy(token, d.offer);
            e.net = e.gross - e.platform - e.creator;
            r.seed = pad.virtualUsdcOf(token) + e.net - VIRTUAL_USDC_0;
            d.tokensBurned = e.tokens;
            d.spent = e.gross;
        }
        r.supply = IERC20(token).totalSupply();
        r.usdc = usdc.balanceOf(address(deepen));
        r.lpSupply = ILaunchPair(pad.pairOf(token)).totalSupply();
        r.lpDead = ILaunchPair(pad.pairOf(token)).balanceOf(DEAD);
        r.spent = deepen.totalUsdcSpent(token);
        r.burned = deepen.totalTokensBurned(token);
        r.added = deepen.totalUsdcAdded(token);
        r.locked = deepen.totalLiquidityLocked(token);
    }

    /// @dev The Uniswap V2 router's optimal amounts at the pool's reserves after the buy, and the LaunchPair mint
    ///      formula: what the run's add must be, written from the spec.
    function _addAmounts(uint256 tokens, uint256 usdcLeft, uint256 reserveToken, uint256 reserveUsdc, uint256 supply)
        internal
        pure
        returns (uint256 tokenAmount, uint256 usdcAmount, uint256 liquidity)
    {
        if (tokens == 0 || usdcLeft == 0) return (0, 0, 0);
        usdcAmount = tokens * reserveUsdc / reserveToken;
        if (usdcAmount <= usdcLeft) tokenAmount = tokens;
        else (tokenAmount, usdcAmount) = (usdcLeft * reserveToken / reserveUsdc, usdcLeft);
        liquidity = Math.min(tokenAmount * supply / reserveToken, usdcAmount * supply / reserveUsdc);
        if (liquidity == 0) return (0, 0, 0);
    }

    /// @dev deepen.run(token) by a keeper, with every check: the trade and its fees, the burn, the add, the LP locked
    ///      at the burn address, the pool's reserves, the books and that the plugin keeps nothing.
    function _runDeepen(address token) internal returns (uint256 spent, uint256 burned, uint256 liquidity) {
        (Exp memory e, DeepenExp memory d, DeepenSnap memory r) = _deepenExpectation(token);
        Snap memory s = _snap(address(deepen), token);
        if (d.graduated) _expectPoolTrade(token, address(deepen), true, e);
        else _expectCurveTrade(token, address(deepen), true, e);
        vm.expectEmit(true, true, false, true, address(deepen));
        emit IDeepenPoolPlugin.DeepenRun(
            token, keeper, d.graduated, d.spent, d.usdcAdded, e.tokens, d.tokensAdded, d.tokensBurned, d.liquidity
        );
        vm.prank(keeper);
        (spent, burned, liquidity) = deepen.run(token);

        assertEq(spent, d.spent, "run spent");
        assertEq(burned, d.tokensBurned, "run burned");
        assertEq(liquidity, d.liquidity, "run liquidity");
        assertLe(spent, d.offer, "a run spends at most what it offers");
        if (d.graduated) {
            assertLe(d.offer - spent, 4, "in the pool only the split's rounding stays held");
        } else if (!e.graduates) {
            assertEq(spent, d.offer, "on the curve the whole offer buys");
        }
        assertLe(r.budget, r.cap, "never more than 0.25% of the USDC-side reserve");
        assertEq(IERC20(token).totalSupply(), r.supply - burned, "a true burn: total supply falls");
        assertEq(IERC20(token).balanceOf(address(deepen)), 0, "the plugin keeps no tokens");
        assertEq(deepen.usdcHeld(token), r.held - spent, "held falls by the spend");
        assertEq(r.usdc - usdc.balanceOf(address(deepen)), spent, "exactly the spend left the plugin");
        assertEq(deepen.totalUsdcSpent(token) - r.spent, spent);
        assertEq(deepen.totalTokensBurned(token) - r.burned, burned);
        assertEq(deepen.totalUsdcAdded(token) - r.added, d.usdcAdded);
        assertEq(deepen.totalLiquidityLocked(token) - r.locked, liquidity);
        assertEq(usdc.allowance(address(deepen), address(pad)), 0, "no allowance left to the launchpad");
        assertEq(usdc.allowance(address(deepen), address(router)), 0, "no allowance left to the router");
        assertEq(deepen.nextRunBlock(token), vm.getBlockNumber() + 1, "once per block");
        assertEq(deepen.lastRunAt(token), _now(), "the pacing clock restarts");
        _assertAccrued(s, token, e, "the deepen run's own trade");

        LaunchPair pair = _pairOf(token);
        assertEq(pair.balanceOf(address(deepen)), 0, "the plugin keeps no LP");
        if (d.graduated) {
            (uint256 rt, uint256 ru) = _reserves(token);
            assertEq(rt, r.reserveToken - e.tokens + d.tokensAdded, "tokens out, tokens back in");
            assertEq(ru, r.reserveUsdc + e.net + d.usdcAdded, "net buy + add");
            assertGe(rt * ru, r.reserveToken * r.reserveUsdc, "k never falls");
            assertEq(pair.totalSupply(), r.lpSupply + liquidity, "LP minted only for the add");
            assertEq(pair.balanceOf(DEAD), r.lpDead + liquidity, "and locked at the burn address");
            assertEq(usdc.balanceOf(address(pair)), ru, "nothing left in the pair to skim");
            assertEq(IERC20(token).balanceOf(address(pair)), rt);
        } else {
            assertEq(liquidity, 0, "no liquidity on the curve");
            assertEq(burned, e.tokens, "on the curve everything bought is burned");
            if (e.graduates) _assertGraduated(token, r.seed);
        }
        _assertDeepenBooks();
    }

    /// @dev Runs if there is anything to run; returns what it spent.
    function _runDeepenIfAny(address token) internal returns (uint256 spent) {
        (uint256 offered,) = deepen.previewRun(token);
        if (offered == 0) return 0;
        (spent,,) = _runDeepen(token);
    }

    // ─── Books ────────────────────────────────────────────────────────────────

    /// @dev The plugin's USDC is exactly what it holds for its tokens, each token's ledger balances, and it keeps no
    ///      token and no LP.
    function _assertDeepenBooks() internal view {
        uint256 sum;
        for (uint256 i; i < deepenTokens.length; ++i) {
            address t = deepenTokens[i];
            sum += deepen.usdcHeld(t);
            assertEq(
                deepen.usdcHeld(t) + deepen.totalUsdcSpent(t),
                ghostDeepenCredited[t],
                "held + spent == everything credited"
            );
            assertEq(IERC20(t).balanceOf(address(deepen)), 0, "the plugin holds no tokens");
            assertEq(_pairOf(t).balanceOf(address(deepen)), 0, "the plugin holds no LP");
        }
        assertEq(usdc.balanceOf(address(deepen)), sum, "Deepen USDC == its per-token balances");
    }

    function _assertDeepenSystem() internal view {
        _assertDeepenBooks();
        _assertSystem();
    }
}
