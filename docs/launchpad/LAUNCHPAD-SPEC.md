# Architex Launchpad — binding spec (v1.1)

Bonding-curve token launches that graduate into Architex pools. Adapted from the owner's draft
(`docs/launchpad/MemeDEX-design.md`): same economics (1B fixed supply, 800M on the curve, graduation at
a $100,000 market cap measured on the 800M (v1.2; v1.1 graduated at $35,000), 0.5% platform fee, flat launch fee), but the AMM is the
existing Architex factory/pair instead of a second pool implementation. LP staking / epoch fee
distribution and dynamic AMM fees are **out of scope for v1**.

The ABI in `contracts/interfaces/IArchitexLaunchpad.sol` and `ILaunchToken.sol` is frozen: the frontend
is built against it. Solidity 0.8.28, OpenZeppelin 5.1.0, EVM `paris`, `via_ir`, same as the AMM.

## Contracts

- `ArchitexLaunchpad` — the only entry point: creates tokens, runs every curve, graduates them.
  Constructor `(address usdc, address factory, address feeTo, address feeToSetter, uint256 launchFee)`.
- `LaunchToken` — OZ ERC20, 18 decimals, 1,000,000,000e18 minted once to the launchpad in the
  constructor, no mint/burn function afterwards, no owner.

## Constants (immutable)

| Name | Value |
|---|---|
| `TOTAL_SUPPLY` | 1_000_000_000e18 |
| `CURVE_SUPPLY` | 800_000_000e18 (sold on the curve) |
| `POOL_SUPPLY` | 200_000_000e18 (seeds the Architex pair at graduation) |
| `VIRTUAL_TOKENS_0` | 1_066_666_667e18 |
| `VIRTUAL_USDC_0` | 8_333_333_333 (8,333.333333 USDC, 6 decimals). Sets the scale: a curve raises 3× this. v1.1 used 2_916_666_667 (an 8,750 USDC raise), which the owner judged too thin a pool |
| `FEE_BPS` | 50 (0.5%), `MAX_LAUNCH_FEE` = 100e6 |
| `DEAD` | 0x000000000000000000000000000000000000dEaD |

## Curve math (constant product on virtual reserves)

Per token the launchpad stores `virtualUsdc` (starts `VIRTUAL_USDC_0`), `virtualTokens` (starts
`VIRTUAL_TOKENS_0`), `tokensSold`. `k = virtualUsdc * virtualTokens` is recomputed from the stored
reserves on every trade (never stored). Real USDC held for a curve is always
`virtualUsdc - VIRTUAL_USDC_0`, so every sold token can always be sold back (solvency invariant).
Spot price = `virtualUsdc / virtualTokens`.

- **Buy** `usdcIn` (gross): `fee = ceil(usdcIn * FEE_BPS / 10_000)` (fees round UP: a floor makes
  every trade under 200 units free); `net = usdcIn - fee`;
  `tokensOut = virtualTokens - ceil(k / (virtualUsdc + net))`. If `tokensOut >= remaining`
  (`remaining = CURVE_SUPPLY - tokensSold`), fill exactly the remainder:
  `net = ceil(k / (virtualTokens - remaining)) - virtualUsdc`,
  `usdcSpent = min(usdcIn, net + ceil(net * FEE_BPS / (10_000 - FEE_BPS)))`, `fee = usdcSpent - net`.
  **`usdcSpent` is never greater than `usdcIn`**; pull exactly `usdcSpent` (never pull-then-refund).
  `tokensOut == 0` reverts `ZeroAmount`. Rounding always favours the curve.
- **Sell** `tokensIn`: `gross = virtualUsdc - ceil(k / (virtualTokens + tokensIn))`;
  `fee = ceil(gross * FEE_BPS / 10_000)`; seller receives `gross - fee`; zero proceeds revert `ZeroAmount`;
  `tokensIn > tokensSold` reverts `ExceedsSold`. `quoteSell` reverts exactly where `sell` would.
