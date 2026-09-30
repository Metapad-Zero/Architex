## The bounded Arc–Base keeper: vaults, quotes, limits and recovery

The keeper has its own contract, pinned code manifest, durable record, operator tool and approval.
The frozen launch adapter, release gate, launch configuration and public client remain unchanged.
Approving a launch does not authorize trading. Inventory maintenance requires an explicit keeper
maintenance scope **and** the separate transfer approval; keeper approval alone authorizes no bridge
transfer or refill. See [keeper maintenance](EQUILIBRIUM-KEEPER-MAINTENANCE.md) for the combined route.

### What a cycle is

One cycle is two legs on two chains, at the **same token quantity**:

| Leg | Chain | Venue | Effect |
| --- | --- | --- | --- |
| buy | wherever EQL is cheaper | Architex pair on Arc, Uniswap v3 pool on Base | quote in, exactly `tokens` out |
| sell | wherever EQL is dearer | the other chain's pool | exactly `tokens` in, quote out |

The two legs are **not atomic** and no message passes between the chains. Everything below follows
from that. The keeper trades only inventory its own vaults already hold: it cannot mint, burn,
bridge, rebase or redistribute, and it never touches a holder's balance or the pools' LP positions.
When a chain's inventory runs out the keeper stops trading that direction and says so. Maintenance
is a separate operator command using the reviewed return/refill route (49TH-28); the trading loop
never invokes it automatically. Pending maintenance prevents new cycles in the shared durable record.

### `EquilibriumKeeper`: one vault per chain

`contracts/equilibrium/EquilibriumKeeper.sol`. Every trade is one `run(Leg)`, and the leg id is
written to `legOf` **before any external call**, so idempotency sits in the contract on the chain
where the trade takes effect — not in a transaction nonce and not in the runner's database.

A leg carries the chain id and the pool address it was planned for, plus a deadline. So the
**destination chain** is what rejects:

| Situation | Revert |
| --- | --- |
| the same leg submitted twice, by a stale runner, a restart or a replayed transaction | `LegDone` |
| a leg planned for Arc arriving at the Base vault | `WrongChain` |
| a leg aimed at a different pool on the right chain | `WrongPool` |
| a leg planned against a quote that has since gone stale | `LegExpired` |
| anyone but the operator | `NotOwner` |

The bounds the contract enforces itself, fixed at construction — changing one means deploying a new
vault and asking for a new approval:

| Bound | What it stops |
| --- | --- |
| `maxTokensPerLeg` | a leg larger than the approved size (`LegTooLarge`) |
| `maxQuotePerLeg` | a purchase bound above the approved per-leg cash (`LimitTooLarge`) |
| the leg's own `limit` | paying more than quoted (`MaxInExceeded`) or receiving less (`MinOutShortfall`) |
| `spendCap` | cumulative quote paid out across the session (`SpendCapExceeded`) |
| `drainCap` | cumulative *net* quote drained from this vault (`DrainCapExceeded`) |
| `recoveryReserve` | a purchase that would leave the unwind unfunded (`RecoveryReserveBreached`) |
| `maxOpenCycles` | opening exposure while exposure is already open (`TooManyOpenCycles`) |
| `halted` | opening or selling while halted; a recovery is still allowed (`Paused`) |
| `resume()` | resuming over an unresolved position (`OpenExposure`) |
| `withdraw()` | pulling reserved recovery capacity out from under an open position |

A short fill is refused rather than accepted as partial: the vault checks the exact quantity was
delivered (`TokensNotDelivered`).

**What the contract cannot guarantee.** The sale happens on the other chain, and no message crosses
back. `attestClosed(cycle, remoteLeg)` is the operator recording a finalized remote receipt it
observed — an attestation, not a proof. It is named that way in the code, in the preview and here.

### Executable quotes, from the pool contracts

`probe(buy, tokens)` answers by **reverting** with `Quoted(amountIn, amountOut)`, so a quote can
never move funds and never depends on the vault's inventory:

