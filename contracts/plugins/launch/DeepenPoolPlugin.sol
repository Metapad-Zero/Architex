// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IArchitexFeePlugin} from "../../interfaces/IArchitexFeePlugin.sol";
import {ILaunchPair} from "../../interfaces/ILaunchPair.sol";
import {ILaunchRouter} from "../../interfaces/ILaunchRouter.sol";
import {ILaunchTokenExtensions} from "../../interfaces/ILaunchTokenExtensions.sol";
import {ILaunchFeePlugin} from "../../interfaces/plugins/ILaunchFeePlugin.sol";
import {IDeepenPoolPlugin} from "../../interfaces/plugins/IDeepenPoolPlugin.sol";
import {LaunchFeePluginBase} from "./LaunchFeePluginBase.sol";

/// @title DeepenPoolPlugin
/// @notice "A launch pool that burns the entire way, past the curve and everything" (V13-SPEC §2.3). Each launch
///         token's creator fees, and anything anyone else delivers for it, are spent in paced runs that anyone can
///         call. On the curve a run is Buyback & burn's: buy the token through the launchpad and burn it. After
///         graduation a run splits its offer by the token's `burnBps` (set once at launch, 5,000 by default): that
///         share buys the token through the launch router and burns it, and the rest buys the token and adds it, with
///         the USDC left, to the token's launch pool, minting the LP straight to 0x…dEaD, locked forever. Everything
///         the add does not take is burned. The plugin keeps no token and no LP between calls.
///
///         Both sides share ONE paced budget and one clock: a run offers min(held, budget), the budget being 0.25% of
///         the curve's virtual USDC, or after graduation of the LOCKED part of the pool's USDC reserve (the share owned
///         by LP at 0x…dEaD; see Security), prorated by the time since the token's last run (a full cap for its first
///         run), at most once per token per block, never below MIN_RUN_USDC. That is the point of doing both here: two
///         paced plugins on one token would spend twice as fast and halve the front-running protection.
///
/// @dev The add (IDeepenPoolPlugin has the split formula and the bound table). With the pool's reserves (T, R) after
///      the burn side's buy and q = 10,000 - fee bps, a buy of b puts n = b*q/1e4 USDC in and takes t = n*T/(R+n)
///      tokens out, leaving (T - t, R + n). Those t tokens pair at that price with t*(R+n)/(T-t) = n*(R+n)/R USDC, so
///      the add takes all of them exactly when b + n + n^2/R = U_deepen, a quadratic in b whose root, rationalised to
///      avoid cancellation, is _usdcToBuy. The fees' rounding up (and the floors) leave the real add a few units off
///      that, so the add is computed afresh from the pool's reserves after that buy (the Uniswap V2 router's optimal
///      amounts) and any excess is burned (tokens) or kept for the next run (USDC).
///
///      Security (V13-SPEC §2.3 has the numbers):
///      - One budget for both jobs. Burning raises the price about twice as fast per USDC as deepening does (a burn
///        takes tokens out of the pool and leaves the USDC in; a deepen run gives every token it buys back), so the
///        front-running bound falls from about (2 * (0.5% + c) / 0.25% - 1) hours at burnBps = 0 to Buyback & burn's
///        ((0.5% + c) / 0.25% - 1) at 10,000, and sits in between for a mix. A Combo holding this plugin and
///        Buyback & burn would pace them separately and halve that; the burn share makes the pairing pointless.
///      - A donation into the pair. LaunchPair.swap sets the reserves to the balances, so anything donated into the
///        pair and not yet synced would be folded in by a run's own buy, between the split's reading of the pool and
///        the add's. The run syncs the pair first instead, which only recognises what the pair already holds (a gift to
///        every LP, as it would be anyway), and keeps the split honest. The budget is still taken from the reserves as
///        previewRun read them, so previewRun and run always offer the same.
///      - Transfer then mint. LaunchPair.mint credits balances minus reserves, and anyone can skim a plain transfer
///        into a pair. The run's buys end in the pair's swap, which sets the reserves to the balances; the run then
///        transfers the tokens, transfers the USDC and mints, in one call, with no external call in between but those
///        two transfers (a LaunchToken and USDC, neither calls out). So the mint sees exactly the run's own deposit,
///        and the plugin checks the LP it got against its own computation of the pair's formula (LiquidityMismatch).
///      - Sandwiching the add. A trader who pushes the price before a run makes the run buy and add at the pushed
///        price. But the deepen side returns every token it buys, so the pool's token reserve only moves by the burn
///        side: the trader keeps the run's price rise (at most about 0.5% for a full cap, all of it burning) against a
///        round trip costing 2 * (0.5% + c). One run never pays, at any size, and holding through runs pays only after
///        the documented hours.
///      - Anyone may add or remove liquidity, and LaunchPair charges nothing for either, so the pool's USDC reserve
///        is anyone's to inflate for the length of one transaction. The budget therefore never reads it whole: in the
///        pool the cap is 0.25% of the locked part, reserve * LP at 0x…dEaD / LP supply, where 0x…dEaD holds
///        graduation's LP, MINIMUM_LIQUIDITY and every add this plugin makes, none of which can ever leave. Adding or
///        removing liquidity at the pool's price leaves that part where it is. (Round-5 review, H1: with the whole
///        reserve as the base, pushing the price, parking the bag as liquidity and running spent a 200,000 USDC pot
///        at a price pushed about 3,200x, for +153,000 USDC net, in one transaction.) A push still moves the locked
///        part, by the square root of the price move: a push of b raises the cap by at most 0.25% of b, plus a unit.
///        What an attacker can take is the run's overpayment at the pushed price, about twice that for a small push,
///        while the push pays FEE_BPS (0.5%) going in and again coming out, so CAP_BPS must stay below FEE_BPS (a 2x
///        margin at a 0% creator fee). Liquidity other people add counts for nothing, so a crowded pool spends no
///        faster than its locked part allows. Dead's new LP is exactly the run's add; a large LP is the counterparty
///        to the run's buys, as to any buy. All of this assumes this plugin is the token's only buyer: a second
///        paced buyer that pays for the push (Buyback & burn v1 in a Combo) lets a run here ride it (V13-SPEC §9).
///      - The creator fee on the run's own buys goes back to the token's plugin: straight back into this pot, or,
///        through a Combo, partly to its other entries (the creator's wallet, say). A trader paid part of the creator
///        fee faces a smaller c, as with Buyback & burn.
///      - Reentrancy: every state-changing entry point is nonReentrant, and the only external callees are the
///        launchpad, its launch router, the token's launch pair, the token and USDC.
///      - Extraction: the pot leaves only through a run, into the launchpad (fees), the pair (the buys and the add)
///        and the token's burn. No owner, no admin, no sweep; LP only ever goes to 0x…dEaD.
contract DeepenPoolPlugin is IDeepenPoolPlugin, LaunchFeePluginBase {
    using SafeERC20 for IERC20;

    /// @inheritdoc IDeepenPoolPlugin
    uint256 public constant CAP_BPS = 25;
    /// @inheritdoc IDeepenPoolPlugin
    uint256 public constant RUN_INTERVAL = 1 hours;
    /// @inheritdoc IDeepenPoolPlugin
    uint256 public constant MIN_RUN_USDC = 3;
    /// @inheritdoc IDeepenPoolPlugin
    address public constant LP_RECIPIENT = 0x000000000000000000000000000000000000dEaD;
    /// @inheritdoc IDeepenPoolPlugin
    uint16 public constant DEFAULT_BURN_BPS = 5_000;
    uint256 private constant _BPS = 10_000;

    struct Deepen {
        uint256 held;
        uint256 totalSpent;
        uint256 totalBurned;
        uint256 totalUsdcBurning;
        uint256 totalUsdcAdded;
        uint256 totalTokensAdded;
        uint256 totalLiquidity;
        uint256 nextRunBlock;
        uint256 lastRunAt; // timestamp of the latest run, 0 if the token never ran
        uint16 burnBps; // the share of every pool run that buys the token and burns it; 0 until configured
    }

    /// @dev What one run does, decided before its last interactions (the add and the burn).
    struct Outcome {
        uint256 usdcSpent;
        uint256 usdcBurning; // what the burn side bought with
        uint256 usdcAdded;
        uint256 tokensBought;
        uint256 tokensAdded;
        uint256 tokensBurned;
        uint256 liquidity;
    }

    mapping(address token => Deepen) private _deepens;

    constructor(address launchpad_) LaunchFeePluginBase(launchpad_) {}

    // ─── Hooks ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexFeePlugin
    /// @dev `data` = abi.encode(uint16 burnBps), canonically encoded, 0 to 10,000; empty data means
    ///      DEFAULT_BURN_BPS. Write-once per token, like every listed plugin's configuration.
    function onLaunch(address token, address creator, bytes calldata data) external nonReentrant {
        uint16 burnBps = DEFAULT_BURN_BPS;
        if (data.length != 0) {
            burnBps = abi.decode(data, (uint16));
            if (keccak256(abi.encode(burnBps)) != keccak256(data)) revert NonCanonicalData();
            if (burnBps > _BPS) revert InvalidBurnBps(burnBps);
        }
        _configure(token, creator);
        _deepens[token].burnBps = burnBps;
        emit BurnShareSet(token, burnBps);
    }

    /// @inheritdoc IArchitexFeePlugin
    /// @dev Credits `token` and pulls exactly `amount` from the caller. Any caller: the launchpad's collection, a
    ///      Combo, or anyone topping the token's pot up (Architex's fee wallet, say). Zero is a no-op. Never buys here:
    ///      a collection runs inside the launchpad's non-reentrant collectCreatorFees, where a curve buy would revert.
    function onFees(address token, uint256 amount) external nonReentrant {
        _requireConfigured(token);
        if (amount == 0) return;
        _deepens[token].held += amount;
        emit FeesReceived(token, msg.sender, amount);
        _pullFees(amount);
    }

    // ─── Run ──────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeepenPoolPlugin
    /// @dev The pacing state (nextRunBlock, lastRunAt) is written before the buy; a run that reverts leaves it
    ///      untouched. The books are written after the buy, which is what reveals the spend (the curve's sell-out buy
    ///      takes less than offered), and before the add and the burn.
    function run(address token)
        external
        nonReentrant
        returns (uint256 usdcSpent, uint256 tokensBurned, uint256 liquidity)
    {
        _requireConfigured(token);
        Deepen storage deepen = _deepens[token];
        if (block.number < deepen.nextRunBlock) revert AlreadyRanThisBlock(token);

        bool graduated = LAUNCHPAD.isGraduated(token);
        (address pair, uint256 base) = _capBase(token, graduated);
        uint256 offer = Math.min(deepen.held, _budget(base, deepen.lastRunAt));
        // Below the minimum the rounded-up fees would eat the whole buy, and the launchpad or router would revert.
        if (offer < MIN_RUN_USDC) revert NothingToBuy(token);
        deepen.nextRunBlock = block.number + 1;
        deepen.lastRunAt = block.timestamp;

        Outcome memory o =
            graduated ? _runInPool(token, pair, offer, deepen.burnBps) : _buyOnCurve(token, offer);

        deepen.held -= o.usdcSpent; // usdcSpent <= offer <= held
        deepen.totalSpent += o.usdcSpent;
        if (o.tokensBurned != 0) deepen.totalBurned += o.tokensBurned;
        if (o.usdcBurning != 0) deepen.totalUsdcBurning += o.usdcBurning;
        if (o.liquidity != 0) {
            deepen.totalUsdcAdded += o.usdcAdded;
            deepen.totalTokensAdded += o.tokensAdded;
            deepen.totalLiquidity += o.liquidity;
        }
        emit DeepenRun(
            token,
            msg.sender,
            graduated,
            o.usdcSpent,
            o.usdcBurning,
            o.usdcAdded,
            o.tokensBought,
            o.tokensAdded,
            o.tokensBurned,
            o.liquidity
        );

        if (o.liquidity != 0) _addLiquidity(token, pair, o);
        if (o.tokensBurned != 0) ILaunchTokenExtensions(token).burn(o.tokensBurned);
        if (graduated) _lockStrayLiquidity(pair);
        return (o.usdcSpent, o.tokensBurned, o.liquidity);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IDeepenPoolPlugin
    function previewRun(address token)
        external
        view
        returns (uint256 usdcOffered, uint256 usdcToBurn, uint256 usdcToDeepen, bool graduated)
    {
        graduated = LAUNCHPAD.isGraduated(token);
        Deepen storage deepen = _deepens[token];
        if (!isConfigured(token) || deepen.held == 0 || block.number < deepen.nextRunBlock) {
            return (0, 0, 0, graduated);
        }
        (, uint256 base) = _capBase(token, graduated);
        usdcOffered = Math.min(deepen.held, _budget(base, deepen.lastRunAt));
        if (usdcOffered < MIN_RUN_USDC) return (0, 0, 0, graduated);
        // On the curve there is no pool to add to: the whole offer buys and burns, whatever the burn share.
        if (!graduated) return (usdcOffered, usdcOffered, 0, graduated);
        (usdcToBurn, usdcToDeepen) = _sides(usdcOffered, deepen.burnBps);
    }

    /// @inheritdoc IDeepenPoolPlugin
    function previewSplit(address token, uint256 usdcOffered)
        external
        view
        returns (uint256 usdcToBurn, uint256 usdcToBuy, uint256 usdcForLiquidity)
    {
        if (usdcOffered == 0) return (0, 0, 0);
        if (!LAUNCHPAD.isGraduated(token)) return (usdcOffered, 0, 0);
        (, uint256 reserve) = _pool(token);
        uint256 usdcToDeepen;
        (usdcToBurn, usdcToDeepen) = _sides(usdcOffered, _deepens[token].burnBps);
        if (usdcToDeepen == 0) return (usdcToBurn, 0, 0);
        if (usdcToBurn != 0) {
            // The burn side buys first, so the deepen side splits against the reserve that buy leaves.
            address router = LAUNCHPAD.router();
            if (router == address(0)) revert RouterNotSet();
            (, uint256 platformFee, uint256 creatorFee) = ILaunchRouter(router).quoteBuy(token, usdcToBurn);
            reserve += usdcToBurn - platformFee - creatorFee;
        }
        usdcToBuy = _usdcToBuy(usdcToDeepen, reserve, _feeBps(token));
        usdcForLiquidity = usdcToDeepen - usdcToBuy;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function burnBpsOf(address token) external view returns (uint16) {
        return _deepens[token].burnBps;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function totalUsdcBurning(address token) external view returns (uint256) {
        return _deepens[token].totalUsdcBurning;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function totalUsdcSpent(address token) external view returns (uint256) {
        return _deepens[token].totalSpent;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function totalTokensBurned(address token) external view returns (uint256) {
        return _deepens[token].totalBurned;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function totalUsdcAdded(address token) external view returns (uint256) {
        return _deepens[token].totalUsdcAdded;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function totalTokensAdded(address token) external view returns (uint256) {
        return _deepens[token].totalTokensAdded;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function totalLiquidityLocked(address token) external view returns (uint256) {
        return _deepens[token].totalLiquidity;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function nextRunBlock(address token) external view returns (uint256) {
        return _deepens[token].nextRunBlock;
    }

    /// @inheritdoc IDeepenPoolPlugin
    function lastRunAt(address token) external view returns (uint256) {
        return _deepens[token].lastRunAt;
    }

    /// @inheritdoc ILaunchFeePlugin
    function usdcHeld(address token) external view returns (uint256) {
        return _deepens[token].held;
    }

    // ─── Internal: the two kinds of run ───────────────────────────────────────

    /// @dev Buyback & burn's curve run: the whole offer buys through the launchpad; everything this plugin holds is
    ///      burned (this run's purchase, plus anything sent to it directly). On the curve's sell-out buy the launchpad
    ///      takes only what the last tokens cost and graduates the token in the same call; the rest of the offer stays
    ///      held for the next run, which deepens the pool.
    function _buyOnCurve(address token, uint256 offer) private returns (Outcome memory o) {
        USDC.forceApprove(address(LAUNCHPAD), offer);
        uint256 reportedSpend;
        (o.tokensBought, reportedSpend) = LAUNCHPAD.buy(token, offer, 0, address(this), block.timestamp);
        o.usdcSpent = _pulledFromOffer(address(LAUNCHPAD), offer);
        if (reportedSpend != o.usdcSpent) revert SpendMismatch(reportedSpend, o.usdcSpent);
        if (o.usdcSpent == 0) revert BadSpend(offer, 0);
        o.usdcBurning = o.usdcSpent; // everything a curve run spends buys tokens to burn
        o.tokensBurned = IERC20(token).balanceOf(address(this));
        if (o.tokensBought == 0 || o.tokensBurned < o.tokensBought) revert NothingBought(token);
    }

    /// @dev The pool run: `burnBps` of the offer buys the token and burns it, the rest buys and adds. Both sides go
    ///      through the launch router, the burn side first, so the deepen side splits against the pool that buy leaves.
    ///      Only the deepen side's own tokens can be added; everything else this plugin holds is burned (the burn
    ///      side's tokens, whatever the add could not take, and anything sent to the plugin directly). Nothing moves
    ///      into the pair here.
    ///      The pair is synced first, so the split reads the same pool the buys will trade against: anything donated
    ///      into the pair and not yet synced would otherwise be folded into the reserves by a buy's own swap, between
    ///      the split's reading and the add's, and leave more of the offer unspent (or burn more tokens). A sync is
    ///      permissionless and only recognises what the pair already holds.
    function _runInPool(address token, address pair, uint256 offer, uint256 burnBps)
        private
        returns (Outcome memory o)
    {
        address router = LAUNCHPAD.router();
        if (router == address(0)) revert RouterNotSet();
        ILaunchPair(pair).sync();
        (uint256 usdcToBurn, uint256 usdcToDeepen) = _sides(offer, burnBps);

        if (usdcToBurn != 0) {
            (o.tokensBought, o.usdcBurning) = _routerBuy(token, router, usdcToBurn);
            o.usdcSpent = o.usdcBurning;
        }
        if (usdcToDeepen != 0) {
            (, uint112 reserveUsdc,) = ILaunchPair(pair).getReserves();
            uint256 toBuy = _usdcToBuy(usdcToDeepen, reserveUsdc, _feeBps(token));
            uint256 balanceBefore = IERC20(token).balanceOf(address(this));
            (uint256 bought, uint256 spentOnBuy) = _routerBuy(token, router, toBuy);
            // The add may only pair the tokens THIS buy produced, so the run checks them against the balance it
            // moved. The two readings sit inside one non-reentrant call whose only callees are the launch router,
            // the pair and the token, none of which calls anyone else: nothing can move this balance in between but
            // the buy itself, and tokens arriving from anywhere else would only be burned at the end anyway.
            // slither-disable-next-line reentrancy-balance
            if (IERC20(token).balanceOf(address(this)) - balanceBefore < bought) revert NothingBought(token);
            o.tokensBought += bought;
            o.usdcSpent += spentOnBuy;

            (uint112 reserveToken, uint112 reserveUsdcAfter,) = ILaunchPair(pair).getReserves();
            (o.tokensAdded, o.usdcAdded, o.liquidity) = _addAmounts(
                bought, usdcToDeepen - spentOnBuy, reserveToken, reserveUsdcAfter, IERC20(pair).totalSupply()
            );
            o.usdcSpent += o.usdcAdded;
        }

        uint256 tokensHeld = IERC20(token).balanceOf(address(this));
        if (tokensHeld < o.tokensBought) revert NothingBought(token);
        o.tokensBurned = tokensHeld - o.tokensAdded;
    }

    /// @dev One exact-in buy through the launch router, with Buyback & burn's allowance accounting: what the router
    ///      pulled out of the allowance it was given is what left this plugin.
    function _routerBuy(address token, address router, uint256 usdcIn)
        private
        returns (uint256 bought, uint256 spent)
    {
        USDC.forceApprove(router, usdcIn);
        bought = ILaunchRouter(router).buy(token, usdcIn, 0, address(this), block.timestamp);
        spent = _pulledFromOffer(router, usdcIn);
        if (spent == 0) revert BadSpend(usdcIn, 0);
        if (bought == 0) revert NothingBought(token);
    }

    /// @dev Transfers the add into the pair and mints its LP to 0x…dEaD in one go. Nothing runs in between that anyone
    ///      else controls (a LaunchToken transfer and a USDC transfer make no external call), so nobody can skim the
    ///      deposit before the mint, and the pair's reserves equal its balances beforehand (the buy's swap set them),
    ///      so the mint credits exactly this deposit.
    function _addLiquidity(address token, address pair, Outcome memory o) private {
        IERC20(token).safeTransfer(pair, o.tokensAdded);
        USDC.safeTransfer(pair, o.usdcAdded);
        uint256 minted = ILaunchPair(pair).mint(LP_RECIPIENT);
        if (minted != o.liquidity) revert LiquidityMismatch(o.liquidity, minted);
    }

    /// @dev The plugin never mints LP to itself; LP someone sent it is locked where the plugin's own goes.
    function _lockStrayLiquidity(address pair) private {
        uint256 stray = IERC20(pair).balanceOf(address(this));
        if (stray != 0) IERC20(pair).safeTransfer(LP_RECIPIENT, stray);
    }

    // ─── Internal: math ───────────────────────────────────────────────────────

    /// @dev What a run may spend now: the cap prorated by the time since the token's last run,
    ///      cap * min(now - lastRunAt, RUN_INTERVAL) / RUN_INTERVAL rounded down, or the full cap if it never ran.
    ///      Idle time beyond one interval does not accumulate, so no run ever offers more than one cap.
    ///      (Buyback & burn's _budget, with the base read by the caller.)
    function _budget(uint256 base, uint256 lastRun) private view returns (uint256 budget) {
        budget = _cap(base);
        if (lastRun != 0) {
            uint256 elapsed = block.timestamp - lastRun;
            if (elapsed < RUN_INTERVAL) budget = (budget * elapsed) / RUN_INTERVAL;
        }
    }

    /// @dev How a pool run's offer splits: `burnBps` of it (rounded down) buys the token to burn, the rest buys and
    ///      adds. A side below MIN_RUN_USDC could not buy anything, so the whole offer goes through the other one
    ///      rather than wasting the run: the burn side gives way first, and an offer whose deepen side is dust is all
    ///      burn. Both sides that come back non-zero are at least MIN_RUN_USDC.
    function _sides(uint256 offer, uint256 burnBps) private pure returns (uint256 usdcToBurn, uint256 usdcToDeepen) {
        usdcToBurn = (offer * burnBps) / _BPS;
        usdcToDeepen = offer - usdcToBurn;
        if (usdcToBurn < MIN_RUN_USDC) (usdcToBurn, usdcToDeepen) = (0, offer);
        else if (usdcToDeepen < MIN_RUN_USDC) (usdcToBurn, usdcToDeepen) = (offer, 0);
    }

    /// @dev 0.25% of the base, rounded down.
    function _cap(uint256 base) private pure returns (uint256) {
        return (base * CAP_BPS) / _BPS;
    }

    /// @dev What the cap is 0.25% of (with the pair, which a pool run needs anyway). On the curve: its virtual USDC.
    ///      In the pool: the locked part of the pool's USDC reserve, reserve * LP held by 0x…dEaD / LP supply, rounded
    ///      down. A graduated pool's supply is never zero: graduation mints to 0x…dEaD, MINIMUM_LIQUIDITY included, and
    ///      nothing can move LP out of it. Why not the whole reserve: the contract's security notes.
    function _capBase(address token, bool graduated) private view returns (address pair, uint256 base) {
        if (!graduated) return (address(0), LAUNCHPAD.virtualUsdcOf(token));
        uint256 reserve;
        (pair, reserve) = _pool(token);
        base = Math.mulDiv(reserve, IERC20(pair).balanceOf(LP_RECIPIENT), IERC20(pair).totalSupply());
    }

    /// @dev The token's launch pool and its USDC reserve as last synced.
    function _pool(address token) private view returns (address pair, uint256 reserveUsdc) {
        pair = LAUNCHPAD.pairOf(token);
        if (pair == address(0)) revert PairNotSet(token);
        (, uint112 reserve,) = ILaunchPair(pair).getReserves();
        reserveUsdc = reserve;
    }

    /// @dev The platform fee plus the token's creator fee, in bps: what a launch-pool buy pays out of its USDC.
    function _feeBps(address token) private view returns (uint256) {
        return LAUNCHPAD.FEE_BPS() + LAUNCHPAD.creatorFeeBpsOf(token);
    }

    /// @dev The buy half of an offer `offer` in a pool holding `reserveUsdc`: the root of
    ///      q^2 * b^2 + 1e4 * (1e4 + q) * R * b - 1e8 * U * R = 0 (b + n + n^2 / R = U with n = b * q / 1e4), written as
    ///      2e4 * U * R / ((1e4 + q) * R + sqrt((1e4 + q)^2 * R^2 + 4 * q^2 * U * R)) and rounded down, then kept within
    ///      [MIN_RUN_USDC, offer] (the smallest buy that buys something at every creator fee). No overflow for any
    ///      uint112 reserve and an offer up to the reserve (a run's offer is at most 0.25% of it): the square root's
    ///      argument stays below 2^254.
    function _usdcToBuy(uint256 offer, uint256 reserveUsdc, uint256 feeBps) private pure returns (uint256 toBuy) {
        uint256 q = _BPS - feeBps;
        uint256 s = _BPS + q;
        uint256 root = Math.sqrt(s * s * reserveUsdc * reserveUsdc + 4 * q * q * offer * reserveUsdc);
        toBuy = Math.mulDiv(2 * _BPS * offer, reserveUsdc, s * reserveUsdc + root);
        if (toBuy < MIN_RUN_USDC) toBuy = MIN_RUN_USDC;
        if (toBuy > offer) toBuy = offer;
    }

    /// @dev The add at the pool's reserves (the Uniswap V2 router's optimal amounts): all `tokens` with
    ///      tokens * reserveUsdc / reserveToken USDC if `usdcLeft` covers it, otherwise all of `usdcLeft` with the tokens
    ///      it matches. `liquidity` is exactly what LaunchPair.mint will credit for that deposit (the same expression);
    ///      an add that would mint nothing is (0, 0, 0): the tokens are burned and the USDC stays held.
    function _addAmounts(uint256 tokens, uint256 usdcLeft, uint256 reserveToken, uint256 reserveUsdc, uint256 supply)
        private
        pure
        returns (uint256 tokenAmount, uint256 usdcAmount, uint256 liquidity)
    {
        if (tokens == 0 || usdcLeft == 0) return (0, 0, 0);
        usdcAmount = Math.mulDiv(tokens, reserveUsdc, reserveToken);
        if (usdcAmount <= usdcLeft) {
            tokenAmount = tokens;
        } else {
            usdcAmount = usdcLeft;
            tokenAmount = Math.mulDiv(usdcLeft, reserveToken, reserveUsdc);
        }
        liquidity = Math.min(tokenAmount * supply / reserveToken, usdcAmount * supply / reserveUsdc);
        if (liquidity == 0) return (0, 0, 0);
    }

    /// @dev What `spender` took out of the `offer` it was approved for: the allowance it consumed, which is exactly
    ///      the USDC it moved out of this contract with transferFrom (USDC arriving meanwhile cannot distort it).
    ///      Any unused allowance (the sell-out buy leaves `offer - usdcSpent`) is removed. (Buyback & burn's.)
    function _pulledFromOffer(address spender, uint256 offer) private returns (uint256 pulled) {
        uint256 unused = USDC.allowance(address(this), spender);
        pulled = offer - unused; // checked: an allowance only shrinks, so this cannot exceed the offer
        if (unused != 0) USDC.forceApprove(spender, 0);
    }
}
