// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Deepen pool: a token's creator fees buy the token and burn it on the curve, then, after graduation, buy it
///        and add it to the token's launch pool with the rest of the USDC, locking the liquidity forever
///        (docs/launchpad/V13-SPEC.md §2.3).
/// @notice onLaunch data must be empty. Fees accrue per token (`usdcHeld`); ANYONE may deliver them through onFees for
///         a configured token, not only the launchpad's collection: Architex's own fee wallet, the creator or anyone
///         else can top a token's pot up (a gift: nothing ever pays it back). Anyone may call run(token), paced
///         exactly like Buyback & burn: a run offers min(usdcHeld, budget), where
///           cap    = 0.25% of the USDC-side reserve (the curve's virtual USDC before graduation, the launch pool's
///                    USDC reserve after), and
///           budget = cap * min(now - lastRunAt, RUN_INTERVAL) / RUN_INTERVAL, rounded down (the full cap for a
///                    token's first run),
///         at most once per token per block, never below MIN_RUN_USDC.
///
///         Before graduation a run is Buyback & burn's: it buys with the whole offer through the launchpad and burns
///         every token bought. On the curve's sell-out buy the launchpad takes only what the last tokens cost and
///         graduates the token inside the run; the rest of the offer stays held, and the next run, paced from this one,
///         deepens the pool.
///
///         After graduation a run splits the offer U. It buys with `b` through the launch router, then transfers the
///         tokens it holds and up to U - b USDC to the token's launch pair and mints the LP straight to 0x…dEaD, in the
///         same call. With the pool's USDC reserve R and q = 10,000 - (platform fee + creator fee) in bps (so a buy of
///         b puts n = b * q / 10,000 into the pool), the tokens bought pair at the post-buy price with n * (R + n) / R
///         USDC, so the add takes all of them when b + n + n^2 / R = U:
///           b = 2e4 * U * R / ((1e4 + q) * R + sqrt((1e4 + q)^2 * R^2 + 4 * q^2 * U * R)), rounded down,
///         (at least 3, at most U; previewSplit). The run syncs the pair first, so the split reads the same pool the
///         buy trades against even when something has been donated into the pair and not yet synced. The add then
///         pairs at the pool's post-buy reserves (the Uniswap V2 router's optimal amounts): all the tokens held with
///         tokens * reserveUsdc / reserveToken USDC, or, if that is more than is left, all the USDC left with the
///         matching tokens. Tokens that do not fit are burned; USDC that
///         does not fit stays held for the next run. With the fees' rounding, at most 4 units of an offer stay held
///         and at most about 2 units' worth of tokens are burned. An add too small to mint any LP is skipped: the
///         tokens are burned and the USDC stays held (only for offers of a few units). LP tokens anyone sends to this
///         plugin are passed on to 0x…dEaD by the next pool run: the plugin never keeps any.
///
///         Because every token the run bought goes back into the pool, a pool run leaves the pool's token reserve
///         where it was and adds about U * (1 - fee share of b) USDC: the price rises by about that fraction of the
///         USDC reserve (a full cap: about 0.25%), half of Buyback & burn's rise for the same spend.
///
///         Front-running (V13-SPEC §2.3): a run takes no slippage bound; the pacing is the protection. A trader who
///         buys ahead of the runs and sells after them pays 0.5% + c (the creator fee) on each leg. On the curve the
///         runs are Buyback & burn's, with its bounds (3.1 h at c = 0.5%, 5.2 h at 1%, 9.4 h at 2%, 23 h at 5%,
///         48.6 h at 10%). In the pool the runs leave the token reserve unchanged, so the round trip's result, as a
///         share of the position, is the same at every size: the exact-integer model (a run every second, the first a
///         full cap, positions of 1 to 20,000 USDC) puts the shortest profitable hold at 3.0 h for c = 0, 7.1 h for
///         0.5%, 11.2 h for 1%, 19.5 h for 2%, 45.6 h for 5% and 93.0 h for 10%, about (2 * (0.5% + c) / 0.25% - 1)
///         hours. Sandwiching one run always loses, at any size: a full cap lifts the price by about 0.25%, the round
///         trip costs at least 1%. Past the bound the trader is a holder collecting what the runs give every holder.
///         A token whose Combo holds both this plugin and Buyback & burn is paced twice (each plugin keeps its own
///         clock), which roughly halves these bounds (V13-SPEC §2.3).
interface IDeepenPoolPlugin is ILaunchFeePlugin {
    /// @notice One run. `graduated` = in the launch pool (buy, then add); false = on the curve (buy, then burn all).
    ///         `usdcSpent` left the plugin: the buy plus `usdcAdded`. `tokensBought` came from the buy; `tokensAdded`
    ///         went into the pool with `usdcAdded`, which minted `liquidity` LP to 0x…dEaD; `tokensBurned` were burned
    ///         (everything else the plugin held). On the curve `usdcAdded`, `tokensAdded` and `liquidity` are 0.
    event DeepenRun(
        address indexed token,
        address indexed caller,
        bool graduated,
        uint256 usdcSpent,
        uint256 usdcAdded,
        uint256 tokensBought,
        uint256 tokensAdded,
        uint256 tokensBurned,
        uint256 liquidity
    );

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
    /// @notice The launch pair minted a different amount of LP than its reserves and supply imply.
    error LiquidityMismatch(uint256 expected, uint256 minted);

