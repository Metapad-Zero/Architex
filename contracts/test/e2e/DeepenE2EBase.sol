// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./E2EBase.sol";
import {IDeepenPoolPlugin} from "../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {DeepenPoolPlugin} from "../../plugins/launch/DeepenPoolPlugin.sol";

// ═══════════════════════════════════════════════════════════════════════════════
// Deepen pool against the REAL launchpad, launch tokens, launch pairs and launch router (E2EBase's fixture, with the
// reference plugins alongside). Every run helper recomputes what the run must do from the spec formulas and the pool's
// own state, side by side: the burn side's buy, then the deepen side's buy at the reserves that buy leaves, then the
// add. Both trades are checked like any other trade, and the plugin must end the call with no token, no LP, no
// allowance and books that match its USDC.
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

    /// @dev A token whose creator fees go to Deepen pool with the default burn share (empty configuration data).
    function _launchDeepen(uint16 bps) internal returns (address token) {
        return _launchDeepen(bps, "", 0);
    }

    function _launchDeepen(uint16 bps, uint256 initialBuy) internal returns (address token) {
        return _launchDeepen(bps, "", initialBuy);
    }

    /// @dev The same with an explicit burn share.
    function _launchDeepenBurning(uint16 bps, uint16 burnBps) internal returns (address token) {
        return _launchDeepen(bps, abi.encode(burnBps), 0);
    }

    function _launchDeepen(uint16 bps, bytes memory data, uint256 initialBuy) internal returns (address token) {
        token = _launchWith(alice, bps, address(deepen), data, initialBuy);
        deepenTokens.push(token);
        assertTrue(deepen.isConfigured(token), "configured at launch");
        assertEq(
            deepen.burnBpsOf(token),
            data.length == 0 ? deepen.DEFAULT_BURN_BPS() : abi.decode(data, (uint16)),
            "the burn share the creator asked for"
        );
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
        uint256 usdcToBurn; // the burn side's buy
        uint256 usdcToBuy; // the deepen side's buy
        uint256 tokensBought; // both sides
        uint256 tokensAdded;
        uint256 usdcAdded;
        uint256 liquidity;
        uint256 tokensBurned;
        uint256 spent;
        uint256 reserveToken; // the pool after the run
        uint256 reserveUsdc;
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
        uint256 burning;
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

    /// @dev The dust rule of V13-SPEC §2.3, written out: `burnBps` of the offer burns, the rest deepens, and a side
    ///      under MIN_RUN_USDC gives way to the other (the burn side first).
    function _sidesRef(uint256 offer, uint256 burnBps) internal pure returns (uint256 toBurn, uint256 toDeepen) {
        toBurn = offer * burnBps / BPS;
        toDeepen = offer - toBurn;
        if (toBurn < MIN_RUN_USDC) (toBurn, toDeepen) = (0, offer);
        else if (toDeepen < MIN_RUN_USDC) (toBurn, toDeepen) = (offer, 0);
    }

    /// @dev The launch router's exact-in buy at given reserves (V13-SPEC §4): both fees rounded up on the USDC in.
    function _expPoolBuyAt(uint256 rt, uint256 ru, uint256 usdcIn, uint256 bps)
        internal
        pure
        returns (uint256 tokensOut, uint256 platformFee, uint256 creatorFee, uint256 net)
    {
        platformFee = _divCeil(usdcIn * FEE_BPS, BPS);
        creatorFee = _divCeil(usdcIn * bps, BPS);
        net = usdcIn - platformFee - creatorFee;
        tokensOut = net * rt / (ru + net);
    }

    /// @dev The Uniswap V2 router's optimal amounts at the pool's reserves after the deepen buy, and the LaunchPair
    ///      mint formula: what the run's add must be, written from the spec.
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

    /// @dev The run's trades (an Exp for each side, checked like any other trade) and what it then does with the
    ///      tokens. The burn side buys first, so the deepen side's split and add are computed at the reserves it
    ///      leaves.
    function _deepenExpectation(address token)
        internal
        view
        returns (Exp memory burnSide, Exp memory buySide, DeepenExp memory d, DeepenSnap memory r)
    {
        d.graduated = pad.isGraduated(token);
        r.held = deepen.usdcHeld(token);
        (r.cap, r.budget) = _deepenBudget(token);
        d.offer = r.held < r.budget ? r.held : r.budget;
        assertGe(d.offer, MIN_RUN_USDC, "a run needs at least MIN_RUN_USDC on offer");
        (uint256 pOffer, uint256 pBurn, uint256 pDeepen, bool pGrad) = deepen.previewRun(token);
        assertEq(pOffer, d.offer, "previewRun = min(held, budget)");
        assertEq(pGrad, d.graduated);
        (uint256 refBurn, uint256 refDeepen) = _sidesRef(d.offer, deepen.burnBpsOf(token));
        if (d.graduated) {
            assertEq(pBurn, refBurn, "the burn side follows burnBps and the dust rule");
            assertEq(pDeepen, refDeepen);
        } else {
            assertEq(pBurn, d.offer, "on the curve the whole offer burns");
            assertEq(pDeepen, 0);
        }

        (r.reserveToken, r.reserveUsdc) = _reserves(token);
        if (d.graduated) {
            // The run syncs the pair first; these expectations assume nothing is waiting to be synced (no test here
            // donates into a pair before a run, and DeepenPoolInvariant.t.sol covers the case that does).
            assertEq(usdc.balanceOf(pad.pairOf(token)), r.reserveUsdc, "the pair is synced");
            assertEq(IERC20(token).balanceOf(pad.pairOf(token)), r.reserveToken, "the pair is synced");
            (uint256 splitBurn, uint256 splitBuy, uint256 splitAdd) = deepen.previewSplit(token, d.offer);
            assertEq(splitBurn + splitBuy + splitAdd, d.offer, "the split covers the offer");
            assertEq(splitBurn, refBurn);
            d.usdcToBurn = splitBurn;
            d.usdcToBuy = splitBuy;
            uint256 rt = r.reserveToken;
            uint256 ru = r.reserveUsdc;
            uint256 bps = pad.creatorFeeBpsOf(token);
            if (splitBurn != 0) {
                (burnSide.tokens, burnSide.platform, burnSide.creator, burnSide.net) =
                    _expPoolBuyAt(rt, ru, splitBurn, bps);
                burnSide.gross = splitBurn;
                (rt, ru) = (rt - burnSide.tokens, ru + burnSide.net);
                d.tokensBought += burnSide.tokens;
                d.spent += splitBurn;
            }
            if (splitBuy != 0) {
                (buySide.tokens, buySide.platform, buySide.creator, buySide.net) = _expPoolBuyAt(rt, ru, splitBuy, bps);
                buySide.gross = splitBuy;
                (rt, ru) = (rt - buySide.tokens, ru + buySide.net);
                d.tokensBought += buySide.tokens;
                d.spent += splitBuy;
                (d.tokensAdded, d.usdcAdded, d.liquidity) =
                    _addAmounts(buySide.tokens, splitAdd, rt, ru, ILaunchPair(pad.pairOf(token)).totalSupply());
                d.spent += d.usdcAdded;
                (rt, ru) = (rt + d.tokensAdded, ru + d.usdcAdded);
            }
            d.tokensBurned = d.tokensBought - d.tokensAdded;
            (d.reserveToken, d.reserveUsdc) = (rt, ru);
        } else {
            (burnSide.tokens, burnSide.platform, burnSide.creator, burnSide.gross, burnSide.graduates) =
                _expCurveBuy(token, d.offer);
            burnSide.net = burnSide.gross - burnSide.platform - burnSide.creator;
            r.seed = pad.virtualUsdcOf(token) + burnSide.net - VIRTUAL_USDC_0;
            d.tokensBought = burnSide.tokens;
            d.tokensBurned = burnSide.tokens;
            d.usdcToBurn = burnSide.gross;
            d.spent = burnSide.gross;
        }
        r.supply = IERC20(token).totalSupply();
        r.usdc = usdc.balanceOf(address(deepen));
        r.lpSupply = ILaunchPair(pad.pairOf(token)).totalSupply();
        r.lpDead = ILaunchPair(pad.pairOf(token)).balanceOf(DEAD);
        r.spent = deepen.totalUsdcSpent(token);
        r.burned = deepen.totalTokensBurned(token);
        r.burning = deepen.totalUsdcBurning(token);
        r.added = deepen.totalUsdcAdded(token);
        r.locked = deepen.totalLiquidityLocked(token);
    }

    /// @dev deepen.run(token) by a keeper, with every check: both trades and their fees, the burn, the add, the LP
    ///      locked at the burn address, the pool's reserves, the books and that the plugin keeps nothing.
    function _runDeepen(address token) internal returns (uint256 spent, uint256 burned, uint256 liquidity) {
        (Exp memory burnSide, Exp memory buySide, DeepenExp memory d, DeepenSnap memory r) = _deepenExpectation(token);
        Snap memory s = _snap(address(deepen), token);
        if (d.graduated) {
            if (d.usdcToBurn != 0) _expectPoolTrade(token, address(deepen), true, burnSide);
            if (d.usdcToBuy != 0) _expectPoolTrade(token, address(deepen), true, buySide);
        } else {
            _expectCurveTrade(token, address(deepen), true, burnSide);
        }
        vm.expectEmit(true, true, false, true, address(deepen));
        emit IDeepenPoolPlugin.DeepenRun(
            token,
            keeper,
            d.graduated,
            d.spent,
            d.usdcToBurn,
            d.usdcAdded,
            d.tokensBought,
            d.tokensAdded,
            d.tokensBurned,
            d.liquidity
        );
        vm.prank(keeper);
        (spent, burned, liquidity) = deepen.run(token);

        assertEq(spent, d.spent, "run spent");
        assertEq(burned, d.tokensBurned, "run burned");
        assertEq(liquidity, d.liquidity, "run liquidity");
        assertLe(spent, d.offer, "a run spends at most what it offers");
        if (d.graduated) {
            assertLe(d.offer - spent, 4, "in the pool only the split's rounding stays held");
        } else if (!burnSide.graduates) {
            assertEq(spent, d.offer, "on the curve the whole offer buys");
        }
        assertLe(r.budget, r.cap, "never more than 0.25% of the USDC-side reserve");
        assertEq(IERC20(token).totalSupply(), r.supply - burned, "a true burn: total supply falls");
        assertEq(IERC20(token).balanceOf(address(deepen)), 0, "the plugin keeps no tokens");
        assertEq(deepen.usdcHeld(token), r.held - spent, "held falls by the spend");
        assertEq(r.usdc - usdc.balanceOf(address(deepen)), spent, "exactly the spend left the plugin");
        assertEq(deepen.totalUsdcSpent(token) - r.spent, spent);
        assertEq(deepen.totalTokensBurned(token) - r.burned, burned);
        assertEq(deepen.totalUsdcBurning(token) - r.burning, d.usdcToBurn);
        assertEq(deepen.totalUsdcAdded(token) - r.added, d.usdcAdded);
        assertEq(deepen.totalLiquidityLocked(token) - r.locked, liquidity);
        assertEq(usdc.allowance(address(deepen), address(pad)), 0, "no allowance left to the launchpad");
        assertEq(usdc.allowance(address(deepen), address(router)), 0, "no allowance left to the router");
        assertEq(deepen.nextRunBlock(token), vm.getBlockNumber() + 1, "once per block");
        assertEq(deepen.lastRunAt(token), _now(), "the pacing clock restarts");
        // Both sides' fees accrued exactly, to this token.
        Exp memory both;
        both.platform = burnSide.platform + buySide.platform;
        both.creator = burnSide.creator + buySide.creator;
        _assertAccrued(s, token, both, "the deepen run's own trades");

        LaunchPair pair = _pairOf(token);
        assertEq(pair.balanceOf(address(deepen)), 0, "the plugin keeps no LP");
        if (d.graduated) {
            (uint256 rt, uint256 ru) = _reserves(token);
            assertEq(rt, d.reserveToken, "the pool's token side: out for both buys, back in for the add");
            assertEq(ru, d.reserveUsdc, "the pool's USDC side: both nets plus the add");
            assertGe(rt * ru, r.reserveToken * r.reserveUsdc, "k never falls");
            assertEq(pair.totalSupply(), r.lpSupply + liquidity, "LP minted only for the add");
            assertEq(pair.balanceOf(DEAD), r.lpDead + liquidity, "and locked at the burn address");
            assertEq(usdc.balanceOf(address(pair)), ru, "nothing left in the pair to skim");
            assertEq(IERC20(token).balanceOf(address(pair)), rt);
        } else {
            assertEq(liquidity, 0, "no liquidity on the curve");
            assertEq(burned, burnSide.tokens, "on the curve everything bought is burned");
            if (burnSide.graduates) _assertGraduated(token, r.seed);
        }
        _assertDeepenBooks();
    }

    /// @dev Runs if there is anything to run; returns what it spent.
    function _runDeepenIfAny(address token) internal returns (uint256 spent) {
        (uint256 offered,,,) = deepen.previewRun(token);
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