- **Uniswap v3**: the pool computes the swap and the keeper's callback reverts with the amounts the
  pool asked for. That is the route Uniswap's own quoter uses, so the number is the pool's.
- **Architex pair**: the closed-form constant-product amount from the pair's live `getReserves()`,
  with the pair's own 0.30% fee counted once. The pair's K check is what validates it when the leg
  executes, and the fork rehearsal asserts the quoted amount equals the executed amount to the atom.

Both chains are always quoted for the identical quantity, at a block whose number and timestamp are
recorded with the quote; the vault's inventory and counters are read at that same block, so an
inventory decision is never made against a different state than the price.

### The off-chain policy

`server/equilibrium/keeper/policy.ts` is pure, so every refusal is reproducible from recorded
numbers. Anything that forbids trading outright is checked before price is even consulted: halted,
unresolved exposure (from the record *and* from the vaults), the realized-loss cap, an unavailable
chain, a stale quote. Only then does it compare the two quotes.

`edge = sellProceeds − buyCost − (buy leg gas + sell leg gas + reserved recovery cost) − buffer`

Pool fees are already inside both quotes, once. On top of the edge test the policy requires: the
selling chain to hold the tokens, the buying chain to afford the purchase and its gas, and enough
left afterwards for the recovery reserve plus the recovery leg's own cost. A leg is then bound
on-chain to `buyCost × (1 + slippage)` or `sellProceeds × (1 − slippage)`, and refused before
sending if its measured worst-case gas would eat the cycle's edge or pass the absolute per-leg
ceiling. Freshness is measured against each chain's own head, in blocks and in seconds, so the same
rule holds on a fork, a testnet and a live chain; the leg's on-chain deadline is in that chain's own
clock.

Finalized leg costs are `gasUsed × effectiveGasPrice + l1Fee`, converted to quote atoms once.
The keeper's separately approved `fees.ts` matches the frozen launch adapter's numeric rules:
nonnegative bigint, safe integer, decimal string or hex string; absent or null fees contribute zero.
Malformed or imprecise fees refuse settlement rather than inventing a zero cost. A mined sale then
remains in the durable record for reconciliation after the receipt becomes readable; it is never
sent again to repair accounting. The receipt parser belongs to the keeper approval manifest, so
changing it requires a new keeper approval without changing the launch approval.

### The durable record and recovery

`server/equilibrium/keeper/store.ts`, WAL and `synchronous=FULL`, on the same durable-path guard the
job store uses — a keeper record that does not survive the process can lose a bought position, which
is real money. A leg's exact plan is written before anything is sent, so a restart can tell "bought,
not yet sold" from "nothing sent".

- **A cycle with a settled purchase and no settled sale** is exposure. Both vaults halt, and neither
  the runner nor the vaults will open another cycle until it is resolved.
- **Recovery** unwinds on the market the position was bought on, at a floor derived from that
  market's current quote, using the capacity the vault reserved for exactly this. If the unwind would
  pass the remaining loss budget it is **refused**: the position stays open and the keeper stays
  halted. The cap is never relaxed to make a position go away.
- **A cycle whose trade finished but whose close did not** is its own state, and the one that is
  easiest to get wrong. Closing a cycle is two steps that cannot be one: the purchase vault's
  attestation is a transaction on the purchase chain, and the terminal state is a local write. A throw
  or a stopped process in between leaves both legs settled, the record still `open` (or `halted`, for
  a recovery), and the purchase vault still reporting the position — so nothing may trade, resume or
  withdraw, even though nothing is at risk. `store.unfinished()` is what sees that shape, and
  `reconcile()` walks it **first**: it attests the close, writes the terminal state, and is safe to
  run again, because `attestClosed` is a no-op once the vault reports nothing open. `runCycle` and
  `recover` leave exactly that shape with a note saying so rather than reporting a completed trade the
  vault still thinks is open. `bun run equilibrium:keeper reconcile --yes` is the operator's version of
  the same call, and `status` lists unresolved and unfinished cycles separately.
