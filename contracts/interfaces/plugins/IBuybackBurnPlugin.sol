// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Buyback & burn: a token's creator fees buy the token and burn it, so total supply drops
///        (V13-SPEC §2.2, [D13], [D14]).
/// @notice onLaunch data must be empty. Fees accrue per token (`usdcHeld`). Anyone may call run(token), at most
///         once per token per block. A run offers min(usdcHeld, budget), where
///           cap    = 0.25% of the USDC-side reserve (the curve's virtual USDC before graduation, the launch pool's
///                    USDC reserve after), and
///           budget = cap * min(now - lastRunAt, RUN_INTERVAL) / RUN_INTERVAL, rounded down (the full cap for a
///                    token's first run).
///         So a token spends at most 0.25% of the reserve per hour, plus one full cap at once after an idle hour.
///         A run buys through the launchpad on the curve and through the launch router after graduation, then burns
///         every token the plugin holds. On the curve's sell-out buy the launchpad may take less than offered; the
///         rest stays waiting for later runs.
///
///         A run takes no slippage bound on purpose: the pacing is the protection. A trader who buys ahead of the
///         runs pays the 0.5% platform fee and the creator fee `c` on the way in and again on the way out, so the
///         runs must lift the price by about 2 * (0.5% + c) first, and a full cap lifts it by about 0.5%. Beyond the
///         one cap available at once, that takes about ((0.5% + c) / 0.25% - 1) hours of runs. The exact-integer
///         model of the curve and pool (runs every second, any position from 1 to 20,000 USDC) puts the shortest
///         profitable hold at 3.1 h for c = 0.5%, 5.2 h for 1%, 9.4 h for 2%, 23 h for 5% and 48.6 h for 10%;
///         until then the round trip loses, whatever its size. Past that point the trader is a holder collecting
///         what the buyback gives every holder, while carrying the market's risk.
interface IBuybackBurnPlugin is ILaunchFeePlugin {
    /// @notice One run: `usdcSpent` USDC bought `tokensBurned` tokens, all burned. `graduated` = bought in the pool.
    event BuybackRun(address indexed token, address indexed caller, bool graduated, uint256 usdcSpent, uint256 tokensBurned);

    error AlreadyRanThisBlock(address token);
    /// @notice The offer is below MIN_RUN_USDC: nothing (or only dust) is waiting for this token, or the budget is too
    ///         small (no time has passed since the last run, or the cap is dust).
    error NothingToBuy(address token);
    error RouterNotSet();
    error PairNotSet(address token);
    /// @notice The launchpad reported a different spend than the USDC it pulled from this plugin.
    error SpendMismatch(uint256 reported, uint256 actual);
    /// @notice The buy took no USDC.
    error BadSpend(uint256 offered, uint256 actual);
    /// @notice The buy reported no tokens, or this plugin holds fewer than it reported.
    error NothingBought(address token);

    /// @notice 25: the cap, 0.25% of the USDC-side reserve. No run offers more than one cap.
    function CAP_BPS() external view returns (uint256);
    /// @notice 3600 (one hour): the cap refills in proportion to the time since the last run, fully after this long.
    function RUN_INTERVAL() external view returns (uint256);
    /// @notice 3 (0.000003 USDC): the smallest offer a run makes; below it previewRun is 0 and run reverts
    ///         NothingToBuy. It is the smallest amount whose rounded-up fees leave something to buy with at every
    ///         creator fee: at most 1 + 1 of 3 units (ceil(3 * 0.5%) + ceil(3 * 10%)), where 2 units pay 1 + 1 and
    ///         buy nothing. One net unit always buys a token: on the curve at least ~8e15 wei (virtual tokens stay
    ///         >= 2.7e26 against <= 3.4e10 virtual USDC), and in the pool while its token reserve exceeds its USDC
    ///         reserve, which the locked graduation liquidity (token x USDC >= 2e26 x 2.5e10) guarantees below about
    ///         2.2 trillion USDC. So at most 2 units per token can stay behind.
    function MIN_RUN_USDC() external view returns (uint256);

    /// @notice All USDC this plugin has spent buying `token` back.
    function totalUsdcSpent(address token) external view returns (uint256);
    /// @notice All `token` this plugin has burned.
    function totalTokensBurned(address token) external view returns (uint256);
    /// @notice The first block in which `token` may run again: its last run's block + 1 (0 if it never ran).
    function nextRunBlock(address token) external view returns (uint256);
    /// @notice Timestamp of `token`'s latest run (0 if it never ran). A run at `lastRunAt + RUN_INTERVAL` or later
    ///         gets a full cap.
    function lastRunAt(address token) external view returns (uint256);
    /// @notice Exactly what a run now would offer: min(usdcHeld, budget), or 0 if the token is unconfigured, already
    ///         ran this block, or that minimum is below MIN_RUN_USDC. On the curve's sell-out buy the actual spend can be
    ///         lower.
    function previewRun(address token) external view returns (uint256 usdcOffered, bool graduated);

    /// @notice Runs one paced buyback for `token` and burns the tokens. Callable by anyone.
    function run(address token) external returns (uint256 usdcSpent, uint256 tokensBurned);
}
