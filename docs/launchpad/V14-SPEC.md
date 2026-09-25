# Launchpad v1.4: graduate into Uniswap v4 (draft)

Status: **built on branch `v14` and reviewed twice (Grok #7, Claude #7: no High; every finding fixed or accepted in
§10), not deployed**, 2026-09-25. Contracts in `contracts-v14/src`, tests in `contracts-v14/test` (run with
`FOUNDRY_PROFILE=v14 forge test`; CI runs them too). Sections marked **[decided]** are the owner's
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
  and remove their own liquidity) or a closed one (only the liquidity the hook adds: the locked launch position and the
  bids; a listed liquidity plugin such as Deepen pool v1.4 will add through the hook).
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

The whole v4 stack is on Arc Testnet at the same addresses (PoolManager, StateView and Quoter with identical code; the
PositionManager, the Universal Routers and Permit2 at the same addresses with their own immutables), so the rehearsal
uses Uniswap's own contracts there.

**Routing [researched 2026-09-25].** Uniswap's app and API route through a v4 hook only if it is on Uniswap's
per-chain routing allowlist; a hook that uses delta flags or dynamic fees (any fee hook, ours included) has to be
submitted, and Uniswap's public routing code has no Arc allowlist entries yet. In a live test the Uniswap app sent a
buyer of an Argus token through a junk unhooked copy pool at 79% price impact instead. Aggregators are further along:
0x and KyberSwap already route hundreds of swaps an hour into Argus's delta-fee hooks on Arc. So graduated tokens reach
wallets first through architex.fun and those aggregators, then the Uniswap app once listed. Argus's newest hook takes
its fees exactly as ours does (USDC only, beforeSwap delta when USDC is the fixed side, afterSwap otherwise, LP fee 0).
Arc specifics that shaped the code: pools use the ERC-20 USDC at `0x3600…` (as nearly all Arc launchpads do), settled
by sync, transfer, settle; about two blocks share each one-second timestamp, so windows count blocks; a fork cannot run
the USDC precompile, so tests etch Uniswap's PoolManager code with a mock USDC and the rehearsal runs on Arc Testnet,
where the whole v4 stack sits at the mainnet addresses.

## 3. The hook: `ArchitexLaunchHook`

One hook contract for every v1.4 pool (`contracts-v14/src/ArchitexLaunchHook.sol`), deployed at a CREATE2 address
whose low 14 bits carry exactly its permissions (`0x28EC`). It imports nothing BUSL: v4-core's StateLibrary pulls in
the BUSL `Position.sol`, so the hook reads the pool's price with its own copy of `getSlot0`.

- **`beforeInitialize`:** v4 skips a hook's own callbacks when the hook itself is the caller, so the hook opens pools as
  itself (in `graduate`, launchpad only) and refuses every other initializer. Nobody can open one of our pools early or
  at the wrong price.
- **`beforeAddLiquidity`:** closed pools accept liquidity only from the hook itself (v4 skips the callback when the hook
  is the caller, so reaching it at all means an outsider); open pools accept anyone. There is no remove callback: v4
  keys every position by its owner, the locked positions belong to the hook, and the hook has no code that removes
  liquidity. Outside LPs in an open pool can remove their own.