- **A cycle that sent nothing** is abandoned, because no money moved.
- `resume()` only succeeds once no cycle is open, on either chain or in the record, and its error names
  `reconcile` when the vault is the one still holding a position.

Keeper profit is reported separately from the pool/treasury outcome. A recovered cycle's loss is not
netted away by a later profitable cycle: `totals()` reports realized loss and net separately. The
keeper's own volume is not customer demand and its own payments are not revenue.

### The operator tool

```
bun run equilibrium:keeper verify   --config <file>
bun run equilibrium:keeper quote    --config <file> --tokens 1000000000
bun run equilibrium:keeper status   --config <file>
bun run equilibrium:keeper reconcile --config <file> --yes
bun run equilibrium:keeper preview  --config <file> [--write public/equilibrium-keeper-preview.md]
bun run equilibrium:keeper run      --config <file> --tokens 1000000000 [--ticks N] [--interval-ms N] --yes
bun run equilibrium:keeper recover  --config <file> --cycle <id> --yes
bun run equilibrium:keeper resume   --config <file> --yes
bun run equilibrium:keeper maintenance-preview --config <file> [--write <preview>]
bun run equilibrium:keeper maintain --config <file> --request-id <id> --tokens <atoms> --quote <atoms> --yes
bun run equilibrium:keeper maintenance-reconcile --config <file> --yes
```

`verify`, `quote`, `status`, `preview` and `maintenance-preview` are read-only. Sending commands require
`--yes` and, off a fork, `EQUILIBRIUM_KEEPER_APPROVAL` equal to the digest over the exact preview,
the exact configuration file and the keeper code manifest
(`server/equilibrium/keeper/approval.ts`). A fork configuration must point at loopback RPCs. There is
no live mode: `mode` is `fork` or `testnet`. Maintenance additionally requires the exact transfer
approval and the completed launch record, as described in the maintenance document.

`bun run equilibrium:keeper-bytecode --check` compares `server/equilibrium/keeper/bytecode.json`
against a fresh `FOUNDRY_PROFILE=equilibrium forge build`. That manifest is deliberately **separate**
from the launch adapter's, so adding the keeper could not invalidate the approved launch
configuration; the two file lists are disjoint, and a test asserts it.

### Evidence

**Bounds, on mocks with the real accounting** — `FOUNDRY_PROFILE=equilibrium forge test
--match-contract EquilibriumKeeperTest`, 24 tests. Constant-product pools with the real v2
balance-delta swap and the real v3 callback ordering, driving every revert path above plus both
happy-path round trips, and asserting a probe spends nothing.

**Real venues on pinned forks** — `bun run equilibrium:keeper-fork-test`, 24 tests. Pinned anvil
forks of Arc testnet (block 64,824,600) and Base Sepolia (block 47,513,000), with the deployed
Architex factory and pair code, the deployed Uniswap v3 factory and pool code and the real Base
Sepolia USDC. The Base pool is seeded through `EquilibriumExecutor`'s v3 mint callback, the same path
a launch's `pool:base` step uses. It proves:

- both pools quoted for the same quantity, spending nothing;
- a full cycle executing at **exactly** the quoted amounts, with vault inventory moving by those
  amounts and nothing else, and token supply untouched;
- a mined Base sale whose settlement write fails, followed by reopening SQLite and creating a new
  keeper: hex, decimal and absent `l1Fee` receipts settle, full leg gas is counted once, the purchase
  vault closes, and a second restart/reconcile changes neither totals nor either sender's nonce;
  19 malformed RPC fee values refuse settlement and send nothing before a corrected receipt closes
  the same sale. Only the `l1Fee` field is injected through a loopback RPC proxy; execution, hashes,
  logs, gas used and gas price are the mined fork receipt's. This is no proof of real Base L1 fees;
- a repeat of a settled leg reverting with nothing moved, and the `LegRun` count staying at one;
- a close attestation that never lands leaving both legs settled and the purchase vault still holding
  the position — blocking a new cycle, `resume` and `withdraw` — and one `reconcile` attesting it,
  closing it and freeing the vault without re-trading anything, with a second reconcile a no-op;
