// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ILaunchFeePlugin} from "./ILaunchFeePlugin.sol";

/// @title Deepen pool: a token's creator fees buy the token and burn it on the curve, then, after graduation, split
///        every run between burning the token and deepening its launch pool, under one paced budget
///        (docs/launchpad/V13-SPEC.md §2.3).
/// @notice onLaunch data is `abi.encode(uint16 burnBps)`, canonically encoded, 0 to 10,000: the share of every pool
///         run that buys the token and burns it, the rest buying the token and adding it to the pool. Empty data means
///         DEFAULT_BURN_BPS (5,000, half and half). 0 is pure deepening, 10,000 is pure buyback and burn. The choice
///         is write-once, like every listed plugin's configuration, and `burnBpsOf` reads it back.
///
///         Fees accrue per token (`usdcHeld`); ANYONE may deliver them through onFees for a configured token, not only
///         the launchpad's collection: Architex's own fee wallet, the creator or anyone else can top a token's pot up
///         (a gift: nothing ever pays it back). Anyone may call run(token), paced exactly like Buyback & burn: a run
///         offers min(usdcHeld, budget), where
///           cap    = 0.25% of the USDC-side reserve (the curve's virtual USDC before graduation, the launch pool's
///                    USDC reserve after), and
///           budget = cap * min(now - lastRunAt, RUN_INTERVAL) / RUN_INTERVAL, rounded down (the full cap for a
///                    token's first run),
///         at most once per token per block, never below MIN_RUN_USDC. Burning and deepening share that one budget and
///         that one clock, which is the point: two plugins doing this separately would spend twice as fast and halve
///         the front-running protection below.
///
///         Before graduation there is no pool to add to, so a run is Buyback & burn's whatever the burn share: it buys
///         with the whole offer through the launchpad and burns every token bought. On the curve's sell-out buy the
///         launchpad takes only what the last tokens cost and graduates the token inside the run; the rest of the offer
///         stays held, and the next run splits as below.
///
///         After graduation a run splits its offer U into `burnBps` of it (rounded down) and the rest. The burn side
///         buys through the launch router and burns everything it gets. The deepen side buys with `b` of what is left
///         and transfers those tokens and up to the remainder to the token's launch pair, minting the LP straight to
///         0x…dEaD, in the same call. With the pool's USDC reserve R (after the burn side's buy) and
///         q = 10,000 - (platform fee + creator fee) in bps (so a buy of b puts n = b * q / 10,000 into the pool), the
///         tokens bought pair at the post-buy price with n * (R + n) / R USDC, so the add takes all of them when
///         b + n + n^2 / R = U_deepen:
///           b = 2e4 * U_deepen * R / ((1e4 + q) * R + sqrt((1e4 + q)^2 * R^2 + 4 * q^2 * U_deepen * R)), rounded down,
///         (at least 3, at most U_deepen; previewSplit). The run syncs the pair first, so both sides read the same pool
///         they trade against even when something has been donated into the pair and not yet synced. The add then pairs
///         at the pool's reserves after that buy (the Uniswap V2 router's optimal amounts): all the tokens the deepen
///         side bought with tokens * reserveUsdc / reserveToken USDC, or, if that is more than is left, all the USDC
///         left with the matching tokens.
///
///         Everything the plugin holds that the add does not take is burned: the burn side's tokens, what did not fit,
///         and anything sent to the plugin directly. USDC that does not fit stays held for the next run (at most 4
///         units of an offer, the split's rounding). A side below MIN_RUN_USDC could not buy anything, so the whole
///         offer goes through the other one rather than wasting the run; an add too small to mint any LP is skipped,
///         and its tokens are burned. LP tokens anyone sends this plugin are passed on to 0x…dEaD by the next pool run:
///         the plugin never keeps any.
///
///         Front-running (V13-SPEC §2.3): a run takes no slippage bound; the pacing is the protection. A trader who
///         buys ahead of the runs and sells after them pays 0.5% + c (the creator fee) on each leg. Burning raises the
///         price about twice as fast per USDC as deepening does (a burn takes tokens out of the pool and leaves the
///         USDC in; a deepen run gives every token it buys back), so the shortest profitable hold is about
///         2 * (0.5% + c) / (0.25% * (1 + burnBps / 10,000)) - 1 hours. The exact-integer model (a run every few
///         seconds, the first a full cap, positions of 1 to 20,000 USDC, a pot that never limits a run) gives, in
///         hours:
///
///             burnBps |  c = 0   0.5%    1%     2%     5%    10%
///             --------+------------------------------------------
///                   0 |   3.0    7.1   11.2   19.5   45.6   93.0
///               2,500 |   2.2    5.5    8.8   15.5   36.7   75.8
///               5,000 |   1.7    4.4    7.2   12.8   30.6   63.9
///               7,500 |   1.3    3.6    6.0   10.9   26.3   55.2
///              10,000 |   1.0    3.1    5.1    9.4   23.0   48.6
///
///         (the last row is Buyback & burn's, as it must be). Sandwiching one run always loses: a full cap lifts the
///         price by at most about 0.5%, the round trip costs at least 1%. Past the bound the trader is a holder
///         collecting what the runs give every holder. Putting this plugin and Buyback & burn in one Combo would pace
///         them separately and halve these bounds; a burn share here does the same job under one budget, so there is
///         no reason to pair them.
interface IDeepenPoolPlugin is ILaunchFeePlugin {
    /// @notice One run. `graduated` = in the launch pool (burn side, then buy and add); false = on the curve (buy, then
    ///         burn all). `usdcSpent` left the plugin: `usdcBurning` bought tokens to burn, `usdcAdded` went into the
    ///         pool as liquidity, and the rest bought the tokens that went in with it. `tokensBought` is both buys;
    ///         `tokensAdded` went into the pool and minted `liquidity` LP to 0x…dEaD; `tokensBurned` is everything else
    ///         the plugin held. On the curve `usdcBurning` is the whole spend and `usdcAdded`, `tokensAdded` and
    ///         `liquidity` are 0.
    event DeepenRun(
        address indexed token,
        address indexed caller,
        bool graduated,
        uint256 usdcSpent,
        uint256 usdcBurning,
        uint256 usdcAdded,
        uint256 tokensBought,
        uint256 tokensAdded,
        uint256 tokensBurned,
        uint256 liquidity
    );
    /// @notice `token`'s share of every pool run that buys the token and burns it, set once at launch.
    event BurnShareSet(address indexed token, uint16 burnBps);

