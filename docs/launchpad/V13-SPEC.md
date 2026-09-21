# Architex Launchpad v1.3 — binding spec

Signed off by the owner 2026-09-21 and built on branch `v13`. This file describes what was built, including
the builders' safer interpretations (marked **[built]**) and two later owner decisions (**[D21]**, **[D22]**).

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
| **Split** | Up to **20** payees with fixed shares, set in `onLaunch` data **[D16]**. Per-token accounting; each payee (or anyone for them) pulls `release(token, payee)`. Payees can't be zero, duplicates, the plugin, the launchpad, USDC or the token **[built]**: fees sent to any of those would be stuck. |
| **Buyback & burn** | Anyone can run it **[D14]**. Each run buys the token with that token's accrued USDC (through the launchpad while on the curve, the launch router after graduation) and **burns** it, so total supply drops **[D13]**. |
| **Distribute to holders** | Pays the USDC to the token's holders pro-rata through the token's built-in dividend tracker **[D15]**, **dripped over 24 hours** so a bot can't buy, collect, claim and sell in one transaction **[D21]**. A new deposit restarts the 24-hour window for everything still undistributed. Anyone can `drip(token)`; holders use `dripAndClaim(token)` on the token page. |
| **Combo** | Splits a token's fees across up to 5 plugins by basis points summing to 10,000, forwarding `onLaunch` data to each. An entry that isn't a plugin must have empty data, which catches a mistyped plugin address **[built]**. A Combo inside a Combo can't configure listed plugins. |

**Buyback & burn chunking [derived]**: each run spends at most **0.25% of the USDC-side reserve** (the
curve's `virtualUsdc`, or the pool's USDC reserve), and **at most one run per token per block**. A
sandwich attacker pays at least ~1% in platform fees on the round trip, more than the ≤ ~0.5% price
move of one chunk, so sandwiching a run loses money. A run does not take a slippage bound, because the
cap is the protection.

## 3. Launch tokens (v2)

- Fixed 1B supply, minted to the launchpad at construction. No owner, no mint.
- **`burn(amount)`**: any holder burns their own tokens; total supply drops **[D13]**.
- **USDC dividend tracker [D15]**:
  - `distribute(amount)` pulls USDC from the caller; anyone may distribute.
  - `claimable(holder)`, `claim()`, `claimFor(holder)`. `claimFor` pays the holder, never the caller.
  - Excluded from earning: the launchpad (the curve inventory), the token's launch pool, the burn
    address, and `address(0)`. Eligible supply is the total supply minus the excluded balances.
  - Standard magnified-dividend-per-share accounting with per-account corrections (2^128 magnitude). A
    distribution with zero eligible supply reverts.
- Transfers **into** its launch pool are blocked until graduation (as v1.2).
- `pull(from, to, amount)`: callable only by the launchpad (into itself) or the launch router (into the pair),
  each passing only its own `msg.sender` as `from`. Sells on the curve and in the pool need no approval
  **[derived]**.
- **Dividends need at least one whole eligible token** (`MIN_ELIGIBLE_SUPPLY`) **[built]**: below that,
  `eligibleSupply()` reports 0 and `distribute` reverts. Without it, a sole holder of 1 wei could recycle
  flash-loaned USDC through distribute/claim until the per-share value overflowed on large transfers, which
  would freeze the curve. Each holder's share rounds down by at most 1 unit; the dust stays in the token.

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
  initialBuyUsdc, minTokensOut, maxLaunchFee)` **[D22]**. The plugin can't be zero or the launchpad itself.
  - It validates `creatorFeeBps ≤ 1000` and `plugin ≠ 0`, deploys the token, creates its launch pair, and
    registers the curve (with `creatorFeeBps` and `plugin`).
  - It then calls `onLaunch` if the plugin declares the interface, and finally runs the optional first
    buy.
- **`Curve` struct** gains `uint16 creatorFeeBps` and `address plugin`. `pair` is now the launch pair.
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
   (`virtualUsdc − VIRTUAL_USDC_0`), to the unit.
2. Every creator fee a plugin is credited was transferred to it in the same call.
3. No trade makes an external call to a plugin; a reverting plugin never blocks a buy, a sell, a
   graduation or another token's collection.
4. Fees never round in the trader's favour. A buy followed immediately by a sell never returns more USDC
   than was paid.
5. Launch-pool swaps succeed only through the router and always pay both fees. Direct `swap` reverts.
6. Dividends: Σ claimable + Σ claimed ≤ Σ distributed, and excluded accounts never accrue.
7. Buyback runs spend ≤ 0.25% of the USDC-side reserve, at most once per token per block.
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

## 10. Not in v1.3

Launch tokens trading against anything but USDC. Creator fees changing after launch. Plugin changes after
launch. An on-chain plugin allowlist. An LP plugin (buildable later on open `mint`, per [D17]).