- the same for a recovery whose terminal state was never written;
- a leg planned for one chain refused by the other vault, in both directions — worth stating because
  in the rehearsal the two vaults happen to share an address, and the refusal still holds;
- an expired leg and a misdirected leg refused on the destination chain;
- a failed sale halting both vaults with the position open and its recovery still funded, and a new
  cycle refused by the record *and* by the vault;
- a restart re-reading the exposure from the record and staying halted;
- recovery refused under a tight loss cap with the position left open, then succeeding under the
  configured cap, and `resume()` only working afterwards;
- an exhausted selling inventory stopping that direction and naming the refill as a separate route;
- the configured session spending cap refusing in the runner and in the vault;
- a stale quote and an unfillable size refused;
- the deliberate-failure device refused outside fork mode.

A partial cycle has to be produced on purpose to rehearse recovery, so `runCycle` takes a `failSell`
option that abandons a settled purchase and a `failAttest` option that drops the close attestation.
Both refuse to run unless `mode` is `fork`, and the operator tool never exposes either.

**One reproducible rehearsal** — `bun run equilibrium:keeper-rehearse [--write-preview <path>]`
starts the forks, deploys the vaults, seeds the venues, runs three cases — one complete cycle, one
whose close attestation is dropped and then finished by reconcile, and one deliberately halted cycle
with its recovery — exercises `equilibrium:keeper quote` against the live forks, and writes
`output/equilibrium-keeper-evidence.json`, `output/equilibrium-keeper-fork.json` and the keeper
approval preview. A representative run, 1,000 EQL per cycle:

| Fact | Value |
| --- | --- |
| Arc buy quote / executed | 1,005.019066 USDC / **1,005.019066 USDC** |
| Base sell quote / executed | 1,194.019125 USDC / **1,194.019125 USDC** |
| Closed cycle keeper net, gas included | +188.993474 USDC |
| Dropped close attestation | both legs settled, record `open`, `unresolved()` empty, decision `unresolved_exposure` from the vault |
| Finished by one reconcile | `closed`, net +180.209813 USDC; a second reconcile touched 0 cycles |
| Halted cycle | purchase settled at 1,013.128078 USDC, no sale, both vaults halted |
| Recovery | unwound 1,000 EQL on Arc for 1,007.070578 USDC |
| Recovered cycle net | −6.058626 USDC, inside the 200 USDC loss cap |
| Session totals | realized loss 6.058626 USDC, net +363.144661 USDC, 3 closed |

Numbers move with the pinned blocks' fee levels; the assertions are about equalities and bounds, not
about those figures.

### Known limits

- **Not proven here**: anything live. Public Arc USDC precompile behaviour, real Base L1 data fees,
  and the behaviour of a funded keeper on a public chain are all outside a fork.
- The Base-side token in the original keeper-only rehearsal is an `EquilibriumCanonical` standing in for the bridged
  representation, and Base USDC inventory is credited by storage write. Bridge supply conservation is
  the launch adapter's scope; the trading vault neither mints nor bridges. The combined maintenance
  rehearsal uses the actual launch canonical/spoke and authenticated NTT/CCTP transfers, with its
  distinct substitutions labelled in the maintenance evidence.
- `attestClosed` is an operator attestation of a remote receipt, not a cryptographic proof. Closing
  the loop properly needs a message from the selling chain, which this scope does not add.
- The operator key is hot and owns both vaults. Acceptable for a bounded testnet pilot only.
- One runner process per operator key. Concurrent processes stay correct — the vaults decide — but
  can waste gas on nonce races.
- Maintenance supports Base-to-Arc token return and Arc-to-Base USDC refill only. Arc-to-Base token
  refill, Solana and Robinhood remain closed in this keeper integration.
- Cross-chain P&L and the realized-loss cap are enforced against the durable record, not on-chain: no
  single-chain contract can see both legs. The per-chain spend, drain and reserve caps are on-chain.
