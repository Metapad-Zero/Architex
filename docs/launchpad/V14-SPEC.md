# Launchpad v1.4: graduate into Uniswap v4 (draft)

Status: **built on branch `v14`, reviewed by Claude three times and Grok twice (no High open; every finding fixed
or accepted in §10, see §11), not deployed**, 2026-09-25. Contracts in `contracts-v14/src`, tests in `contracts-v14/test` (run with
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
  - during the opening window (§5) a buy also pays the surcharge, which the same `afterSwap` turns into a bid (§5);
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
     token's first bid, from half the graduation price down;
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
- **Where it goes [decided]: locked into the pool, the moment it is paid [owner's choice, 2026-09-25].**
  - In the pool: the buy that pays the surcharge also places it, inside the same swap (`afterSwap`), as locked
    liquidity: a USDC-only position of its own (a fresh salt for every bid, never re-added to) whose top is **half the
    lowest price any window buy has started from** (this one included, the graduation price to begin with: the
    pool's `bidRefTick`, which only ever moves down) and which runs about 10,000 times lower (`BID_SPAN_TICKS`, 92,200
    ticks), a bid nobody can ever withdraw. Nothing waits and there is no separate lock step. A buy only moves the
    price up, so the bid is always wholly under the market when it is placed; after a crash inside the window the
    next buy's bid follows the price down, and no later lift moves bids back up. It never reaches the extreme tick the full-range position uses, so no outside LP can fill that tick to block
    it (which would now block the buy itself).
  - Nobody can plant a bid above the market, or profit from moving one (Claude review #9, all measured in tests):
    - a pump-and-dump with the attacker's own window buys always loses: 50,000 USDC put in comes back as 4,726 in
      the opening block, 27,358 at block 10 and 47,347 at block 19;
    - the buy that places a bid can be sandwiched like any buy, but a front-run cannot lift the reference its bid is
      placed from, so the back-run takes nothing from the bid, before or after a crash (the site never sends a buy
      without a minimum out);
    - splitting a big window buy into many small ones, or spreading it over blocks, cannot stack bids above the
      buyer's own dump: it gets back no more than one buy does. Placing each bid from the price just before its own
      buy let 1,000,000 USDC split into 50 buys at block 19 get 76% of its surcharge back (Claude review #9, L1);
      capping that at the graduation price still let 22% to 34% back after a dump to about a sixteenth of graduation
      (review #9's residual); the running lowest price closes both.
  - Pushing the price down before someone's buy (a sell) only makes that buyer's bid land lower, and gives him a
    cheaper buy. Undoing the push inside the window costs the surcharge, which deters it early in the window only:
    undoing a 100M-token push around a 5,000 USDC buy cost 85,840 USDC in the opening block, about 8,600 at block 19,
    and 7,835 if the griefer waits one block past the window, against 8,307 with no window at all (review #9's I2).
    It never pays, but since the reference only moves down, a hard dump inside the window with one buy after it
    lowers every later window bid too: they end deeper under the market, never above it. After the window no bid can
    be added or moved at all.
  - Why not a separate `lock`: v1.4 first had one, anchored to the graduation price so a push could not move the bid
    (Claude review #7, L2). After a crash the claims then waited, and anyone could push the price over the bid's top,
    lock, and sell into a bid above the market: up to 30% of the waiting fees in one transaction (Claude review #8).
  - The discount is why a sniper who dumps the moment the window closes is not paid back out of his own surcharge
    (Argus found that sending snipe fees to holders refunded snipers 27 to 90%). One who holds through graduation and
    then dumps into the pool does get part back from the bid it became: measured (Claude review #7), nothing at a
    5,000 USDC snipe, 4.8% of the surcharge at 20,000 and 13.8% at 100,000.
  - On the curve there is no pool yet: the launchpad holds it for the token (`pendingSnipe`) and the hook places it at
    graduation, the same way, from half the graduation price. If a curve never graduates it stays in the launchpad for
    good (the default the owner did not change). The curve's parameters stay identical for every token; like the other
    fees, the snipe fee comes off a buy before the rest moves the curve, so a buy inside the window moves the price
    less than the same gross buy after it.
  - Cost: a buy inside the pool's window also adds a position. Measured through Uniswap's V4Router against the same
    buy after the window (integration review #9b, at 39a78b4; receipt gas, then the gas limit the transaction needs):

    | The bid lands on | Receipt | Gas limit |
    | --- | --- | --- |
    | the pool's reference ticks, opened by an earlier bid (the usual case: bids share the reference) | +78k to +79k | +81k |
    | new ticks (only when the buy starts at a new low, which also moves the reference) | +125k to +128k | +129k to +132k |
    | the pool's first bid | +170k to +173k | +175k to +178k |

    A fraction of a cent on Arc either way. Another buy landing first no longer changes what a window buy needs; a
    sell to a new low landing first can add about 48k to 51k (about 20%). So while `snipeBpsOf(token) > 0`,
    integrators should re-estimate right before sending with at least 25% headroom (the site uses 30%, or +200k) and
    never size a limit from an earlier window buy's receipt. `lockHeld` is written only when the rounding it holds
    changes, so a window buy carries no storage write-and-refund; a new tick-bitmap word cannot be reached inside a
    window (the nearest is about 36 times below the graduation price, and selling every remaining token moves it about
    25 times).
  - A pool can end up with many bids (one per window buy). Nothing iterates over them; Deepen pool v1.4's cap must be
    a running total of the USDC in the hook's locked positions, never a loop over bids.

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

- Trade history and charts read the hook's `PoolTrade` events (the trader's side) with the PoolManager's `Swap` events
  for the token's pool id (the pool's side); prices and liquidity from StateView. Rules for any indexer (integration
  review #9b, reconstructed exactly in its tests):
  - the PoolManager's `Swap` is the pool's side: on a buy its USDC is net of the platform, creator and snipe fees (in
    the window as little as 10% of what the trader paid), on a sell it is gross; its `fee` is always 0, so generic v4
    indexers see these pools as 0% fee and undercount buy volume;
  - a buy's trader paid `PoolTrade.usdcAmount`; a sell's received `usdcAmount - platformFee - creatorFee`;
  - each `Swap` is followed by its own `PoolTrade` before the next `Swap` in that pool, in multi-swap transactions
    too; a window buy emits `ModifyLiquidity` (sender the hook) and `BidLocked` between the two, and `BidLocked`'s USDC
    is the snipe fee to within 2 units of rounding;
  - the hook's claims moving are the PoolManager's ERC-6909 `Transfer` events, not USDC transfers.
- The lister feeds (CoinGecko standard) list v1.4 pools by pool id; the token list and docs add the hook, the
  launchpad and the router.
- The builder gains the open/closed choice; the token page shows it, the anti-snipe window, and which pool the token
  trades in.

## 10. Accepted limits

- **Pool fees wait for a sync.** The launchpad's `pendingFees` and `pendingCreatorFees` count a pool's fees only once
  synced; until then the hook's `pendingPlatform` and `pendingCreator` hold them. `collectCreatorFees` syncs first;
  `collectFees` does not, so the platform syncs its tokens (`syncPoolFeesBatch`) before collecting.
- **Rounding dust.** A bid takes all but a unit or two of what it is given; the rest joins the next bid, and after
  the window's last buy it stays with the hook for good.
- **Bid ticks cost later swaps gas.** Window buys at many different prices open many bid ticks, and a later swap that
  crosses them pays about 10,600 gas per tick: after 40 dust bids at distinct prices, a 300M-token dump cost 578,627
  gas instead of 155,573 (Claude review #9, I3). Whoever does it pays the surcharge and about 108,000 gas per bid;
  bids from buys above graduation all share the graduation bid's ticks.
- **Nothing that unlocks runs inside someone else's unlock.** A graduating buy (a `createToken` whose first buy
  graduates included), `syncPoolFees` and `syncPoolFeesBatch` revert `AlreadyUnlocked` when called from inside a v4
  unlock; `collectCreatorFees` then skips the sync and pays what the launchpad already holds.
- **A USDC blocklist.** Circle can blocklist any address. On the launchpad it stops everything that moves USDC through
  the launchpad: curve buys and sells, graduations, launches that pay a launch fee, syncs and payouts. Graduated pools
  keep trading, and their fees wait as the hook's claims. On the hook it stops only graduations (the hook passes the
  curve's USDC into the pool); the curve keeps trading both ways.
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
pool with the hook; a closed pool's liquidity only ever grows; the hook holds no USDC and its claims are at least what
it owes (pool fees not yet synced, a bid's rounding; anyone can add claims to the hook, which then stay there); snipe
fees never wait (at most a unit or two per token is ever held); every bid is placed wholly under the market, from half
the pool's reference, which only ever moves down and starts at the graduation price; no donation ever lands; quotes
through Uniswap's V4Quoter equal fills through its V4Router, fees and bids included.

Reviews so far: Grok #7 (`GROK-REVIEW-7.md`: no High; the router fix, the spec corrections), Claude #7
(`CLAUDE-REVIEW-7.md`: no High; one Medium and two Lows, all fixed), Grok #8 (`GROK-REVIEW-8.md`: no findings) and
Claude #8 (`CLAUDE-REVIEW-8.md`: no High; one Medium, fixed by placing snipe fees inside the buy that pays them) and
Claude #9 (`CLAUDE-REVIEW-9.md`: no High or Medium; one Low, fixed by placing every window bid from the lowest price
any window buy has started from) and its integration lens #9b (`INTEGRATION-REVIEW-9.md`: compatible with Uniswap's
V4Quoter, V4Router, multi-hop routes and every payment style; one Low about window-buy gas, reduced and documented in
§5). Grok #9 did not run (the Grok Build balance was exhausted). The reviews' PoCs are kept as
regression tests in `contracts-v14/test/review7`, `review8` and `review9`. The Arc Testnet rehearsal is
`V14-REHEARSAL.md` (on branch `v14-rehearsal` until it merges).

## 12. Still open

1. Whether the builder stops offering v1.3 launches the day v1.4 is live (proposed: yes; v1.3 tokens keep trading
   where they are).
2. Deepen pool v1.4 (buys through the PoolManager, adds to the hook's locked position) and the site's v4 trading,
   charts and listing feeds.
3. The Uniswap routing allowlist submission, and asking 0x and KyberSwap to route the hook. Nothing in the v4 sources
   rules the hook out (flags 0x28EC pass `isValidHookAddress`; no liquidity-return deltas). The submission should
   explain: both swap return-delta flags (fees always in USDC, with the formulas); the liquidity added inside
   `afterSwap` (only in the first 20 blocks, always wholly out of range below the price, after the swap so it cannot
   change that swap's output, and reproduced exactly by the V4Quoter); the surcharge (up to 90%, the total capped at
   99%, time-bounded, readable through `snipeBpsOf`); `PartialFill` (exact-in buys and exact-out sells revert when a
   price limit stops them; the Universal Router, V4Router and V4Quoter use extreme limits and never hit it); dust
   minimums (`FeesExceedAmount` under about 30 raw USDC units in the opening block, 3 after the window); closed pools
   refusing outside liquidity (PositionManager mints revert `WrappedError(ClosedPool)`, which affects LP screens, not
   routing); donations refused, initialize restricted, no admin or upgrade path, fees fixed. Aggregators that simulate
   off-chain (KyberSwap, 0x) must model the per-token creator fee (`launchOf`), the 50 bps platform fee, the window's
   block schedule from `openBlock`, the rounding (each component rounded up; exact-out gross-up with the platform share
   first) and the 99% cap; quoter-based routing works as-is, and a quote landing a block later in the window fills at
   least as well.
4. Evidence for the owner's curve-first call: mercuri, the one Arc launchpad already doing curve-then-Uniswap, had 39
   launches and no graduation by 2026-09-25; Argus, straight into Uniswap, had 168,000 launches (much of it bot flow).
