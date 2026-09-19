# Architex Launchpad — binding spec (v1)

Bonding-curve token launches that graduate into Architex pools. Adapted from the owner's draft
(`docs/launchpad/MemeDEX-design.md`): same economics (1B fixed supply, 800M on the curve, graduation at
a $35,000 market cap measured on the 800M, 0.5% platform fee, flat launch fee), but the AMM is the
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
| `VIRTUAL_USDC_0` | 2_916_666_667 (2,916.666667 USDC, 6 decimals) |
| `FEE_BPS` | 50 (0.5%), `MAX_LAUNCH_FEE` = 100e6 |
| `DEAD` | 0x000000000000000000000000000000000000dEaD |

## Curve math (constant product on virtual reserves)

Per token the launchpad stores `virtualUsdc` (starts `VIRTUAL_USDC_0`), `virtualTokens` (starts
`VIRTUAL_TOKENS_0`), `tokensSold`. `k = virtualUsdc * virtualTokens` is recomputed from the stored
reserves on every trade (never stored). Real USDC held for a curve is always
`virtualUsdc - VIRTUAL_USDC_0`, so every sold token can always be sold back (solvency invariant).
Spot price = `virtualUsdc / virtualTokens`.

- **Buy** `usdcIn` (gross): `fee = usdcIn * FEE_BPS / 10_000`; `net = usdcIn - fee`;
  `tokensOut = virtualTokens - ceil(k / (virtualUsdc + net))`. If `tokensOut` exceeds the remaining
  `CURVE_SUPPLY - tokensSold`, fill exactly the remainder: `net = ceil(k / (virtualTokens - remaining)) - virtualUsdc`,
  `fee = ceil(net * FEE_BPS / (10_000 - FEE_BPS))`, and pull only `net + fee` from the buyer (never
  pull-then-refund). Rounding always favours the curve.
- **Sell** `tokensIn`: `gross = virtualUsdc - ceil(k / (virtualTokens + tokensIn))`;
  `fee = gross * FEE_BPS / 10_000`; seller receives `gross - fee`.
- Fees are transferred to `feeTo` in the same transaction. `feeTo` is never the zero address.
- With these constants, selling out the curve ends at price 0.00004375 USDC (= $35,000 on 800M),
  having raised ≈ 8,750 USDC, and `8,750 / 200M` is the same price: the pool opens where the curve ends.

## Lifecycle

1. `createToken(name, symbol, metadataURI, initialBuyUsdc, minTokensOut)`: pulls `launchFee` to
   `feeTo`, deploys `LaunchToken`, takes `pair = factory.getPair(token, usdc)` or creates it if absent
   (**never revert because the pair already exists**: anyone can pre-create it), calls
   `token.initPair(pair)`, records the curve, emits `TokenCreated`, then performs the creator's
   optional first buy in the same transaction (anti-snipe). Name 1–32 bytes, symbol 1–10 bytes,
   metadataURI ≤ 256 bytes.
2. `buy` / `sell` with slippage bounds and a `to` recipient, until the curve sells out. `sell` needs no
   ERC-20 approval: the launchpad calls `token.launchpadPull(msg.sender, amount)` and **only ever
   with `msg.sender`**.
3. **Graduation** happens inside the buy that sells the last curve token, atomically:
   `token.markGraduated()`, transfer `POOL_SUPPLY` tokens and all of the curve's real USDC to the
   pair, `pair.mint(DEAD)` (liquidity locked forever), mark the curve graduated, emit `Graduated`.
   It must **not** use the router: a donated-and-`sync()`ed pair (reserves `(0, x)`) would make the
   router's quote revert and brick graduation. Direct `mint` on balances is immune.
4. After graduation `buy`/`sell` revert with `CurveGraduated()`; trading continues on the Architex pair.

## Token transfer rule

While not graduated, `LaunchToken` reverts any transfer whose recipient is `pair`. Nobody can seed the
pair early, so `totalSupply` of the pair is 0 at graduation and the opening price is the curve's.
All other transfers are free from the first buy.

## Admin surface (the owner's Ledger)

`feeToSetter` can `setFeeTo(nonzero)`, `setFeeToSetter`, and `setLaunchFee(≤ MAX_LAUNCH_FEE)`. Nothing
else is mutable: no pause, no upgrade, no access to curve funds, no parameter changes to live curves.

## Security requirements (each needs a test)

- Reentrancy guard on `createToken`/`buy`/`sell`; checks-effects-interactions; SafeERC20.
- Solvency invariant (fuzz + invariant test): for every curve, USDC held ≥ Σ(`virtualUsdc - VIRTUAL_USDC_0`)
  over non-graduated curves; `k` never decreases across a trade; `tokensSold ≤ CURVE_SUPPLY`.
- Round trip: buy then immediately sell the same tokens never returns more USDC than was paid.
- Graduation is atomic; works when the pair pre-exists; works when USDC was donated to the pair and
  `sync()` called; LP tokens end at `DEAD`; pool price equals the curve's final price within 1e-6 relative.
- Transfers to the pair revert before graduation and succeed after.
- `launchpadPull` is callable only by the launchpad; `initPair`/`markGraduated` only once, only by it.
- Exact-fill on the last buy never over-charges and never leaves dust tokens unsold.
- Fee-on-transfer / rebasing are irrelevant: the only quote asset is USDC, the only tokens are ours.

## Views for the frontend

`curves(token)`, `tokensLength()`, `tokenAt(i)`, `curvesPage(start, count)`, `quoteBuy`, `quoteSell`,
`spotPrice(token)` (USDC per whole token, 1e18-scaled), `marketCap(token)` (spot × 800M, USDC 6-dec),
`progressBps(token)` (`tokensSold / CURVE_SUPPLY`).

## Deployment

Testnet first: `usdc = 0x3600000000000000000000000000000000000000`,
`factory = 0x6362f5A0fc007AB7D1e61f99D3F4eB04360D060a` (Architex factory on Arc testnet 5042002).
Mainnet only after the adversarial review (Grok) and the fixes (Arc Studio) are both done.
