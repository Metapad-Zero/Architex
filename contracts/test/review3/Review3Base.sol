// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {ILaunchRouter} from "../../interfaces/ILaunchRouter.sol";
import {IArchitexLaunchpad} from "../../interfaces/IArchitexLaunchpad.sol";
import {ILaunchTokenExtensions} from "../../interfaces/ILaunchTokenExtensions.sol";
import {DeepenReviewBase} from "../review2/DeepenReviewBase.sol";

/// @dev One attacker action. Every amount is in raw units (USDC 6 decimals, tokens 18).
enum Op {
    Buy, // a = gross USDC into a router buy
    SellAll, // sell every token held through the router
    SellTokens, // a = tokens to sell through the router
    ParkAll, // add every token held plus the matching USDC as liquidity, LP to self
    ParkUsdc, // a = USDC side; the matching tokens come from the attacker's balance; LP to self
    Unpark, // burn every LP held
    GiftLpBps, // a = bps of the attacker's LP sent to 0x…dEaD
    MintToDeadTokens, // a = tokens (plus the matching USDC) deposited and minted straight to 0x…dEaD
    MintToDeadUsdc, // a = USDC (plus the matching tokens) deposited and minted straight to 0x…dEaD
    DonateUsdc, // a = USDC transferred into the pair
    DonateTokens, // a = tokens transferred into the pair
    Sync,
    Skim,
    Run, // a = plugin address; b != 0 tolerates a revert
    Sweep, // launchpad.collectCreatorFees(token)
    MintRaw, // a = USDC, b = tokens transferred into the pair, then mint to self (any ratio)
    BurnTokens, // a = tokens burned
    CurveBuy // a = gross USDC into a launchpad (curve) buy
}

struct Step {
    Op op;
    address token;
    uint256 a;
    uint256 b;
}

/// @dev What one program did with the attacker's USDC, fee by fee.
struct Ledger {
    uint256 usdcStart;
    uint256 usdcEnd;
    uint256 peakOut; // most USDC out of the attacker's wallet at once
    uint256 buyGross;
    uint256 sellGross;
    uint256 feesPlatform;
    uint256 feesCreator;
    uint256 gifted; // USDC donated into a pair or deposited as LP minted to 0x…dEaD
    uint256 potSpent; // sum over every Run of the pot the plugin spent
}

