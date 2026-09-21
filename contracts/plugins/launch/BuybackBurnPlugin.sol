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
import {IBuybackBurnPlugin} from "../../interfaces/plugins/IBuybackBurnPlugin.sol";
import {LaunchFeePluginBase} from "./LaunchFeePluginBase.sol";

/// @title BuybackBurnPlugin
/// @notice Spends each launch token's creator fees buying that token and burning it, so its total supply drops
///         (V13-SPEC §2.2, [D13], [D14]). Anyone can run it. Spending is paced by time: at most 0.25% of the
///         USDC-side reserve per hour, plus one full cap for a token's first run or after an idle hour, and at most
///         one run per token per block.
/// @dev Front-running economics (V13-SPEC §2.2): each run's buy raises the price. A trader who buys before the runs
///      and sells after them pays the platform fee and the creator fee `c` on both legs, about 2 * (0.5% + c) of
///      the position, while a full cap (0.25% of the reserve) raises the price by about 0.5%. So the runs a trader
///      sits through must add up to about (0.5% + c) / 0.25% caps before the round trip pays; one cap comes at once,
///      the rest at one cap per hour. Pacing by time, not by block, is what makes that a wait of hours: capped per
///      block, a trader could buy, run in each of the next few blocks and sell, paying the fees once. Runs take no
///      slippage bound, because the pacing is the protection. Each token's USDC is its own; a run only ever spends
///      the running token's balance.
contract BuybackBurnPlugin is IBuybackBurnPlugin, LaunchFeePluginBase {
    using SafeERC20 for IERC20;

    /// @inheritdoc IBuybackBurnPlugin
    uint256 public constant CAP_BPS = 25;
    /// @inheritdoc IBuybackBurnPlugin
    uint256 public constant RUN_INTERVAL = 1 hours;
    /// @inheritdoc IBuybackBurnPlugin
    uint256 public constant MIN_RUN_USDC = 3;
    uint256 private constant _BPS = 10_000;

    struct Buyback {
        uint256 held;
        uint256 totalSpent;
        uint256 totalBurned;
        uint256 nextRunBlock;
        uint256 lastRunAt; // timestamp of the latest run, 0 if the token never ran
    }

    mapping(address token => Buyback) private _buybacks;

    constructor(address launchpad_) LaunchFeePluginBase(launchpad_) {}

    // ─── Hooks ────────────────────────────────────────────────────────────────

    /// @inheritdoc IArchitexFeePlugin
    /// @dev Takes no configuration: `data` must be empty.
    function onLaunch(address token, address creator, bytes calldata data) external nonReentrant {
        if (data.length != 0) revert DataNotEmpty();
        _configure(token, creator);
    }

    /// @inheritdoc IArchitexFeePlugin
    /// @dev Credits `token` and pulls exactly `amount` from the caller. Zero is a no-op. Never buys here: a
    ///      collection runs inside the launchpad's non-reentrant collectCreatorFees, where a curve buy would revert.
    function onFees(address token, uint256 amount) external nonReentrant {
        _requireConfigured(token);
        if (amount == 0) return;
        _buybacks[token].held += amount;
        emit FeesReceived(token, msg.sender, amount);
        _pullFees(amount);
    }

    // ─── Run ──────────────────────────────────────────────────────────────────

    /// @inheritdoc IBuybackBurnPlugin
    /// @dev The USDC spent is what the launchpad or router pulled out of the exact allowance it was given for the
    ///      offer (so it can never exceed the offer), which is exactly the USDC that left this plugin. State is
    ///      written after the buy because only the buy reveals the spend (the curve's sell-out buy takes less than
    ///      offered); every state-changing entry point is nonReentrant, and the only external callees are the
    ///      launchpad, its launch router and the token being bought. The pacing state (nextRunBlock, lastRunAt) is
    ///      written before the buy; a run that reverts leaves it untouched.
    function run(address token) external nonReentrant returns (uint256 usdcSpent, uint256 tokensBurned) {
        _requireConfigured(token);
        Buyback storage buyback = _buybacks[token];
        if (block.number < buyback.nextRunBlock) revert AlreadyRanThisBlock(token);

        bool graduated = LAUNCHPAD.isGraduated(token);
        uint256 offer = Math.min(buyback.held, _budget(token, graduated, buyback.lastRunAt));
        // Below the minimum the rounded-up fees would eat the whole buy, and the launchpad or router would revert.
        if (offer < MIN_RUN_USDC) revert NothingToBuy(token);
        buyback.nextRunBlock = block.number + 1;
        buyback.lastRunAt = block.timestamp;

        uint256 tokensBought;
        if (graduated) {
            address router = LAUNCHPAD.router();
            if (router == address(0)) revert RouterNotSet();
            USDC.forceApprove(router, offer);
            tokensBought = ILaunchRouter(router).buy(token, offer, 0, address(this), block.timestamp);
            usdcSpent = _pulledFromOffer(router, offer);
        } else {
            USDC.forceApprove(address(LAUNCHPAD), offer);
            // On the curve's sell-out buy the launchpad takes only what the last tokens cost (usdcSpent <= offer)
            // and graduates the token in the same call; the rest of the offer stays held for the next run.
            uint256 reportedSpend;
            (tokensBought, reportedSpend) = LAUNCHPAD.buy(token, offer, 0, address(this), block.timestamp);
            usdcSpent = _pulledFromOffer(address(LAUNCHPAD), offer);
            if (reportedSpend != usdcSpent) revert SpendMismatch(reportedSpend, usdcSpent);
        }
        if (usdcSpent == 0) revert BadSpend(offer, 0);

        // Every token this plugin holds is burned: this run's purchase, plus anything sent to it directly.
        tokensBurned = IERC20(token).balanceOf(address(this));
        if (tokensBought == 0 || tokensBurned < tokensBought) revert NothingBought(token);

        buyback.held -= usdcSpent; // usdcSpent <= offer <= held
        buyback.totalSpent += usdcSpent;
        buyback.totalBurned += tokensBurned;
        emit BuybackRun(token, msg.sender, graduated, usdcSpent, tokensBurned);

        ILaunchTokenExtensions(token).burn(tokensBurned);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    /// @inheritdoc IBuybackBurnPlugin
    function previewRun(address token) external view returns (uint256 usdcOffered, bool graduated) {
        graduated = LAUNCHPAD.isGraduated(token);
        Buyback storage buyback = _buybacks[token];
        if (!isConfigured(token) || buyback.held == 0 || block.number < buyback.nextRunBlock) {
            return (0, graduated);
        }
        usdcOffered = Math.min(buyback.held, _budget(token, graduated, buyback.lastRunAt));
        if (usdcOffered < MIN_RUN_USDC) usdcOffered = 0;
    }

    /// @inheritdoc IBuybackBurnPlugin
    function totalUsdcSpent(address token) external view returns (uint256) {
        return _buybacks[token].totalSpent;
    }

    /// @inheritdoc IBuybackBurnPlugin
    function totalTokensBurned(address token) external view returns (uint256) {
        return _buybacks[token].totalBurned;
    }

    /// @inheritdoc IBuybackBurnPlugin
    function nextRunBlock(address token) external view returns (uint256) {
        return _buybacks[token].nextRunBlock;
    }

    /// @inheritdoc IBuybackBurnPlugin
    function lastRunAt(address token) external view returns (uint256) {
        return _buybacks[token].lastRunAt;
    }

    /// @inheritdoc ILaunchFeePlugin
    function usdcHeld(address token) external view returns (uint256) {
        return _buybacks[token].held;
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    /// @dev What a run may spend now: the cap prorated by the time since the token's last run,
    ///      cap * min(now - lastRunAt, RUN_INTERVAL) / RUN_INTERVAL rounded down, or the full cap if it never ran.
    ///      Idle time beyond one interval does not accumulate, so no run ever offers more than one cap.
    function _budget(address token, bool graduated, uint256 lastRun) private view returns (uint256 budget) {
        budget = _cap(token, graduated);
        if (lastRun != 0) {
            uint256 elapsed = block.timestamp - lastRun;
            if (elapsed < RUN_INTERVAL) budget = (budget * elapsed) / RUN_INTERVAL;
        }
    }

    /// @dev 0.25% of the USDC-side reserve: the curve's virtual USDC before graduation, the launch pool's USDC
    ///      reserve after. Only the pool's USDC reserve matters here; its token reserve and timestamp are unused.
    function _cap(address token, bool graduated) private view returns (uint256) {
        uint256 reserve;
        if (graduated) {
            address pair = LAUNCHPAD.pairOf(token);
            if (pair == address(0)) revert PairNotSet(token);
            (, uint112 reserveUsdc,) = ILaunchPair(pair).getReserves();
            reserve = reserveUsdc;
        } else {
            reserve = LAUNCHPAD.virtualUsdcOf(token);
        }
        return (reserve * CAP_BPS) / _BPS;
    }

    /// @dev What `spender` took out of the `offer` it was approved for: the allowance it consumed, which is exactly
    ///      the USDC it moved out of this contract with transferFrom (USDC arriving meanwhile cannot distort it).
    ///      Any unused allowance (the sell-out buy leaves `offer - usdcSpent`) is removed.
    function _pulledFromOffer(address spender, uint256 offer) private returns (uint256 pulled) {
        uint256 unused = USDC.allowance(address(this), spender);
        pulled = offer - unused; // checked: an allowance only shrinks, so this cannot exceed the offer
        if (unused != 0) USDC.forceApprove(spender, 0);
    }
}
