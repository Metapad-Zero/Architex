# Making Architex private by design

Owner's question (2026-09-19): *how would we make this inherently zero-knowledge?* This note is the
answer as it stands. Nothing here is built. It records what is possible on Arc, what is not, what we
would do, and what our code would need.

## What "private" would have to mean

Today everything is public, as on any EVM chain: who traded, how much, what they hold, who launched a
token and who bought it first. Launchpad traders care about this more than most: wallets get tracked,
copied and front-run within minutes.

A DEX cannot hide everything. Someone has to know the pool's reserves to quote a price. So the target
worth having is **a public market with private participants**:

| Stays public | Becomes private |
| --- | --- |
| Pool reserves and the price | Who swapped, and what any one wallet swapped |
| A curve's progress and market cap | Who bought a launch, and when |
| Total supply, locked liquidity | Every wallet's balances and history |
| Concentration *figures* ("top 10 hold 31%", "creator holds 4%") | The addresses behind them |

The last row matters. Holder lists are how people check a launch is not a rug. Hiding them outright
would remove a safety signal, so a private launchpad has to publish the aggregates without the names.

## Three ways to get there

### 1. Arc's own privacy layer (APS). Recommended, not yet available

Arc's documentation describes **Arc Privacy Sector**: a second execution environment for ordinary
Solidity, running beside the public EVM in the same blocks, atomically composable with it. Private
transactions are encrypted to the network's key and sent to a precompile; validators execute them
inside hardware enclaves; state is encrypted at rest; assets move between the public and private side
through a precompile within one block. Contracts are isolated by default, and exposure is opt-in per
function (`Open`, `Restricted`, `Locked`) and per trusted contract.

Two facts decide everything:

- **It is not zero-knowledge.** Privacy comes from hardware enclaves plus a master key split across
  validators, not from proofs. You trust the enclave vendor and a threshold of validators rather than
  mathematics. That is weaker in theory and far more capable in practice: it runs *existing* Solidity.
- Arc's page says: *"Privacy features are on the roadmap and not yet available on Arc."*

When it ships, this is the route. Our contracts are plain Solidity, so the AMM and the launchpad would
deploy into APS largely as they are, with an access policy that implements the table above: quotes,
reserves, `buy`, `sell` and `swap` Open; other people's balances Restricted; an Open view that returns
concentration figures. That would make Architex private for every user by default, not as an opt-in
mode. It is also the only route the chain's operator endorses, which matters because of point 2.

### 2. Our own zero-knowledge shielded pool. Possible today, advised against

The Railgun / Aztec Connect design: users deposit into a shielded contract (note commitments in a
Merkle tree, nullifiers, a zk-SNARK proving ownership), and the contract swaps on Architex on their
behalf and returns the output as a new shielded note. Observers see that *the pool* traded, never who.
Relayers submit the transactions; on Arc they could be paid in USDC out of the shielded amount, which
is unusually clean because gas is USDC.

Why not:

- **USDC can be frozen.** Circle can blocklist any address on Arc, and a mixer on Circle's own chain
  is the likeliest thing to be blocklisted. Everyone's funds inside would freeze together. Designs with
  proofs of innocence (Privacy Pools) reduce that risk; they do not remove it.
- **It is the most dangerous kind of contract to write.** A circuit bug is unlimited minting or total
  loss, and neither is visible until it happens. It needs circuits, a proving system, a trusted setup or
  a universal one, in-browser proving, relayers, and a specialist audit. Months, not days.
- It hides identities but not trade sizes, unless orders are also batched, which is a second project.

If a mature shielded-pool protocol deploys on Arc, integrating it is reasonable. Building one is not.

### 3. What can be done now, without either

Not zero-knowledge, but real, and cheap:

- The app already makes no third-party requests beyond the RPC, the explorer and the IPFS gateways we
  choose; creators can no longer make a visitor's browser contact a host of their choosing; passkey
  wallets need no email or account.
- **A fresh address per launch or per token.** The passkey wallet derives its key from a counter
  (`secp256k1:<n>` in `src/lib/keystore.ts`), so one passkey can own many unlinkable addresses. Funding
  them is the hard part: every transfer between them is a public link.
- **Proxy the RPC through our domain**, so Arc's RPC operator cannot tie a visitor's IP address to a
  wallet. This moves that trust to us, which is only an improvement if we log nothing.

## What our code would need for route 1

Inside APS, *"no execution results, return values, or event logs are exposed to the public ledger"*,
events are off unless a precompile is used, and introspection such as another contract's `balanceOf`
answers zero without a trust grant.

| Today | Needed |
| --- | --- |
| The create flow learns the new token's address by parsing the `TokenCreated` log (`useCreateToken`) | Read it from state (`tokenAt(tokensLength - 1)` for that creator) or from an authorised result query |
| Trade history and the market-cap chart come from `Trade` logs (`useLaunchTrades`) | A short on-chain ring of recent *anonymised* trades per token (price, size, time, no trader), readable by an Open view |
| Pool price history comes from `Sync` logs (`usePriceHistory`) | The pair's cumulative-price accumulators, which it already keeps, sampled by an Open view |
| The pair reads `token.balanceOf(address(this))` | Each launch token grants trust to its pair and the launchpad at creation. The launchpad deploys the token, so it can |
| Anyone can read anyone's balance | Restricted: a wallet reads its own, with authorisation |
| Holder lists are public | An Open view returning concentration figures, computed inside the private side |
| USDC is the public ERC-20 | Whatever form USDC takes inside APS. Unknown until Arc documents the bridge precompile |

None of this is worth building before APS exists: the precompile interface, the access-policy API and
private USDC are not specified yet, and guessing at them would mean rewriting. What *is* worth doing
is not adding new dependencies on public logs, and keeping every figure the interface needs available
from a view function.

## Decision

- Route 1 when Arc ships it. Revisit this note when the APS developer documentation appears.
- Route 2: no, unless someone else's audited protocol arrives on Arc.
- Route 3: available now if wanted. The per-launch address is the one with real value.
