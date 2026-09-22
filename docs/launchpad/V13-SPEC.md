# Architex Launchpad v1.3 — binding spec

Signed off by the owner 2026-09-21 and built on branch `v13`. This file describes what was built, including
the builders' safer interpretations (marked **[built]**), two later owner decisions (**[D21]**, **[D22]**) and
the fixes from the security review (**[review]**).

v1.3 replaces the v1.2 launchpad (deployed on mainnet at `0x9Ac420d77E019D5e9F79a3020B0b5eB28d72B959`,
0 launches, withdrawn from the site 2026-09-21). It adds per-token **creator fees** routed to **plugins**
(the plugin marketplace), and graduates tokens into a **separate launch-pool suite** so creator fees keep
applying after graduation. The core AMM (factory, router, lens, the USDC/EURC pool) is untouched.

Owner decisions are marked **[D#]** with the question they answer (2026-09-21).
Details not asked but forced by those decisions are marked **[derived]** — review these.

## 1. Economics

- **Platform fee: 0.5% (`FEE_BPS = 50`) on every buy and sell of a launch token**, on the curve and in its
  launch pool, to `feeTo`. Unaffected by the creator fee.
- **Creator fee: 0–10% (`0 ≤ creatorFeeBps ≤ MAX_CREATOR_FEE_BPS = 1000`)**, chosen at launch.
  - Same % on buys and sells **[D1]**. Locked forever **[D2]**. The creator's own first buy pays it **[D3]**.
  - The token builder starts at 0% **[D4]**.
- **Both fees are taken in USDC [D11]**, computed on the trade's gross USDC and rounded **up** (they
  never round in the trader's favour). A buy pays them out of the USDC in; a sell out of the USDC out.
- **No liquidity-provider fee** in launch pools. An "LP fee" is plugin behaviour (owner, Q "Pool fees").
- **Launch fee: 1 USDC** (unchanged from v1.2). `createToken` takes `maxLaunchFee` and reverts `LaunchFeeAboveMax`
  if the admin raised the fee above it while the launch was pending **[D22]**.
- **Every bonding curve is identical**: the v1.2 constants stay hard-coded (`TOTAL_SUPPLY` 1B,
  `CURVE_SUPPLY` 800M, `POOL_SUPPLY` 200M, `VIRTUAL_TOKENS_0`, `VIRTUAL_USDC_0 = 8_333_333_333`). Not a
  constructor parameter, not per deployment (owner).

## 2. Plugins

- **One plugin per token, set at launch, locked forever [D5]**. A plugin is **any address**: custom
  addresses are allowed; immutability, not curation, is the safety guarantee **[D7]**. The site states
  plainly where fees go (the listed plugin's name, or "custom address") and makes no safety claim about it.
  The launchpad refuses only the few addresses that could never pass fees on (§2.1) **[review]**.
- **Accrual, never push.** Creator fees accrue per token inside the launchpad (from curve trades and from
  launch-pool trades). **Anyone can collect a token's accrued creator fees to its plugin, any time [D9]**.
  A trade never calls a plugin, so no plugin can block trading.
- **A plugin that breaks keeps its fees stuck [D10]**. Trading is unaffected; nobody can redirect them.
- **Marketplace listing is by PR review [D8]**, as today.
- **One slot plus a Combo plugin [D6]**: the launchpad knows one plugin per token; the Combo plugin splits
  a token's fees across other plugins by percentage.

### 2.1 Plugin interface — `IArchitexFeePlugin` (ERC-165)

```solidity
interface IArchitexFeePlugin is IERC165 {
    /// Called once, inside createToken, after the curve is registered and before the creator's first buy.
    /// `data` is the creator's plugin configuration (e.g. Split's payees and shares).
    function onLaunch(address token, address creator, bytes calldata data) external;

    /// Collection. The plugin MUST pull exactly `amount` USDC from msg.sender with transferFrom.
    function onFees(address token, uint256 amount) external;
}
```

**[derived]** rules the launchpad and every listed plugin follow:

- **Hooks only for plugins that declare them.** The launchpad calls `onLaunch`/`onFees` only when
  OpenZeppelin `ERC165Checker.supportsInterface(plugin, type(IArchitexFeePlugin).interfaceId)` is true.
  Anything else (a wallet, a Safe, an arbitrary contract) just receives USDC by `transfer` on collection.
  A creator's smart-contract wallet therefore works as a "Creator wallet" destination.
- **Which addresses a creator may pick [review].** Any address that can pass fees on. `createToken` reverts
  `InvalidPlugin` for zero, the launchpad, USDC, the launch router, the pair factory, the new token, any
  launch pair (its own or another token's), and any other launch token. Fees sent to most of these would be
  stranded; a plain transfer into a launch pair can be taken by anyone with `skim`, before or after
  graduation. The launchpad records every launch pair as `createToken` creates it (`isLaunchPair`; no pair is
  created anywhere else), so the new token's own pair counts too, and the new token's and its pair's
  addresses are predictable, so a builder could offer them. The dead address stays allowed: burning the fees
  is a choice. `pluginData` must be empty for an address that does not declare the interface
  (`DataForNonPlugin`): data nothing will read means a mistyped plugin address, which would otherwise launch
  and take every fee. Listed plugins check where they send fees the same way (§2.2).
- **Fees are pulled, not credited.** On collection the launchpad `approve`s the plugin for `amount`, calls
  `onFees`, then checks that exactly `amount` left its balance and that the allowance is zero, and reverts
  otherwise. A plugin can never credit itself fees it did not receive, and neither can a caller that
  merely calls `onFees` directly: every credit is backed by USDC transferred in the same call.
- **`onLaunch` is authenticated per token.** Launch-token addresses are predictable, so a plugin could be
  pre-configured by an attacker for a token about to be created. Listed plugins accept `onLaunch` only
  if `launchpad.pluginOf(token) == msg.sender`, or if `msg.sender == launchpad` and
  `pluginOf(token) == address(this)`. This covers the Combo case, where the Combo is the token's plugin
  and configures its sub-plugins. Use `pluginOf`, not `curves()`: `curves()` reverts for unknown tokens.
  Configuration is write-once per token.
- **The hook decision is made once, at launch, and stored** (`Curve.pluginHooks`) **[built]**. Collection uses
  the stored value, so `onFees` runs for a token exactly when `onLaunch` did. This matters for a plugin whose
  `supportsInterface` answer could change later (an upgradeable proxy).
- **Hooks run under the launchpad's reentrancy guard**, so a plugin cannot trade inside `onFees`. Buyback &
  burn buys in its own separate `run` call.
- If `onLaunch` reverts, `createToken` reverts (the creator's own choice). If `onFees` reverts, that
  collection reverts and the fees stay accrued **[D10]**.

### 2.2 Reference plugins (listed; singletons deployed once by Architex)

| Plugin | Behaviour |
| --- | --- |
| **Creator wallet** | No contract: `plugin` is an address the creator names (default: the creator). |
| **Split** | Up to **20** payees with fixed shares, set in `onLaunch` data **[D16]**. Per-token accounting; each payee (or anyone for them) pulls `release(token, payee)`. Payees can't be zero, duplicates, the plugin, the launchpad, USDC or the token **[built]**, nor any launch pair, the launch router, the pair factory or any launch token **[review]**: fees sent to any of those would be stuck, or skimmed out of a pair by anyone. |
| **Buyback & burn** | Anyone can run it **[D14]**. Each run buys the token with that token's accrued USDC (through the launchpad while on the curve, the launch router after graduation) and **burns** it, so total supply drops **[D13]**. |
| **Distribute to holders** | Passes each collection straight to the token's `distribute`, which **streams it to holders over 24 hours with continuous accrual** (§3) **[D15]**: a holder earns only for the seconds it holds, so a bot that buys, collects, claims and sells in one transaction earns exactly 0 **[D21]**. The plugin holds nothing; holders claim on the token page (`claim` / `claimFor` on the token). |
| **Combo** | Splits a token's fees across up to 5 plugins by basis points summing to 10,000, forwarding `onLaunch` data to each. An entry that isn't a plugin must have empty data, which catches a mistyped plugin address **[built]**. Entries follow Split's payee rules. A Combo inside a Combo can't configure listed plugins. |

A fifth listed plugin, **Deepen pool**, was added after this sign-off and is specified in §2.3.

**Buyback & burn pacing [review]**: a run offers min(held, budget). The cap is **0.25% of the USDC-side
reserve** (the curve's `virtualUsdc`, or the pool's USDC reserve). The budget is the cap prorated by the
time since the token's last run, `cap × min(now − lastRunAt, 1 h) / 1 h` rounded down, and a full cap for
its first run. So a token spends **at most 0.25% of its reserve per hour, plus one full cap at once** after
an idle hour, and still runs at most once per block. A run takes no slippage bound: the pacing is the
protection. An offer below `MIN_RUN_USDC` = 3 units is no run (`previewRun` 0, `run` reverts
`NothingToBuy`): fees round up, so 2 units pay 1 + 1 and buy nothing, while 3 always leave a net unit that
buys at least one token wei, on the curve and in the pool. At most 2 units per token can stay behind.

- To front-run the buyback, a trader buys before runs and sells after them, paying 0.5% + c on each leg
  (c = the token's creator fee), while each full cap lifts the price by about 0.5%. Beyond the one cap
  available at once, that takes about **((0.5% + c) / 0.25% − 1) hours** of runs. The exact-integer model
  of the curve and pool (a run every second, positions of 1 to 20,000 USDC) puts the shortest profitable
  hold at **3.1 h for c = 0.5%, 5.2 h for 1%, 9.4 h for 2%, 23 h for 5% and 48.6 h for 10%**. Until then
  the round trip loses, whatever its size; past it the trader is a holder collecting what the buyback gives
  every holder, at the market's risk. A trader who is also paid the creator fee (the creator, through a
  Combo) faces a smaller c. `BuybackBurnFrontRun.t.sol` reproduces the model to the unit.
- Why not per block: the first build capped each run and allowed one per block. A trader could buy once,
  run in each of the next blocks and sell once, paying the fees once for many caps. That paid after 3 runs
  at c = 0%, 7 at 1%, 24 at 5% and 50 at 10%, and Arc makes more than a block a second; at 1% with
  1,000 USDC waiting, it took 44% of the pile.

### 2.3 Addendum: Deepen pool (added after sign-off, 2026-09-22)

A fifth reference plugin, listed like the others and changing nothing already deployed: it works against the
launchpad, launch router and launch pairs exactly as they are on mainnet. Contract
`contracts/plugins/launch/DeepenPoolPlugin.sol`, interface `contracts/interfaces/plugins/IDeepenPoolPlugin.sol`,
deploy script `contracts/script/DeployDeepenPool.s.sol`.

| Plugin | Behaviour |
| --- | --- |
| **Deepen pool** | "A launch pool that burns the entire way, past the curve and everything" (owner). Anyone can run it. Before graduation each run is Buyback & burn's: it buys the token with the whole offer through the launchpad and **burns** it. After graduation each run buys the token with about half the offer through the launch router and **adds** it to the token's launch pool with the rest of the USDC, minting the LP straight to `0x…dEaD`, locked forever. Tokens that do not fit the add are burned; USDC that does not fit stays for the next run. |

- **Configuration**: none. `onLaunch` data must be empty, and it is authenticated as every listed plugin's is
  (§2.1), so it works directly or as a Combo entry.
- **Deliveries**: `onFees(token, amount)` pulls exactly `amount` and credits it to that token. **Anyone may
  deliver fees for a configured token**, not only the launchpad's collection: Architex's own fee wallet can top a
  token's pot up out of the platform fees it collected, and so can the creator or a keeper. A delivery is a gift;
  nothing ever pays it back, and a token with a 0% creator fee can be fed this way alone.
- **Pacing**: Buyback & burn's, with the same constants (`CAP_BPS` 25, `RUN_INTERVAL` 1 h, `MIN_RUN_USDC` 3): a run
  offers `min(held, cap × min(now − lastRunAt, 1 h) / 1 h)`, a full cap for a token's first run, at most once per
  token per block, and `previewRun` is exactly what `run` offers. Each plugin keeps its own clock.
- **The split.** With the pool's USDC reserve `R`, an offer `U` and `q = 10,000 − (50 + c)` bps (what a buy leaves
  after both fees), a buy of `b` puts `n = b·q/10⁴` into the pool and takes out tokens that pair, at the price that
  buy leaves, with `n·(R + n)/R` USDC. The add takes all of them when `b + n + n²/R = U`, so
  `b = 2·10⁴·U·R / ((10⁴ + q)·R + √((10⁴ + q)²·R² + 4·q²·U·R))`, rounded down, at least `MIN_RUN_USDC` and at most
  `U` (`previewSplit`). That is a little over half of the offer (1 / (2 − fee), 50.1% to 52.8%). The run **syncs the
  pair first**, so the split reads the same pool the buy trades against: anything donated into a pair and not yet
  synced would otherwise be folded in by the run's own swap, between the split's reading and the add's. The budget is
  still taken from the reserves `previewRun` read, so the offer never changes.
- **The add.** After the buy the run reads the pool again and pairs the tokens it holds with what is left of the
  offer at the pool's own ratio (the Uniswap V2 router's optimal amounts): all the tokens with
  `tokens × reserveUsdc / reserveToken` USDC, or, if that is more than is left, all the USDC left with the tokens it
  matches. It transfers both into the pair and mints in the same call, with nothing in between that anyone else can
  use: `LaunchPair.mint` credits balances minus reserves, and a plain transfer into a pair can be skimmed by anyone.
  The LP is minted to `0x…dEaD`, and the run checks the amount against its own reading of the pair's formula
  (`LiquidityMismatch`). Rounding leaves **at most 4 units of an offer held** for the next run and burns at most about
  **2 units' worth of tokens**. An add too small to mint any LP is skipped (only for offers of a few units): those
  tokens are burned and the USDC waits.
- **Every token it holds is burned or added in the same run**, including anything sent to it directly, and it never
  keeps LP: LP someone sends it is passed to `0x…dEaD` by the next pool run. `run` emits `DeepenRun` with what was
  bought, added, burned and locked.
- **A run that sells out the curve** is handled as Buyback & burn handles it: the launchpad takes only what the last
  tokens cost, graduates the token and seeds the pool inside the run, the tokens bought are burned, and the rest of
  the offer stays held for the next run, which deepens the pool.

**Security (tests: `DeepenPoolPlugin.t.sol`, `DeepenPoolPacing.t.sol`, `DeepenPoolFrontRun.t.sol`,
`DeepenPoolInvariant.t.sol`, `e2e/DeepenPoolE2E.t.sol`, `e2e/DeepenPoolGasE2E.t.sol`)**

- **Every token a pool run buys goes back into the pool** (all but the rounding), so a run leaves the pool's
  **token reserve where it was**
  and raises its USDC reserve by the net buy plus the add: a full cap lifts the price by about **0.25%**, half of
  what Buyback & burn's full cap lifts it, and `k` grows. Because the token reserve does not move, a round trip
  around the runs returns the same **share** of the position at every size: sandwiching gains nothing from trading
  bigger.
- **Sandwiching one run always loses**, at any size and any creator fee: one cap lifts the price about 0.25% while
  the round trip costs 2 × (0.5% + c) ≥ 1%.
- **Front-running the paced runs** means holding. On the curve the runs are Buyback & burn's, with its bounds
  (§2.2: 3.1 h at 0.5%, 5.2 h at 1%, 9.4 h at 2%, 23 h at 5%, 48.6 h at 10%, and 1.0 h at c = 0). In the pool the bound is
  about **(2 × (0.5% + c) / 0.25% − 1) hours**; the exact-integer model (a run every second, the first a full cap,
  positions of 1 to 20,000 USDC, a pot that never limits a run) puts the shortest profitable hold at **3.0 h for
  c = 0, 7.1 h for 0.5%, 11.2 h for 1%, 19.5 h for 2%, 45.6 h for 5% and 93.0 h for 10%**, about twice Buyback &
  burn's. Past it the trader is a holder collecting what the runs give every holder, at the market's risk. A trader
  paid part of the creator fee (the creator, through a Combo) faces a smaller c.
  `DeepenPoolFrontRun.t.sol` reproduces the model to the unit.
- **Two paced plugins on one token [accepted limit].** A Combo may hold both Deepen pool and Buyback & burn. They
  pace separately, so the token spends up to two caps an hour and its price is lifted about twice as fast, which
  roughly **halves the bounds above**: on the curve about `c / 50` hours with c in basis points (0 at c = 0, 1.0 h
  at 0.5%, 2.1 h at 1%, 4.2 h at 2%, 11.0 h at 5%, 23.8 h at 10%), in the pool about `(25 + 2c) / 75` hours (0.3 h at c = 0, 1.7 h at
  0.5%, 3.1 h at 1%, 5.9 h at 2%, 14.8 h at 5%, 31.5 h at 10%). Nothing on-chain can stop it (a creator can pair any
  two plugins through a Combo, or through a plugin of their own), so the **builder should not offer both in one
  Combo**, and the marketplace copy says what pairing them costs.
- **Liquidity is anyone's.** The cap follows the pool's USDC reserve, so a large liquidity provider raises it and the
  pot spends faster; each run's price move, as a share of the reserve, is unchanged, so the bounds hold. A
  pre-existing LP gains from a run exactly what holding the same tokens and USDC would, to rounding: the add is at
  the pool's own ratio, and the LP it mints goes to the burn address.
- **The creator fee of the run's own buy** comes back to the token's plugin: straight into this pot, or, through a
  Combo, partly to its other entries. The loop converges (each round returns at most c of the buy half) and ends
  under `MIN_RUN_USDC`.
- **Reentrancy**: every state-changing entry point is `nonReentrant`; the only external callees are the launchpad,
  its launch router, the token's launch pair, the token and USDC. `onFees` never trades, so it is safe inside the
  launchpad's non-reentrant collection.
- **What anyone can take from the pot**: nothing directly. USDC leaves only through a run, to the launchpad (both
  fees), the pair (the buy and the add) and the token's `burn`. There is no owner, no admin, no sweep and no upgrade,
  the LP only ever goes to `0x…dEaD`, and a run pays its caller nothing. The rest of §9 applies unchanged: USDC sent
  straight to the plugin is credited to no token, and a blocklisted plugin or token strands its fees **[D10]**.

**Cost and tooling.** Measured end to end with cooled storage (`e2e/DeepenPoolGasE2E.t.sol`): a run costs about
265k gas on the curve (188k for a later one), 412k for the run that sells the curve out and graduates the token, and
332k in the pool (281k for a later one, 297k when it also burns tokens sent to the plugin); `createToken` with this
plugin costs about 3.28M and a collection into it 139k. Solhint is clean (one `gas-strict-inequalities` warning, the
class `LaunchToken` already carries); Slither finds 0 High and only the classes the other plugins already report
(`incorrect-equality` on `== 0` checks of computed amounts, `reentrancy-no-eth` for state written after a call to the
launchpad or the router inside `nonReentrant`, `unused-return` on `getReserves`, `timestamp`).

## 3. Launch tokens (v2)

- Fixed 1B supply, minted to the launchpad at construction. No owner, no mint.
- **`burn(amount)`**: any holder burns their own tokens; total supply drops **[D13]**.
- **USDC dividends, streamed [D15] [D21]**:
  - `distribute(amount)` pulls exactly `amount` USDC from the caller; anyone may distribute (a plugin, or a
    creator paying holders directly). `distribute(0)` is a no-op, and it never reverts for lack of eligible
    supply.
  - **Continuous accrual** (Synthetix StakingRewards style): what is distributed is paid out over
    `DRIP_PERIOD` = 24 hours, and each eligible account earns second by second in proportion to what it holds.
    A holder earns only for the time it holds, so buying, claiming and selling in one transaction earns exactly
    0, however much has been distributed and however long nobody touched the token. (This replaces the first
    D21 design, a plugin-side drip that released matured amounts to whoever held at release time: reviews
    showed any lump released that way stays snipeable.)
  - A new distribution joins what the stream still owes; the stream's end moves to the amount-weighted average
    of its old end and now + `DRIP_PERIOD`, **rounded down** (at least now + 1). A first stream runs exactly
    24 hours; dust never moves the end; holding a stream back costs a deposit of about
    (owed + amount) / (seconds to go) USDC per second, which itself goes to holders. The rate is rounded down,
    so nobody is ever over-credited; the dust stays in the token.
  - **Paused while nobody holds**: below one whole eligible token nothing accrues and the stream's end moves
    out by the paused time, so no backlog builds for whoever buys next.
  - Accrual runs first in every transfer (before balances change), in `distribute` and in `claim`; eligible
    supply only changes in transfers, so it is constant over every interval accrued. Eligible supply is tracked
    as balances cross the excluded boundary and always equals the formula below.
  - `claimable(holder)`, `claim()`, `claimFor(holder)`. `claimFor` pays the holder, never the caller. Views for
    the site: `streamRate()` (USDC per second), `streamEnd()`, `lastAccrual()`, `undistributed()`,
    `DRIP_PERIOD()`, `totalDistributed()`.
  - Excluded from earning: the launchpad (the curve inventory), the token's launch pool, the burn
    address, and `address(0)`. Eligible supply is the total supply minus the excluded balances.
  - Magnified-dividend-per-share accounting with per-account corrections (2^128 magnitude); the per-share value
    grows continuously, and the corrections keep what each account has earned fixed through transfers.
- Transfers **into** its launch pool are blocked until graduation (as v1.2).
- `pull(from, to, amount)`: callable only by the launchpad (into itself) or the launch router (into the pair),
  each passing only its own `msg.sender` as `from`. Sells on the curve and in the pool need no approval
  **[derived]**.
- **Dividends need at least one whole eligible token** (`MIN_ELIGIBLE_SUPPLY`) **[built]**: below that,
  `eligibleSupply()` reports 0 and the stream pauses. Without it, a sole holder of 1 wei could recycle
  flash-loaned USDC through distribute/claim until the per-share value overflowed on large transfers, which
  would freeze the curve. Each holder's share rounds down by at most 1 unit; the dust stays in the token.
- **Cost [built, measured in review]**: a plain transfer costs ~47k with no dividends. Once a token has had any
  distribution, a transfer in a new second while a stream runs costs ~15k more (~6k in the same second, ~6k after
  the stream ends), a first-time receiver ~40k more (its correction slot is written for the first time; nearly
  every curve buyer), and the first transfer after a token's first distribution ~66k more, once. On the real
  launchpad a running stream adds ~23–29k to a curve or pool trade (end-to-end tests). Anyone can switch this
  accounting on for any token with `distribute(1)` (0.000001 USDC) and keep a stream running with 1 unit a day;
  the cost is bounded and nothing can revert. Deploying a token costs ~0.4M more than v1.2's token.

## 4. Launch pools (separate suite)

- **`LaunchPairFactory`**: only the launchpad creates pairs, one token/USDC pair per launch token. The
  factory does not create core pairs, and the core factory never sees launch tokens.
- **`LaunchPair`**: constant product `token × usdc`. No built-in fee. **`swap` is callable only by the
  `LaunchRouter`**, so fees cannot be bypassed. `mint`/`burn` are open like any pool **[D17]**: the
  graduation liquidity is minted to the burn address, and anyone (including an LP plugin) can add more
  on top. The LP token is an ERC-20. No flash swaps. `skim`/`sync` as in v2.
- **`LaunchRouter`**:
  - Exact-in `buy(token, usdcIn, minTokensOut, to, deadline)` and `sell(token, tokensIn, minUsdcOut, to,
    deadline)`, only for graduated tokens, **USDC pairs only [D12]**.
  - It takes the platform and creator fees from the USDC side, sends them to the launchpad and calls
    `launchpad.accrueTradeFees(token, platformFee, creatorFee)`, which only the router may call.
  - Views `quoteBuy`/`quoteSell` return the output and both fees.

## 5. Launchpad v1.3

- **Deploy order:**
  1. `ArchitexLaunchpad(usdc, feeTo, feeToSetter, launchFee)`.
  2. `LaunchPairFactory(launchpad)`.
  3. `LaunchRouter(launchpad, factory, usdc)`.
  4. `launchpad.initialize(factory, router)`: one call only, by the deployer. `createToken` reverts until
     it has run.
- **Creating a token:** `createToken(name, symbol, metadataURI, creatorFeeBps, plugin, pluginData,
  initialBuyUsdc, minTokensOut, maxLaunchFee)` **[D22]**. The plugin must be an address that can pass fees
  on, and `pluginData` must be empty unless it declares the interface (§2.1).
  - It validates `creatorFeeBps ≤ 1000` and `plugin ≠ 0`, deploys the token, creates its launch pair and
    records it (`isLaunchPair`), checks the plugin (§2.1), and registers the curve (with `creatorFeeBps` and
    `plugin`).
  - It then calls `onLaunch` if the plugin declares the interface, and finally runs the optional first
    buy.
- **`Curve` struct** gains `uint16 creatorFeeBps` and `address plugin`. `pair` is now the launch pair.
- **Curve trades take a deadline [review]:** `buy(token, usdcIn, minTokensOut, to, deadline)` and
  `sell(token, tokensIn, minUsdcOut, to, deadline)` revert `Expired` when `block.timestamp > deadline`, the
  launch router's rule. **This changes v1.2's curve ABI**, which had no deadline (so only the minimum out bounded
  a delayed transaction). `createToken`'s first buy takes none: it runs in the launch transaction itself.
  Buyback & burn passes the current block's time.
- **Buy math (curve):**
  - `platformFee = ceil(usdcIn·50/10⁴)`, `creatorFee = ceil(usdcIn·c/10⁴)`, `net = usdcIn − both`.
  - On the exact-fill (sell-out) buy:
    - `gross = net + ceil(net·(50+c)/(10⁴−(50+c)))`, capped at `usdcIn`.
    - `totalFee = usdcSpent − net`, split as `platformFee = ceil(totalFee·50/(50+c))` and
      `creatorFee = totalFee − platformFee`.
- **Sell math (curve):** `gross` from the curve, both fees from `gross` (rounded up),
  `usdcOut = gross − fees`. `usdcOut == 0` reverts.
- **Accrual:** `pendingFees` (platform) and `pendingCreatorFees[token]`.
  - `collectFees()` works as in v1.2.
  - `collectCreatorFees(token)` is permissionless and non-reentrant. It pays the token's plugin as in §2.1.
- **Graduation:** as v1.2 (atomic inside the sell-out buy, direct transfers, no router, LP to the burn
  address), into the **launch pair**.
- **Events:** `Trade` carries `platformFee` and `creatorFee`. `TokenCreated` indexes token, creator and plugin
  and carries `creatorFeeBps`. Also `CreatorFeesCollected(token, plugin, amount)`,
  `PoolFeesAccrued(token, platformFee, creatorFee)`, `Initialized(pairFactory, router)`, and the router's
  `PoolTrade`.
- **Hardening [built]:** `initialize` checks the factory and router point at this launchpad and its USDC;
  `accrueTradeFees` only accepts a known, graduated token; `collectFees` is non-reentrant; a trade whose
  rounded-up fees eat the whole input or output reverts `ZeroAmount`.
- **Admin:** unchanged (`setFeeTo`, `setFeeToSetter`, `setLaunchFee` capped at 100 USDC). The admin has
  no power over creator fees, plugins, curves or pools.

## 6. Invariants (each needs a test; fuzz/invariant where possible)

1. USDC held by the launchpad == `pendingFees` + Σ `pendingCreatorFees` + Σ over ungraduated curves of
   (`virtualUsdc − VIRTUAL_USDC_0`), to the unit, unless someone sends it USDC unasked (then ≥; §9).
2. Every creator fee a plugin is credited was transferred to it in the same call.
3. No trade makes an external call to a plugin; a reverting plugin never blocks a buy, a sell, a
   graduation or another token's collection.
4. Fees never round in the trader's favour. A buy followed immediately by a sell never returns more USDC
   than was paid.
5. Launch-pool swaps succeed only through the router and always pay both fees. Direct `swap` reverts.
6. Dividends: Σ claimable + Σ claimed ≤ Σ distributed, and excluded accounts never accrue.
7. Buyback runs spend at most 0.25% of the USDC-side reserve each, prorated by the time since the token's last
   run (a full cap for its first run and after an hour), at most once per token per block.
8. The whole v1.2 security list still holds (graduation atomicity, pair lock, donated-USDC safety,
   exact-fill, two live curves independent).

## 7. Site

- **Token builder:**
  - Creator fee input from 0 to 10%, starting at 0% **[D4]**, shown on a **needle gauge** from 0 to 10%
    **[D18]**.
  - A plugin picker holding the marketplace: Creator wallet, Split, Buyback & burn, Distribute to holders,
    Combo, or a custom address. Each option has its own configuration (payees and shares, Combo
    allocations).
  - The fee-distribution plugins link comes off the Launch list; the marketplace lives in the builder.
- **Every place a launch token appears** (list, token page, trade sheet, Swap) shows its creator fee on
  the needle gauge **[D18]**, and where its fees go.
- **Token page:**
  - A Collect creator fees button, for anyone.
  - With the Distribute plugin: your claimable USDC and a Claim button.
  - With Buyback & burn: USDC waiting and a Run buyback button, and the amount burned so far.
- **Swap:** a graduated launch token trades against USDC only, through the launch router **[D12]**.
- **The Launch tab stays hidden until v1.3 is live on mainnet [D19]**.

## 8. Rollout [D20]

1. Build: contracts and tests, then the security tooling (Slither, Aderyn, Solhint, Echidna, Mythril), then
   an adversarial review, then the site.
2. **Testnet with a mintable test USDC** (same curve): take a token all the way through graduation into
   its launch pool, trade there, and run every reference plugin end to end. This closes v1.2's missing
   graduation rehearsal.
3. Mainnet: the owner deploys. The Launch tab reappears pointing at v1.3.

## 9. Accepted limits

- **Launch tokens in third-party pools.** Anyone can pair a launch token in a core-AMM pool. Trades there skip
  creator fees, and that pool's dividends can be pulled out with `claimFor` then `skim`. Nothing on-chain can
  prevent it, as with any ERC-20.
- **Launch-pool liquidity** has no router helper, so adding or removing it must be done atomically by the caller.
- **USDC blocklist.** If a plain-address Combo entry is blocklisted by USDC, that token's collections fail and
  its fees stay with the launchpad **[D10]**. A blocklisted Split payee only blocks their own release.
- **USDC sent straight to a plugin** (not through collection) is credited to no token and can't be recovered.
  The builder should not offer plugin addresses as Split payees.
- **Launch tokens held by a plugin.** A plugin contract is an ordinary holder: launch tokens sent to one keep
  earning dividends, and claiming them (`claimFor`) moves USDC into the plugin credited to no token, as above.
- **The launchpad's USDC ≥ its books.** It holds at least `pendingFees` + Σ `pendingCreatorFees` + Σ
  ungraduated curve floats, and exactly that unless someone sends it USDC unasked. A surplus (a direct
  transfer, or a sell or `skim` paid out to the launchpad) can't be recovered, by design: nothing reads its
  balance. Monitors must check `≥`, not `==`.
- **Blocklisted launch pair.** If Circle blocklists a token's launch pair before graduation, the sell-out buy
  can't seed it, so the curve can't graduate; smaller buys and sells still work.
- **Blocklisted shared plugin.** Listed plugins are shared singletons. If Circle blocklists one, collections
  for every token that uses it, directly or through a Combo, revert and their fees stay with the launchpad
  **[D10]**; what the plugin already holds is frozen too.
- **Sells need no approval.** The launchpad and the launch router `pull` the seller's tokens (§3). A contract
  that relays arbitrary launchpad or router calls (a smart account with a session key scoped to "may call the
  launchpad") lets whoever holds that key sell its tokens to themselves. Such accounts must scope keys by
  selector and arguments.
- **Configuration events are not authoritative.** A token's registered plugin may call a listed plugin's
  `onLaunch` for that token at any time (that is how a Combo configures its entries). So a creator's wallet
  can mark its token configured on Split later, which changes nothing about where fees go. The site decides
  from `pluginOf` and the stored `pluginHooks` flag (and `allocationOf` for a Combo), never from events.
- **Future launch addresses as fee destinations** (Grok review #4, final review). The destination checks know
  every launch pair and launch token that exists at launch time. Launch pairs and tokens are deployed with
  CREATE, so the address of the *next* pair or token can be computed in advance; a creator who names one as
  their plugin, a Split payee or a Combo target passes the checks. Fees sent to a future pair can later be
  taken by anyone with `skim`; fees sent to a future token are stuck. Only the creator chooses destinations,
  and could as easily name their own wallet, so this moves nobody else's funds; the site only offers
  destinations it can check.
- **Combo remainder.** Each Combo slice is `amount × bps / 10,000` rounded down and the last entry takes the
  remainder, so it gains at most (entries − 1) raw units per collection (0.000004 USDC with five entries). The
  creator chooses the order.
- **Buyback pacing can lag a busy, high-fee token.** Buyback & burn spends at most 0.25% of the USDC-side reserve
  an hour, so fees arriving faster than that wait in the plugin: for a 25,000 USDC pool, from about 15,000
  USDC of daily volume at a 10% creator fee (30,000 at 5%, 150,000 at 1%). Nothing is lost; the buyback catches
  up as volume falls or the reserve grows.
- **Blocklisted launch token.** If Circle blocklists a launch token contract, its claims and `distribute` revert:
  holders can't claim what they earned, and Distribute-to-holders collections for it (behind a Combo, the whole
  collection) fail and stay with the launchpad **[D10]**.
- **A sole holder takes the whole stream while alone.** Dividends are pro-rata by the second. After everyone
  else sells, whoever holds at least one whole token collects everything the stream pays while they are the
  only holder. Nothing builds up for them in advance (the stream pauses while nobody holds), and anyone who
  buys in shares from that second on.

## 10. Not in v1.3

Launch tokens trading against anything but USDC. Creator fees changing after launch. Plugin changes after
launch. An on-chain plugin allowlist. An LP plugin (buildable later on open `mint`, per [D17]).
