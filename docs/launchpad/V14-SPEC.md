# Launchpad v1.4: graduate into Uniswap v4 (draft)

Status: **draft for the owner**, 2026-09-25. Nothing here is built yet. Sections marked **[decided]** are the owner's
calls; **[proposed]** are defaults to confirm; **[research]** waits on facts still being gathered about Uniswap v4 on
Arc. v1.3 (V13-SPEC.md) stays live for the tokens it launched; this spec only covers new launches.

## 0. Why

Graduated v1.3 tokens trade in our own launch pools, which only our router can trade, so no wallet or aggregator
reaches them. Argus, the largest launchpad on Arc, puts every token in a Uniswap v4 pool with a fee hook and made
about $18k a day in protocol revenue in its first week. Uniswap did over $410M of volume on Arc's first day. v1.4
keeps what is ours (identical curves, creator fees routed to plugins, streamed USDC dividends, locked liquidity) and
graduates into Uniswap, where the trading already is, with a hook that keeps charging our fees.

## 1. Owner decisions

- **D1 [decided]: curve first, then Uniswap.** A token trades on the Architex bonding curve exactly as in v1.3. When
  the curve sells out, its pool opens on Uniswap v4 with the Architex hook, instead of in a `LaunchPair`.
- **D2 [decided]: anti-sniping fee, locked into the pool.** A surcharge that starts high and falls to nothing over
  the first seconds, both when a token opens on the curve and when its Uniswap pool opens. What it collects becomes
  permanent liquidity in that token's pool.
- **D3 [decided]: outside liquidity is the creator's choice.** At launch the creator picks an open pool (anyone may add
  and remove their own liquidity) or a closed one (only the locked launch liquidity and listed liquidity plugins).
  Fixed forever, like the creator fee.
- **Carried over from v1.3 unchanged:** every curve identical (same constants); 0.5% platform fee and the creator's
  0 to 10% on every buy and sell, both in USDC and rounded up; the creator fee's destination chosen at launch from the
  plugin marketplace; the 1 USDC launch fee; the launch token with burn and streamed USDC dividends; permissionless
  fee collection.

## 2. Uniswap v4 on Arc

Mainnet (developers.uniswap.org, code confirmed on chain 2026-09-25):

| Contract | Address |
| --- | --- |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x6049c9a0e26405C0985f9E3685C87d0aE917f82B` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| Universal Router | `0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

A PoolManager with the same code is at the same address on Arc Testnet; whether the periphery is there too is
**[research]** (if not, the rehearsal deploys its own).

**Routing [research].** Uniswap's app, API and the aggregators that use it route through a v4 hook only if it is on
Uniswap's per-chain routing allowlist. A hook that uses delta flags or dynamic fees (any fee hook) has to be
submitted: Uniswap checks routing compatibility (not security), and needs the source verified on the explorer and a
live pool with liquidity. Until it is listed, graduated tokens still trade on architex.fun and through any integrator
that calls the PoolManager directly. Whether competitors' hooks are listed on Arc, and how long it took, is being
researched.

## 3. The hook: `ArchitexLaunchHook`

One hook contract for every v1.4 pool, deployed at a CREATE2 address whose low bits carry its permissions.

- **`beforeInitialize`:** only the v1.4 launchpad may initialize a pool with this hook, and only for a token it
  launched, at graduation. Nobody can create one of our pools early or at the wrong price.
- **`beforeAddLiquidity` / `beforeRemoveLiquidity`:** closed pools accept liquidity only from the launchpad (the
  graduation position) and listed liquidity plugins; open pools accept anyone. The locked positions belong to the
  hook, which has no function that removes them. Outside LPs in an open pool can remove their own liquidity.
- **`beforeSwap` / `afterSwap` with return deltas:** take the platform fee and the creator fee **in USDC on both
  sides**, computed on the swap's USDC amount and rounded up, whichever side is exact:
  - a buy pays them out of the USDC in; a sell out of the USDC out (the v1.3 rule);
  - the hook moves them to the launchpad and calls `launchpad.accrueTradeFees(token, platformFee, creatorFee)`, the
    same books v1.3's launch router writes, so collection and every plugin work unchanged;
  - during the opening window (§5) it also takes the surcharge.
- **LP fee [proposed]:** 0 for closed pools, as in v1.3's launch pools; the trading cost is the platform and creator
  fees. For open pools see §6.
- **PoolKey:** the token and USDC, sorted; the LP fee; a tick spacing wide enough for one full-range position
  **[proposed: 200]**; the hook. Which USDC currency (the ERC-20 at `0x3600…`, or native) is **[research]**; v1.3 and
  the rest of Architex use the ERC-20.

## 4. Graduation into Uniswap

- At `createToken` the launchpad records the token's PoolKey (deterministic) and the creator's open/closed choice.
  No pool exists yet, and the hook stops anyone else making it.