- `tokensSold` is **net**: `+=` on buys, `-=` on sells. Circulating supply before graduation equals
  `tokensSold`, so nobody can sell more than it; `virtualUsdc` never drops below `VIRTUAL_USDC_0`.
- `quoteBuy` / `quoteSell` must share the trade functions' code path (one internal pure function each),
  including the cap and the `graduates` flag.
- **Fees are accrued, never pushed.** Trade fees and the launch fee add to `pendingFees` inside the
  launchpad; the permissionless `collectFees()` sends `pendingFees` to `feeTo`. A blocklisted or
  reverting `feeTo` (Arc USDC enforces a blocklist) must never be able to stop a trade, a launch or a
  graduation.
- Arc trap: native USDC (18 decimals) and the ERC-20 interface (6 decimals) are the same balance.
  Never read `balanceOf` or `address(this).balance` for accounting; every amount comes from the
  curve's own stored numbers. No `receive`/`fallback`.
- Reference vectors (must match to the unit; they come from `src/lib/curve.ts`): see "Test vectors".
- With these constants a curve opens at a $6,250 market cap and selling it out ends at price 0.000125 USDC
  (= $100,000 on 800M, a 16× rise), having raised ≈ 25,000 USDC, and `25,000 / 200M` is the same price:
  the pool opens where the curve ends, holding 25,000 USDC × 200M tokens.

## Lifecycle

1. `createToken(name, symbol, metadataURI, initialBuyUsdc, minTokensOut)`: pulls `launchFee` from the
   creator into `pendingFees`, deploys `LaunchToken`, takes `pair = factory.getPair(token, usdc)` or creates it if absent
   (**never revert because the pair already exists**: anyone can pre-create it), calls
   `token.initPair(pair)`, records the curve, emits `TokenCreated`, then performs the creator's
   optional first buy in the same transaction (anti-snipe). Name 1–32 bytes, symbol 1–10 bytes,
   metadataURI ≤ 256 bytes.
2. `buy` / `sell` with slippage bounds and a `to` recipient, until the curve sells out. `sell` needs no
   ERC-20 approval: the launchpad calls `token.launchpadPull(msg.sender, amount)` and **only ever
   with `msg.sender`**.
3. **Graduation** happens inside the buy that sells the last curve token, atomically and in this
   order with no other external call in between: (a) the buyer's USDC is already pulled and the fee
   accrued; (b) `require(pair.totalSupply() == 0)`; (c) mark the curve graduated and call
   `token.markGraduated()`; (d) transfer exactly `POOL_SUPPLY` tokens and exactly
   `usdcSeeded = virtualUsdc - VIRTUAL_USDC_0` **of that curve** to the pair (never a balance);
   (e) `liquidityLocked = pair.mint(DEAD)` (the return value, liquidity locked forever);
   (f) emit `Graduated`.
   It must **not** use the router: a donated-and-`sync()`ed pair (reserves `(0, x)`) would make the
   router's quote revert and brick graduation. Direct `mint` on balances is immune.
4. After graduation `buy`/`sell` revert with `CurveGraduated()`; trading continues on the Architex pair.

## Token transfer rule

While not graduated, `LaunchToken` reverts any transfer whose recipient is `pair`. Nobody can seed the
pair early, so `totalSupply` of the pair is 0 at graduation and the opening price is the curve's.
All other transfers are free from the first buy.

## Admin surface (the owner's Ledger)

`feeToSetter` can `setFeeTo` (not zero, not the launchpad itself), `setFeeToSetter` (setting the zero
address is an irreversible renounce; say so in NatSpec) and `setLaunchFee(≤ MAX_LAUNCH_FEE)`. Nothing
else is mutable: no pause, no upgrade, no access to curve funds, no parameter changes to live curves.
`name`, `symbol` and `metadataURI` are untrusted bytes with length limits only; uniqueness is not
enforced and rendering rules live in `FRONTEND-BRIEF.md`.