/// @notice The review-3 attacker: executes a list of Steps in ONE transaction and keeps a ledger. It can hold USDC,
///         tokens and LP of any launch pool; `flat` says whether it ended holding nothing but USDC.
contract R3Attacker {
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IArchitexLaunchpad public immutable pad;
    ILaunchRouter public immutable router;
    IERC20 public immutable usdc;

    Ledger internal _l;

    constructor(address pad_, address router_, address usdc_) {
        pad = IArchitexLaunchpad(pad_);
        router = ILaunchRouter(router_);
        usdc = IERC20(usdc_);
        IERC20(usdc_).approve(router_, type(uint256).max);
        IERC20(usdc_).approve(pad_, type(uint256).max);
    }

    function ledger() external view returns (Ledger memory) {
        return _l;
    }

    function flat(address token) external view returns (bool) {
        address pair = pad.pairOf(token);
        return IERC20(token).balanceOf(address(this)) == 0 && IERC20(pair).balanceOf(address(this)) == 0;
    }

    function exec(Step[] calldata steps) external returns (int256 pnl) {
        delete _l;
        _l.usdcStart = usdc.balanceOf(address(this));
        for (uint256 i; i < steps.length; ++i) {
            _do(steps[i]);
            _low();
        }
        _l.usdcEnd = usdc.balanceOf(address(this));
        pnl = int256(_l.usdcEnd) - int256(_l.usdcStart);
    }

    function _low() internal {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 out = _l.usdcStart > bal ? _l.usdcStart - bal : 0;
        if (out > _l.peakOut) _l.peakOut = out;
    }

    function _do(Step calldata s) internal {
        Op op = s.op;
        if (op == Op.Buy) _buy(s.token, s.a);
        else if (op == Op.SellAll) _sell(s.token, IERC20(s.token).balanceOf(address(this)));
        else if (op == Op.SellTokens) _sell(s.token, s.a);
        else if (op == Op.ParkAll) _park(s.token, IERC20(s.token).balanceOf(address(this)), address(this));
        else if (op == Op.ParkUsdc) _parkUsdc(s.token, s.a, address(this));
        else if (op == Op.Unpark) _unpark(s.token);
        else if (op == Op.GiftLpBps) _giftLp(s.token, s.a);
        else if (op == Op.MintToDeadTokens) _park(s.token, s.a, DEAD);
        else if (op == Op.MintToDeadUsdc) _parkUsdc(s.token, s.a, DEAD);
        else if (op == Op.DonateUsdc) _donateUsdc(s.token, s.a);
        else if (op == Op.DonateTokens) IERC20(s.token).transfer(pad.pairOf(s.token), s.a);
        else if (op == Op.Sync) ILaunchPair(pad.pairOf(s.token)).sync();
        else if (op == Op.Skim) ILaunchPair(pad.pairOf(s.token)).skim(address(this));
        else if (op == Op.Run) _run(s.token, address(uint160(s.a)), s.b != 0);
        else if (op == Op.Sweep) pad.collectCreatorFees(s.token);
        else if (op == Op.MintRaw) _mintRaw(s.token, s.a, s.b);
        else if (op == Op.BurnTokens) ILaunchTokenExtensions(s.token).burn(s.a);
        else if (op == Op.CurveBuy) pad.buy(s.token, s.a, 0, address(this), block.timestamp);
    }

    function _buy(address token, uint256 usdcIn) internal {
        (, uint256 pf, uint256 cf) = router.quoteBuy(token, usdcIn);
        router.buy(token, usdcIn, 0, address(this), block.timestamp);
        _l.buyGross += usdcIn;
        _l.feesPlatform += pf;
        _l.feesCreator += cf;
    }

    /// @dev Dust the router refuses (fees would eat it) is left unsold and counted as worth nothing.
    function _sell(address token, uint256 amount) internal {
        if (amount == 0) return;
        try router.quoteSell(token, amount) returns (uint256 out, uint256 pf, uint256 cf) {
            router.sell(token, amount, 0, address(this), block.timestamp);
            _l.sellGross += out + pf + cf;
            _l.feesPlatform += pf;
            _l.feesCreator += cf;
        } catch {}
    }

    function _park(address token, uint256 tokens, address to) internal {
        if (tokens == 0) return;
        address pair = pad.pairOf(token);
        (uint112 rT, uint112 rU,) = ILaunchPair(pair).getReserves();
        uint256 need = Math.mulDiv(tokens, rU, rT, Math.Rounding.Ceil);
        IERC20(token).transfer(pair, tokens);
        usdc.transfer(pair, need);
        ILaunchPair(pair).mint(to);
        if (to == DEAD) _l.gifted += need;
    }

    function _parkUsdc(address token, uint256 usdcSide, address to) internal {
        address pair = pad.pairOf(token);
        (uint112 rT, uint112 rU,) = ILaunchPair(pair).getReserves();
        uint256 tokens = Math.mulDiv(usdcSide, rT, rU, Math.Rounding.Ceil);
        IERC20(token).transfer(pair, tokens);
        usdc.transfer(pair, usdcSide);
        ILaunchPair(pair).mint(to);
        if (to == DEAD) _l.gifted += usdcSide;
    }

    function _unpark(address token) internal {
        address pair = pad.pairOf(token);
        uint256 lp = IERC20(pair).balanceOf(address(this));
        if (lp == 0) return;
        IERC20(pair).transfer(pair, lp);
        ILaunchPair(pair).burn(address(this));
    }

    function _giftLp(address token, uint256 bps) internal {
        address pair = pad.pairOf(token);
        uint256 lp = IERC20(pair).balanceOf(address(this)) * bps / 10_000;
        if (lp != 0) IERC20(pair).transfer(DEAD, lp);
    }

    function _donateUsdc(address token, uint256 amount) internal {
        usdc.transfer(pad.pairOf(token), amount);
        _l.gifted += amount;
    }

    function _mintRaw(address token, uint256 usdcIn, uint256 tokensIn) internal {
        address pair = pad.pairOf(token);
        if (tokensIn != 0) IERC20(token).transfer(pair, tokensIn);
        if (usdcIn != 0) usdc.transfer(pair, usdcIn);
        ILaunchPair(pair).mint(address(this));
    }

    function _run(address token, address plugin, bool tolerate) internal {
        uint256 h0 = _held(plugin, token);
        (bool ok, bytes memory err) = plugin.call(abi.encodeWithSignature("run(address)", token));
        if (!ok) {
            if (tolerate) return;
            assembly {
                revert(add(err, 32), mload(err))
            }
        }
        uint256 h1 = _held(plugin, token);
        if (h0 > h1) _l.potSpent += h0 - h1;
    }

    function _held(address plugin, address token) internal view returns (uint256 h) {
        (bool ok, bytes memory ret) = plugin.staticcall(abi.encodeWithSignature("usdcHeld(address)", token));
        if (ok && ret.length >= 32) h = abi.decode(ret, (uint256));
    }
}