- **`beforeDonate`:** refuses every donation. A donation accrues fees to the positions in range, and v4 folds a
  position's fees into its owner's next `modifyLiquidity`; refusing them keeps every hook position fee-free (Claude
  review #7, M1).
- **`beforeSwap` / `afterSwap` with return deltas:** take the platform fee and the creator fee **in USDC on both
  sides**, computed on the swap's USDC amount and rounded up, whichever side is exact:
  - a buy pays them out of the USDC in; a sell out of the USDC out (the v1.3 rule);
  - the hook keeps them in the PoolManager as its own ERC-6909 USDC claims (`mint`), credited to the token. A swap
    never moves USDC and calls nothing but the PoolManager, so it works whatever USDC the PoolManager holds, whenever
    the trader's router pays, and whatever happens to the launchpad's address (a USDC blocklist included);
  - `launchpad.syncPoolFees(token)` (permissionless, with a batch form) has the hook burn the claims, take the USDC to
    the launchpad and return the amounts, which the launchpad books in the same places v1.3's launch router did
    (`pendingFees`, `pendingCreatorFees`). `collectCreatorFees` syncs first, so collection and every plugin work
    unchanged. Until a sync, the hook's `pendingPlatform(token)` and `pendingCreator(token)` show what it holds;
  - during the opening window (§5) it also takes the surcharge, held as claims too;
  - a swap that a price limit stops early is refused when the fees were fixed on the trader's own USDC, so nobody pays
    fees on USDC the pool did not take or give (`PartialFill`).
- **LP fee [proposed]:** 0 for closed pools, as in v1.3's launch pools; the trading cost is the platform and creator
  fees. For open pools see §6.
- **PoolKey:** the token and USDC, sorted; LP fee 0; tick spacing 200; the hook. USDC is the 6-decimal ERC-20 at
  `0x3600…`, as in v1.3 and nearly every Arc launchpad, settled by sync, transfer, settle.

## 4. Graduation into Uniswap

- The token's PoolKey is deterministic: the hook derives it from the token and USDC (`poolKeyOf`). At `createToken`
  the launchpad records the creator's open/closed choice. No pool exists yet, and the hook stops anyone else making it.
- The sell-out buy, in the same transaction as today:
  1. initializes the v4 pool at the curve's final price;
  2. adds the graduation liquidity: the 200M pool tokens and the USDC the curve raised, as one full-range position
     owned by the hook, locked forever (v1.3 minted the LP to the burn address instead);
  3. turns the curve's anti-snipe collection (§5), with any USDC the full-range position could not take, into the
     hook's claims and locks it as the token's first bid;
  4. burns any tokens rounding leaves over, as v1.3 does.
- **LaunchToken v1.4:** excludes the PoolManager from dividends (v4 holds every pool's tokens there) instead of the
  launch pair; everything else in V13-SPEC §3 carries over. Transfers into the PoolManager before graduation are
  blocked, as transfers into the launch pair are in v1.3.

## 5. Anti-sniping [decided: D2; parameters proposed]

- **When:** for 20 blocks (about 10 seconds on Arc) after `createToken` (buys on the curve) and after graduation (buys
  in the pool). Sells never pay it. It counts blocks, not seconds: Arc makes about two blocks per one-second timestamp,
  which is why Argus's 3-second window protects only about two blocks.
- **How much [default the owner did not change]:** 90% in the opening block, falling linearly to 0 over the 20 blocks,
  on top of the normal fees, and capped so platform, creator and snipe fees together take at most 99%.
- **The creator's first buy** runs in the launch transaction itself, before any bot can act, so it is exempt
  **[proposed]**. It has no size limit: a creator (or a bot that launches) can buy the whole curve surcharge-free in
  the launch transaction, about 25,126 USDC, and graduate it there; every buyer after pays the pool's 90% in that block
  (Claude review #7, informational).
- **Where it goes [decided]: locked into the pool.**
  - In the pool: the hook holds it as claims and anyone can call `lock(token)` to add it as locked liquidity: a
    USDC-only position of its own (a fresh salt for every bid, never re-added to) whose top is **half** the graduation
    price and which runs about 10,000 times lower (`BID_SPAN_TICKS`, 92,200 ticks), a bid nobody can ever withdraw.
    It is anchored to the graduation price alone, so pushing the price before a `lock` cannot move it; while the price
    is under the bid's top, `lock` places nothing and the USDC waits as claims. Adding it needs no swap, so there is
    nothing to sandwich (the Deepen pool review's lesson), and it never reaches the extreme tick the full-range
    position uses, so no outside LP can fill that tick to hold it off.
  - The discount is why a sniper who dumps the moment the window closes is not paid back out of his own surcharge
    (Argus found that sending snipe fees to holders refunded snipers 27 to 90%). One who holds through graduation and
    then dumps into the pool does get part back from the bid it became: measured (Claude review #7), nothing at a
    5,000 USDC snipe, 4.8% of the surcharge at 20,000 and 13.8% at 100,000.
  - On the curve there is no pool yet: the launchpad holds it for the token (`pendingSnipe`) and the hook locks it in at
    graduation, the same way, at the graduation price. If a curve never graduates it stays in the launchpad for good
    (the default the owner did not change). The curve's parameters stay identical for every token; like the other fees,
    the snipe fee comes off a buy before the rest moves the curve, so a buy inside the window moves the price less than
    the same gross buy after it.

## 6. Open or closed pools [decided: D3]

- `createToken` takes a new `openPool` flag, stored with the curve and shown on the token page.
- **Closed (the builder's default [proposed]):** only the graduation position, the anti-snipe liquidity and listed
  liquidity plugins (Deepen pool v1.4). Nobody can move the pool's liquidity to game a plugin's budget.
- **Open:** anyone may add and remove their own liquidity; the locked positions still never move.
- **LP fee in open pools [default: none]:** pools charge no LP fee, so outside liquidity earns nothing and only comes
  from someone paid to provide it (a market maker hired by the project). Letting the creator pick an LP fee for an open
  pool is a later option.

## 7. Plugins

- The plugin interface (V13-SPEC §2.1) is unchanged. Split, Distribute to holders and Combo are redeployed as-is for
  the v1.4 launchpad (they bind to a launchpad at construction).
- **Deepen pool v1.4 [not built]:** on the curve, unchanged. In the pool it buys through the PoolManager, burns its
  burn share, and adds the rest through a hook entry point that still has to be written, as a fresh locked position
  (never by re-adding to an existing one: Claude review #7, M1). Its cap stays 0.25% of the locked USDC (the H1 fix),
  which in v4 is the USDC in the hook's locked positions.
- `pairOf(token)` returns the PoolManager for a graduated token, which holds every pool on Arc: no plugin may treat it
  as a per-token pool (its USDC balance is all of Uniswap's USDC on Arc).
- **Buyback & burn:** not relisted; Deepen pool at a 100% burn share does its job.

## 8. Trading after graduation

- **architex.fun:** the Architex v4 router (`contracts-v14/src/ArchitexV4Router.sol`): exact-in buy and sell with a
  minimum out and a deadline, through the PoolManager's unlock; a sell needs no approval (the token lets the router
  pull, always from its own caller); it pays only what the swap consumed. Its quotes simulate the swap and revert with
  the result (the v4 Quoter's pattern), so they include every fee the hook takes.
- **Everyone else:** wallets, the Uniswap app and aggregators through the Universal Router, once Uniswap lists the
  hook (§2).

## 9. Site, charts and listing feeds

- Trade history and charts read the PoolManager's `Swap` events for the token's pool id, plus the hook's fee events;
  prices and liquidity from StateView.
- The lister feeds (CoinGecko standard) list v1.4 pools by pool id; the token list and docs add the hook, the
  launchpad and the router.
- The builder gains the open/closed choice; the token page shows it, the anti-snipe window, and which pool the token
  trades in.

## 10. Accepted limits

- **Pool fees wait for a sync.** The launchpad's `pendingFees` and `pendingCreatorFees` count a pool's fees only once
  synced; until then the hook's `pendingPlatform` and `pendingCreator` hold them. `collectCreatorFees` syncs first;
  `collectFees` does not, so the platform syncs its tokens (`syncPoolFeesBatch`) before collecting.
- **Snipe fees wait while the price is under the bid's top.** If a token trades below half its graduation price,
  `lock` places nothing and the USDC stays as the hook's claims until the price comes back, for good if it never does.
  Nobody can withdraw it either way. Placing the bid lower instead would let anyone move it by pushing the price first
  (Claude review #7, L2).
- **Nothing that unlocks runs inside someone else's unlock.** A graduating buy, `lock` and `syncPoolFees` revert
  `AlreadyUnlocked` when called from inside a v4 unlock; `collectCreatorFees` then skips the sync and pays what the
  launchpad already holds.
- **Sells need no approval.** The router pulls a seller's tokens through the token itself, always from its own caller
  (v1.3's launch router did the same). A contract that holds launch tokens and relays arbitrary calls to targets other
  than the token can be made to sell them through the router; wallets and ordinary contracts cannot.
- **Other v4 pools for the same token.** Anyone can open another v4 pool for a launch token (a different fee, no hook);
  before graduation it cannot be funded (the token refuses transfers into the PoolManager), after it nothing stops it.
  Uniswap's app may route buyers into such a pool until our hook is allowlisted (§2).
- v1.3's accepted limits (V13-SPEC §9) still hold where they concern the curve, the dividend token, fee destinations
  and plugins.

## 11. Build, review and rollout

The v1.3 bar: unit, fuzz and invariant tests against a real v4 PoolManager; end-to-end tests of every plugin through
graduation; adversarial reviews (Claude lenses and Grok) until no High is open; an Arc Testnet rehearsal; the owner
deploys to mainnet; then the Uniswap routing allowlist submission with a live pool. New invariants to add to V13-SPEC
§6: the hook never lets a swap skip the fees; the locked positions can never shrink; only the launchpad can create a
pool with the hook; a closed pool's liquidity only ever grows; the hook holds no USDC and its claims are exactly what
it owes (pool fees not yet synced, USDC waiting for a bid); `lock` never reverts once there is something to lock; no
donation ever lands.

Reviews so far: Grok #7 (`GROK-REVIEW-7.md`: no High; the router fix, the spec corrections) and Claude #7
(`CLAUDE-REVIEW-7.md`: no High; one Medium and two Lows, all fixed, their PoCs kept as regression tests in
`contracts-v14/test/review7`).

## 12. Still open

1. Whether the builder stops offering v1.3 launches the day v1.4 is live (proposed: yes; v1.3 tokens keep trading
   where they are).
2. Deepen pool v1.4 (buys through the PoolManager, adds to the hook's locked position) and the site's v4 trading,
   charts and listing feeds.
3. The Uniswap routing allowlist submission, and asking 0x and KyberSwap to route the hook.
4. Evidence for the owner's curve-first call: mercuri, the one Arc launchpad already doing curve-then-Uniswap, had 39
   launches and no graduation by 2026-09-25; Argus, straight into Uniswap, had 168,000 launches (much of it bot flow).