    error AlreadyRanThisBlock(address token);
    /// @notice The offer is below MIN_RUN_USDC: nothing (or only dust) is waiting for this token, or the budget is too
    ///         small (no time has passed since the last run, or the cap is dust).
    error NothingToBuy(address token);
    /// @notice The configured burn share is above 10,000 basis points.
    error InvalidBurnBps(uint256 burnBps);
    error RouterNotSet();
    error PairNotSet(address token);
    /// @notice The launchpad reported a different spend than the USDC it pulled from this plugin.
    error SpendMismatch(uint256 reported, uint256 actual);
    /// @notice A buy took no USDC.
    error BadSpend(uint256 offered, uint256 actual);
    /// @notice A buy reported no tokens, or this plugin holds fewer than it reported.
    error NothingBought(address token);
    /// @notice The launch pair minted a different amount of LP than its reserves and supply imply.
    error LiquidityMismatch(uint256 expected, uint256 minted);

    /// @notice 25: the cap, 0.25% of the USDC-side reserve (Buyback & burn's). No run offers more than one cap.
    function CAP_BPS() external view returns (uint256);
    /// @notice 3600 (one hour): the cap refills in proportion to the time since the last run, fully after this long.
    function RUN_INTERVAL() external view returns (uint256);
    /// @notice 3 (0.000003 USDC), Buyback & burn's: the smallest offer a run makes, and the smallest either side of a
    ///         pool run's split may be. Below it previewRun is 0 and run reverts NothingToBuy. A buy of 3 units leaves
    ///         at least one net unit at every creator fee, which buys at least a token wei on the curve and in the
    ///         pool. At most 2 units per token can stay behind.
    function MIN_RUN_USDC() external view returns (uint256);
    /// @notice 5,000: the burn share a token gets when its creator gives this plugin no configuration data.
    function DEFAULT_BURN_BPS() external view returns (uint16);
    /// @notice 0x000000000000000000000000000000000000dEaD: where every LP token this plugin mints goes, locked forever.
    function LP_RECIPIENT() external view returns (address);

    /// @notice `token`'s burn share in basis points, fixed at launch. 0 for a token this plugin was never configured
    ///         for, which `isConfigured` tells apart from a configured 0 (pure deepening).
    function burnBpsOf(address token) external view returns (uint16);
    /// @notice All USDC this plugin has spent for `token`: both buys plus the liquidity added.
    function totalUsdcSpent(address token) external view returns (uint256);
    /// @notice All USDC this plugin has spent buying `token` to burn it (the burn side of pool runs, and the whole
    ///         spend of curve runs).
    function totalUsdcBurning(address token) external view returns (uint256);
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
    /// @notice Exactly what a run now would offer and how it would divide it: `usdcToBurn` buys the token to burn and
    ///         `usdcToDeepen` buys and adds (on the curve the whole offer burns). All zero if the token is
    ///         unconfigured, already ran this block, or the offer would be below MIN_RUN_USDC. A run spends the offer
    ///         but for what does not fit the add (at most 4 units), and less on the curve's sell-out buy.
    function previewRun(address token)
        external
        view
        returns (uint256 usdcOffered, uint256 usdcToBurn, uint256 usdcToDeepen, bool graduated);
    /// @notice How a run would break `usdcOffered` down for `token` now: `usdcToBurn` buys the token to burn,
    ///         `usdcToBuy` buys the tokens to add, and `usdcForLiquidity` goes into the pool with them (the three sum
    ///         to `usdcOffered`). On the curve the whole offer buys and burns. Read from the pair's reserves; a run
    ///         syncs the pair first, so anything donated into the pair and not yet synced shifts what it actually uses.
    function previewSplit(address token, uint256 usdcOffered)
        external
        view
        returns (uint256 usdcToBurn, uint256 usdcToBuy, uint256 usdcForLiquidity);

    /// @notice Runs one paced step for `token`: on the curve, buys and burns; in the pool, burns the burn share and
    ///         adds the rest as liquidity locked at 0x…dEaD, burning what does not fit. Callable by anyone.
    function run(address token) external returns (uint256 usdcSpent, uint256 tokensBurned, uint256 liquidity);
}
