// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Buyback & burn: a token's creator fees buy the token and burn it, so total supply drops
///        (V13-SPEC §2.2, [D13], [D14]).
/// @notice onLaunch data must be empty. Fees accrue per token (`usdcHeld`). Anyone may call run(token): at most
///         once per token per block, it offers min(usdcHeld, 0.25% of the USDC-side reserve) — the curve's
///         virtual USDC before graduation, the launch pool's USDC reserve after — buying through the launchpad on
///         the curve and through the launch router after graduation, then burns every token it holds. A run takes
///         no slippage bound on purpose: the cap is the protection (a sandwich pays more in fees than one capped
///         run moves the price). On the curve's sell-out buy the launchpad may take less than offered; the rest
///         stays waiting for the next run.
interface IBuybackBurnPlugin is ILaunchFeePlugin {
    /// @notice One run: `usdcSpent` USDC bought `tokensBurned` tokens, all burned. `graduated` = bought in the pool.
    event BuybackRun(address indexed token, address indexed caller, bool graduated, uint256 usdcSpent, uint256 tokensBurned);

    error AlreadyRanThisBlock(address token);
    /// @notice Nothing is waiting for this token, or the cap rounds to zero.
    error NothingToBuy(address token);
    error RouterNotSet();
    error PairNotSet(address token);
    /// @notice The launchpad reported a different spend than the USDC it pulled from this plugin.
    error SpendMismatch(uint256 reported, uint256 actual);
    /// @notice The buy took no USDC.
    error BadSpend(uint256 offered, uint256 actual);
    /// @notice The buy reported no tokens, or this plugin holds fewer than it reported.
    error NothingBought(address token);

    /// @notice 25: a run spends at most 0.25% of the USDC-side reserve.
    function CAP_BPS() external view returns (uint256);

    /// @notice All USDC this plugin has spent buying `token` back.
    function totalUsdcSpent(address token) external view returns (uint256);
    /// @notice All `token` this plugin has burned.
    function totalTokensBurned(address token) external view returns (uint256);
    /// @notice The first block in which `token` may run again: its last run's block + 1 (0 if it never ran).
    function nextRunBlock(address token) external view returns (uint256);
    /// @notice What a run now would offer: min(usdcHeld, cap), or 0 if the token is unconfigured, has nothing
    ///         waiting, or already ran this block. On the curve's sell-out buy the actual spend can be lower.
    function previewRun(address token) external view returns (uint256 usdcOffered, bool graduated);

    /// @notice Runs one capped buyback for `token` and burns the tokens. Callable by anyone.
    function run(address token) external returns (uint256 usdcSpent, uint256 tokensBurned);
}