/// @notice Shared fixture for the review-3 probes of Deepen pool at commit 25dcb73 (the H1 fix).
abstract contract Review3Base is DeepenReviewBase {
    uint256 internal constant ATTACKER_USDC = 10_000_000_000e6; // 10 billion: flash liquidity stand-in

    R3Attacker internal atk;
    Step[] internal _prog;

    enum Pool {
        Fresh, // as graduation left it: 25,000 USDC x 200M tokens, all LP at 0x…dEaD
        Shrunk, // holders sold 600M tokens back: USDC side ~6,250
        Grown, // a buyer put ~75,000 USDC in: USDC side ~100,000
        Crowded // an outside LP added twice the pool: the locked part is a third of the reserve
    }

    function _newAttacker() internal returns (R3Attacker a) {
        a = new R3Attacker(address(pad), address(router), address(usdc));
        usdc.mint(address(a), ATTACKER_USDC);
    }

    // ─── Programs ────────────────────────────────────────────────────────────

    function _clear() internal {
        delete _prog;
    }

    function _add(Op op, address token, uint256 a) internal {
        _prog.push(Step(op, token, a, 0));
    }

    function _add(Op op, address token, uint256 a, uint256 b) internal {
        _prog.push(Step(op, token, a, b));
    }

    function _runOp(address token, address plugin) internal {
        _prog.push(Step(Op.Run, token, uint256(uint160(plugin)), 0));
    }

    /// @dev Executes the current program on a snapshot and rolls the chain back: P&L and the ledger.
    function _try() internal returns (int256 pnl, Ledger memory l) {
        uint256 snap = vm.snapshotState();
        pnl = atk.exec(_prog);
        l = atk.ledger();
        vm.revertToState(snap);
    }

    /// @dev The same, but a program that cannot execute (not enough tokens or capital for it) reports ok = false.
    function _tryOk() internal returns (bool ok, int256 pnl, Ledger memory l) {
        uint256 snap = vm.snapshotState();
        try atk.exec(_prog) returns (int256 p) {
            (ok, pnl, l) = (true, p, atk.ledger());
        } catch {}
        vm.revertToState(snap);
    }

    /// @dev The classic program: [sweep], push, [park], run, [unpark], sell everything.
    function _pushParkProgram(address token, address plugin, uint256 push, bool park, bool sweep) internal {
        _clear();
        if (sweep) _add(Op.Sweep, token, 0);
        if (push != 0) _add(Op.Buy, token, push);
        if (park) _add(Op.ParkAll, token, 0);
        _runOp(token, plugin);
        if (park) _add(Op.Unpark, token, 0);
        _add(Op.SellAll, token, 0);
    }

    // ─── Pools ───────────────────────────────────────────────────────────────

    /// @dev Reshapes a freshly graduated pool. bob holds the 800M tokens the curve sold.
    function _shape(address token, Pool p) internal {
        if (p == Pool.Shrunk) {
            vm.prank(bob);
            router.sell(token, 600_000_000e18, 0, bob, block.timestamp);
        } else if (p == Pool.Grown) {
            vm.prank(carol);
            router.buy(token, 75_000e6, 0, carol, block.timestamp);
        } else if (p == Pool.Crowded) {
            vm.prank(bob);
            IERC20(token).transfer(lp, 400_000_000e18);
            (, uint256 rU) = _reserves(token);
            _addLiquidity(token, lp, rU * 2);
        }
    }

    function _lockedPart(address token) internal view returns (uint256) {
        address pair = pad.pairOf(token);
        (, uint256 rU) = _reserves(token);
        return Math.mulDiv(rU, IERC20(pair).balanceOf(DEAD), IERC20(pair).totalSupply());
    }

    function _poolName(Pool p) internal pure returns (string memory) {
        if (p == Pool.Fresh) return "fresh";
        if (p == Pool.Shrunk) return "shrunk";
        if (p == Pool.Grown) return "grown";
        return "crowded";
    }

    function _logLedger(string memory label, Ledger memory l, int256 pnl) internal {
        emit log(label);
        emit log_named_uint("    pot spent by the run(s) ", l.potSpent);
        emit log_named_uint("    router buys (gross)     ", l.buyGross);
        emit log_named_uint("    router sells (gross)    ", l.sellGross);
        emit log_named_uint("    fees: platform          ", l.feesPlatform);
        emit log_named_uint("    fees: creator           ", l.feesCreator);
        emit log_named_uint("    gifted to the pool/dEaD ", l.gifted);
        emit log_named_uint("    peak capital            ", l.peakOut);
        emit log_named_int("    NET P&L (USDC)          ", pnl);
    }
}