    /// @notice 25: the cap, 0.25% of the USDC-side reserve (Buyback & burn's). No run offers more than one cap.
    function CAP_BPS() external view returns (uint256);
    /// @notice 3600 (one hour): the cap refills in proportion to the time since the last run, fully after this long.
    function RUN_INTERVAL() external view returns (uint256);
    /// @notice 3 (0.000003 USDC), Buyback & burn's: the smallest offer a run makes; below it previewRun is 0 and run
    ///         reverts NothingToBuy. A buy of 3 units leaves at least one net unit at every creator fee, which buys at
    ///         least a token wei on the curve and in the pool. In the pool, a buy smaller than 3 is raised to 3 (so an
    ///         offer of 3 is all buy and burn). At most 2 units per token can stay behind.
    function MIN_RUN_USDC() external view returns (uint256);
    /// @notice 0x000000000000000000000000000000000000dEaD: where every LP token this plugin mints goes, locked forever.
    function LP_RECIPIENT() external view returns (address);

    /// @notice All USDC this plugin has spent for `token`: buys plus liquidity added.
    function totalUsdcSpent(address token) external view returns (uint256);
    /// @notice All `token` this plugin has burned.
    function totalTokensBurned(address token) external view returns (uint256);
    /// @notice All USDC this plugin has added to `token`'s launch pool as liquidity (the buys excluded).
    function totalUsdcAdded(address token) external view returns (uint256);
    /// @notice All `token` this plugin has added to its launch pool as liquidity.
    function totalTokensAdded(address token) external view returns (uint256);
    /// @notice All LP of `token`'s launch pool this plugin has minted to 0x…dEaD.
    function totalLiquidityLocked(address token) external view returns (uint256);
    /// @notice The first block in which `token` may run again: its last run's block + 1 (0 if it never ran).
    function nextRunBlock(address token) external view returns (uint256);
    /// @notice Timestamp of `token`'s latest run (0 if it never ran). A run at `lastRunAt + RUN_INTERVAL` or later
    ///         gets a full cap.
    function lastRunAt(address token) external view returns (uint256);
    /// @notice Exactly what a run now would offer: min(usdcHeld, budget), or 0 if the token is unconfigured, already
    ///         ran this block, or that minimum is below MIN_RUN_USDC. A run spends at most this: less on the curve's
    ///         sell-out buy, and in the pool by what does not fit the add (at most 4 units).
    function previewRun(address token) external view returns (uint256 usdcOffered, bool graduated);
    /// @notice How a run would split `usdcOffered` for `token` now: `usdcToBuy` buys the token, and up to
    ///         `usdcForLiquidity` (the rest) is added to the pool with it. On the curve the whole offer buys.
    ///         Read from the pair's reserves; a run syncs the pair first, so anything donated into the pair and not yet
    ///         synced shifts the split the run actually uses.
    function previewSplit(address token, uint256 usdcOffered)
        external
        view
        returns (uint256 usdcToBuy, uint256 usdcForLiquidity);

    /// @notice Runs one paced step for `token`: on the curve, buys and burns; in the pool, buys and adds liquidity
    ///         locked at 0x…dEaD, burning what does not fit. Callable by anyone.
    function run(address token) external returns (uint256 usdcSpent, uint256 tokensBurned, uint256 liquidity);
}
