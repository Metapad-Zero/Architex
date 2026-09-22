# Deepen pool: what the site's plugin registry needs

Everything the marketplace entry for the **Deepen pool** plugin needs, so the site can be updated in its own change
(nothing here edits site code). The contract is `contracts/plugins/launch/DeepenPoolPlugin.sol`, the spec is
V13-SPEC §2.3, and the deploy script is `contracts/script/DeployDeepenPool.s.sol`.

The plugin does two jobs with a token's creator fees under one paced budget: it buys the token and burns it, and it
buys the token and adds it to the launch pool with the rest, locking the new liquidity at the burn address. The
creator picks the mix once, at launch: the **burn share**, `burnBps`, from 0 (all liquidity) to 10,000 (all burn),
5,000 by default. Before graduation there is no pool to add to, so every run buys and burns.

## Registry entry (`src/content/plugins/registry.ts`)

`ListedPlugin` fields, ready to paste:

| Field | Value |
| --- | --- |
| `kind` | `'deepen'` (add to `ListedPluginKind`) |
| `name` | `Deepen pool` |
| `tagline` | `Burns the token and grows its pool, in one.` |
| `description` | `Spends the fees buying the token and burning it while it is on the curve. Once it graduates, every run splits: your burn share buys the token and burns it, and the rest buys the token and adds it to the launch pool, locking the new liquidity at the burn address. Anyone can run it; it spends at most 0.25% of the curve's or pool's USDC side per hour, whatever the mix.` |
| `config` | `'burnShare'` (a new configuration kind: one number, see below) |
| `suiteKey` | `'deepenPlugin'` |
| `contractPath` | `contracts/plugins/launch/DeepenPoolPlugin.sol` |

Two supporting changes the entry needs:

- `LaunchSuite` (`src/lib/deployment.ts`) gains `deepenPlugin: Address`, and both `src/deployments/arc-*.json` gain
  a `deepenPlugin` key (zero address until it is deployed; `isPluginDeployed` already hides an entry whose address
  is zero).
- `suiteKey`'s type in `ListedPlugin` is a `Pick<...>` of the four plugin keys today, so it takes
  `'deepenPlugin'` too.

## The one configuration field

| Field | Value |
| --- | --- |
| Label | `Burn share` |
| Control | A slider or percentage input, 0% to 100%, default **50%** |
| Encoding | `encodeAbiParameters([{ type: 'uint16' }], [burnBps])` where `burnBps = percent * 100`; the plugin also accepts empty data, which means 50% |
| Help text | `How much of each run buys the token and burns it. The rest buys the token and adds it to the pool as liquidity nobody can take out. Locked forever either way.` |
| Ends of the range | 0%: `Everything goes into the pool.` 100%: `Everything is burned (the same as Buyback & burn).` |

The choice is locked at launch, like the plugin itself. Anything above 100% is refused on chain
(`InvalidBurnBps`), and so is data that is not exactly one `uint16` (`NonCanonicalData`).

## What to tell creators about the mix (V13-SPEC §2.3)

Burning takes tokens out of the pool and leaves the USDC in, so it moves the price about twice as far per USDC as
adding liquidity does. That cuts both ways: a higher burn share moves the price faster, and a lower one makes
front-running the runs take longer. The shortest hold at which front-running the runs starts to pay, in hours:

| Burn share | 0% creator fee | 0.5% | 1% | 2% | 5% | 10% |
| --- | --- | --- | --- | --- | --- | --- |
| 0% (all liquidity) | 3.0 | 7.1 | 11.2 | 19.5 | 45.6 | 93.0 |
| 25% | 2.2 | 5.5 | 8.8 | 15.5 | 36.7 | 75.8 |
| 50% (default) | 1.7 | 4.4 | 7.2 | 12.8 | 30.6 | 63.9 |
| 75% | 1.3 | 3.6 | 6.0 | 10.9 | 26.3 | 55.2 |
| 100% (all burn) | 1.0 | 3.1 | 5.1 | 9.4 | 23.0 | 48.6 |

On the curve every run buys and burns, so the hours there are Buyback & burn's whatever the share.

## The warning worth showing

Deepen pool and Buyback & burn pace themselves separately. A Combo holding **both** spends twice as fast and cuts
the hours above by about 2.4x (at a 1% creator fee and the default share: 7.2 h with this plugin alone, 2.5 h with
Buyback & burn running beside it). The burn share makes the pairing pointless, so the builder should **not offer
both in the same Combo**; if it ever does, say plainly that pairing them weakens the protection.

## Token page

The same shape as Buyback & burn's panel, with the pool side added. All views are on the plugin, keyed by token:

| What to show | Call |
| --- | --- |
| The token's burn share | `burnBpsOf(token)` (0 also means "not configured"; `isConfigured(token)` tells them apart) |
| USDC waiting | `usdcHeld(token)` |
| What a run would spend now, and how it would divide | `previewRun(token)` returns `(usdcOffered, usdcToBurn, usdcToDeepen, graduated)`; 0 means no run right now |
| The whole breakdown of an offer | `previewSplit(token, usdcOffered)` returns `(usdcToBurn, usdcToBuy, usdcForLiquidity)`, which sum to the offer |
| Burned so far | `totalTokensBurned(token)` and `totalUsdcBurning(token)` (the USDC that bought them) |
| Added to the pool so far | `totalUsdcAdded(token)` and `totalTokensAdded(token)` |
| Liquidity locked at the burn address | `totalLiquidityLocked(token)` |
| Spent in total (both buys plus the adds) | `totalUsdcSpent(token)` |
| When it may run again | `nextRunBlock(token)`, `lastRunAt(token)`; the budget refills over `RUN_INTERVAL` (1 h) |
| The Run button | `run(token)`, callable by anyone, returns `(usdcSpent, tokensBurned, liquidity)` |

One event per run, for the activity feed:

```solidity
DeepenRun(
  address indexed token, address indexed caller, bool graduated,
  uint256 usdcSpent, uint256 usdcBurning, uint256 usdcAdded, uint256 tokensBought,
  uint256 tokensAdded, uint256 tokensBurned, uint256 liquidity
)
```

and one at launch: `BurnShareSet(address indexed token, uint16 burnBps)` (the view is authoritative, not the event).

Reverts the button should handle: `NothingToBuy(token)` (nothing waiting, or the budget has not refilled to
`MIN_RUN_USDC` = 3 units yet) and `AlreadyRanThisBlock(token)` (someone else ran it in this block).

## Anyone can top a token's pot up

`onFees(token, amount)` takes fees from **any** caller for a token that picked this plugin, not just from the
launchpad's collection: approve the plugin for `amount`, then call it. Architex's own fee wallet can feed a token's
pot out of the platform fees it collected, and so can the creator or anyone else. It is a gift and nothing pays it
back. If the site ever offers this, it should say so in those words.
