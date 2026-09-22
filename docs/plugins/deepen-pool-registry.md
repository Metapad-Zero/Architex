# Deepen pool: what the site's plugin registry needs

Everything the marketplace entry for the **Deepen pool** plugin needs, so the site can be updated in its own change
(nothing here edits site code). The contract is `contracts/plugins/launch/DeepenPoolPlugin.sol`, the spec is
V13-SPEC §2.3, and the deploy script is `contracts/script/DeployDeepenPool.s.sol`.

## Registry entry (`src/content/plugins/registry.ts`)

`ListedPlugin` fields, ready to paste:

| Field | Value |
| --- | --- |
| `kind` | `'deepen'` (add to `ListedPluginKind`) |
| `name` | `Deepen pool` |
| `tagline` | `Buys and burns, then grows the pool forever.` |
| `description` | `Spends the fees buying the token and burning it while it is on the curve. Once it graduates, each run buys the token with about half the fees and adds it to the launch pool with the other half, locking the new liquidity at the burn address, so the pool only gets deeper. Anyone can run it; it spends at most 0.25% of the curve's or pool's USDC side per hour.` |
| `config` | `'none'` (no configuration: `onLaunch` data must be empty) |
| `suiteKey` | `'deepenPlugin'` |
| `contractPath` | `contracts/plugins/launch/DeepenPoolPlugin.sol` |

Two supporting changes the entry needs:

- `LaunchSuite` (`src/lib/deployment.ts`) gains `deepenPlugin: Address`, and both `src/deployments/arc-*.json` gain
  a `deepenPlugin` key (zero address until it is deployed; `isPluginDeployed` already hides an entry whose address
  is zero).
- `suiteKey`'s type in `ListedPlugin` is a `Pick<...>` of the four plugin keys today, so it takes
  `'deepenPlugin'` too.

## Builder copy

- Picker line: `Deepen pool. Buys and burns, then grows the pool forever.`
- Under the picker, when it is selected: `Before graduation every run buys the token and burns it. After
  graduation each run buys with about half of what is waiting and adds it to the pool with the rest, and the new
  liquidity is locked at the burn address, so nobody can take it out. Anyone can run it, at most 0.25% of the
  pool's USDC side per hour.`
- No configuration fields.

## The warning worth showing (V13-SPEC §2.3)

Deepen pool and Buyback & burn pace themselves separately. A Combo holding **both** spends twice as fast and
roughly halves the time a trader has to hold before front-running the runs pays (for example at a 1% creator fee:
5.1 h on the curve and 11.2 h in the pool with one of them, about 2.1 h and 3.1 h with both). The builder should
**not offer both in the same Combo**; if it ever does, say plainly that pairing them weakens the protection.

## Token page

The same shape as Buyback & burn's panel, with the pool side added. All views are on the plugin, keyed by token:

| What to show | Call |
| --- | --- |
| USDC waiting | `usdcHeld(token)` |
| What a run would spend now, and where it would buy | `previewRun(token)` returns `(usdcOffered, graduated)`; 0 means no run right now |
| How that offer splits | `previewSplit(token, usdcOffered)` returns `(usdcToBuy, usdcForLiquidity)`; on the curve the whole offer buys |
| Burned so far | `totalTokensBurned(token)` |
| Added to the pool so far | `totalUsdcAdded(token)` and `totalTokensAdded(token)` |
| Liquidity locked at the burn address | `totalLiquidityLocked(token)` |
| Spent in total (buys plus adds) | `totalUsdcSpent(token)` |
| When it may run again | `nextRunBlock(token)`, `lastRunAt(token)`; the budget refills over `RUN_INTERVAL` (1 h) |
| The Run button | `run(token)`, callable by anyone, returns `(usdcSpent, tokensBurned, liquidity)` |

One event per run, for the activity feed:

```solidity
DeepenRun(
  address indexed token, address indexed caller, bool graduated,
  uint256 usdcSpent, uint256 usdcAdded, uint256 tokensBought,
  uint256 tokensAdded, uint256 tokensBurned, uint256 liquidity
)
```

Reverts the button should handle: `NothingToBuy(token)` (nothing waiting, or the budget has not refilled to
`MIN_RUN_USDC` = 3 units yet) and `AlreadyRanThisBlock(token)` (someone else ran it in this block).

## Anyone can top a token's pot up

`onFees(token, amount)` takes fees from **any** caller for a token that picked this plugin, not just from the
launchpad's collection: approve the plugin for `amount`, then call it. Architex's own fee wallet can feed a token's
pot out of the platform fees it collected, and so can the creator or anyone else. It is a gift and nothing pays it
back. If the site ever offers this, it should say so in those words.