## Security requirements (each needs a test)

- Reentrancy guard on `createToken`/`buy`/`sell`; checks-effects-interactions; SafeERC20.
- Solvency invariant (fuzz + invariant test): USDC held ≥ `pendingFees` + Σ(`virtualUsdc - VIRTUAL_USDC_0`)
  over non-graduated curves; `k` never decreases across a trade; `tokensSold ≤ CURVE_SUPPLY`;
  `virtualTokens + tokensSold == VIRTUAL_TOKENS_0`. `SafeCast` on every `uint128` write.
- Round trip: buy then immediately sell the same tokens never returns more USDC than was paid.
- Graduation is atomic; works when the pair pre-exists; never reverts because USDC was donated to the
  pair (with or without `sync()`); LP tokens end at `DEAD`; the pool opens at the curve's final price
  within 1e-6 relative **when the pair held no USDC beforehand** (a donation only gifts value to the pool).
- Two live curves: graduating A leaves B's USDC untouched and B can still sell and graduate.
- A `feeTo` that reverts or is blocklisted never blocks `createToken`, `buy`, `sell` or graduation.
- Transfers to the pair revert before graduation and succeed after.
- `launchpadPull` is callable only by the launchpad; `initPair`/`markGraduated` only once, only by it.
- Exact-fill on the last buy never over-charges and never leaves dust tokens unsold.
- Fee-on-transfer / rebasing are irrelevant: the only quote asset is USDC, the only tokens are ours.

## Views for the frontend

`curves(token)` (reverts `UnknownToken` for an unknown token), `tokensLength()`, `tokenAt(i)`,
`curvesPage(start, count)` (`count` clamped to 100), `quoteBuy`, `quoteSell`, `pendingFees()`, and:

```text
spotPrice   = virtualUsdc * 1e36 / virtualTokens          // USDC units (6 dec) per WHOLE token, 1e18-scaled
marketCap   = virtualUsdc * CURVE_SUPPLY / virtualTokens  // USDC 6 dec; about 100_000e6 at graduation
progressBps = tokensSold * 10_000 / CURVE_SUPPLY          // multiply first
```

`Trade.trader` is always `msg.sender`. `Trade.usdcAmount` is the gross a buyer paid (fee included) or
the gross leaving the curve on a sell (the seller receives `usdcAmount - fee`); the virtual reserves in
the event are post-trade.

## Test vectors (from `src/lib/curve.ts`, must match to the unit)

| Case | Input | Expected |
|---|---|---|
| start | — | `spotPrice` 7812499997246093750, `marketCap` 6249999997 |
| V1 buy from start | `usdcIn` 100000000 | `tokensOut` 12585726430898500955823408, `fee` 500000, `usdcSpent` 100000000, then `virtualUsdc` 8432833333, `virtualTokens` 1054080940569101499044176592 |
| V3 sell all of V1's tokens | `tokensIn` 12585726430898500955823408 | gross 99499999, `fee` 497500, `usdcOut` 99002499 |
| V2 buy from start, sells out | `usdcIn` 1000000000000 | `tokensOut` 800000000000000000000000000, `usdcSpent` 25125628109, `fee` 125628141, graduates, `usdcSeeded` 24999999968, `marketCap` 99999999778, `spotPrice` 124999999722500000346 |
| V4 smallest sell-out input | `usdcIn` 25125628109 | graduates with `usdcSpent` 25125628109; `usdcIn` 25125628108 does not graduate |
| V5 dust | `usdcIn` 199 | `fee` 1, `tokensOut` 25343999406760334071; `usdcIn` 1 reverts `ZeroAmount` |

## Deployment

Testnet first: `usdc = 0x3600000000000000000000000000000000000000`,
`factory = 0x6362f5A0fc007AB7D1e61f99D3F4eB04360D060a` (Architex factory on Arc testnet 5042002).
Mainnet only after the adversarial review (Grok) and the fixes (Arc Studio) are both done.