- The sell-out buy, in the same transaction as today:
  1. initializes the v4 pool at the curve's final price;
  2. adds the graduation liquidity: the 200M pool tokens and the USDC the curve raised, as one full-range position
     owned by the hook, locked forever (v1.3 minted the LP to the burn address instead);
  3. adds the curve's anti-snipe collection (§5) as locked liquidity too;
  4. burns any tokens rounding leaves over, as v1.3 does.
- **LaunchToken v1.4:** excludes the PoolManager from dividends (v4 holds every pool's tokens there) instead of the
  launch pair; everything else in V13-SPEC §3 carries over. Transfers into the PoolManager before graduation are
  blocked, as transfers into the launch pair are in v1.3.

## 5. Anti-sniping [decided: D2; parameters proposed]

- **When:** for `W` seconds after `createToken` (buys on the curve) and for `W` seconds after graduation (swaps in the
  pool that buy the token). Sells never pay it.
- **How much [proposed]:** a surcharge that starts at 90% and falls to 0 over `W` = 10 seconds (about twenty Arc
  blocks), on top of the normal fees. Argus uses up to 99% over 3 seconds.
- **The creator's first buy** runs in the launch transaction itself, before any bot can act, so it is exempt
  **[proposed]**.
- **Where it goes [decided]: locked into the pool.**
  - In the pool: the hook adds it as locked liquidity. The proposal is a USDC-only position just below the current
    price, a bid wall that nobody can ever withdraw. Adding it needs no swap, so there is nothing to sandwich (the
    Deepen pool review's lesson).
  - On the curve there is no pool yet: the launchpad holds it for the token and locks it in at graduation, the same
    way. **[proposed]** If a curve never graduates, it stays in the launchpad for good, like any other stranded
    balance. It never changes the curve, so every curve stays identical.

## 6. Open or closed pools [decided: D3]

- `createToken` takes a new `openPool` flag, stored with the curve and shown on the token page.
- **Closed (the builder's default [proposed]):** only the graduation position, the anti-snipe liquidity and listed
  liquidity plugins (Deepen pool v1.4). Nobody can move the pool's liquidity to game a plugin's budget.
- **Open:** anyone may add and remove their own liquidity; the locked positions still never move.
- **LP fee in open pools [owner decision still needed]:** with no LP fee, outside liquidity earns nothing, so it only
  comes from someone paid to provide it (a market maker hired by the project). Options: keep 0; or let the creator
  pick an LP fee (0.05%, 0.3% or 1%) for an open pool, on top of the platform and creator fees.

## 7. Plugins

- The plugin interface (V13-SPEC §2.1) is unchanged. Split, Distribute to holders and Combo are redeployed as-is for
  the v1.4 launchpad (they bind to a launchpad at construction).
- **Deepen pool v1.4:** on the curve, unchanged. In the pool it buys through the PoolManager, burns its burn share,
  and adds the rest to the hook's locked position. Its cap stays 0.25% of the locked USDC (the H1 fix), which in v4
  is the USDC in the hook's locked positions.
- **Buyback & burn:** not relisted; Deepen pool at a 100% burn share does its job.

## 8. Trading after graduation

- **architex.fun:** a small Architex router (exact-in buy and sell with a minimum out and a deadline, via the
  PoolManager's unlock callback), or the Universal Router with Permit2 **[proposed: our router first, the Universal
  Router once the hook is allowlisted]**. Quotes from the v4 Quoter, which runs the hook, so they include every fee.
- **Everyone else:** wallets, the Uniswap app and aggregators through the Universal Router, once Uniswap lists the
  hook (§2).

## 9. Site, charts and listing feeds

- Trade history and charts read the PoolManager's `Swap` events for the token's pool id, plus the hook's fee events;
  prices and liquidity from StateView.
- The lister feeds (CoinGecko standard) list v1.4 pools by pool id; the token list and docs add the hook, the
  launchpad and the router.
- The builder gains the open/closed choice; the token page shows it, the anti-snipe window, and which pool the token
  trades in.

## 10. Build, review and rollout

The v1.3 bar: unit, fuzz and invariant tests against a real v4 PoolManager; end-to-end tests of every plugin through
graduation; adversarial reviews (Claude lenses and Grok) until no High is open; an Arc Testnet rehearsal; the owner
deploys to mainnet; then the Uniswap routing allowlist submission with a live pool. New invariants to add to V13-SPEC
§6: the hook never lets a swap skip the fees; the locked positions can never shrink; only the launchpad can create a
pool with the hook; a closed pool's liquidity only ever grows.

## 11. Still open

1. The LP fee for open pools (§6).
2. The anti-snipe numbers (90% falling to 0 over 10 seconds) and whether the creator's first buy is exempt (§5).
3. What happens to a never-graduated curve's anti-snipe collection (§5).
4. Whether the builder stops offering v1.3 launches the day v1.4 is live (proposed: yes; v1.3 tokens keep trading
   where they are).
