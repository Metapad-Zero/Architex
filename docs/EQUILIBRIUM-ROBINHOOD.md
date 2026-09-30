## EQUILIBRIUM Robinhood spoke — closed adapter and fork rehearsal

Status on 2026-09-30: **the public Robinhood route is closed.** No EQUILIBRIUM token, manager, transceiver or pool exists on Robinhood Chain. What exists is a fork-only route engine and a mixed-environment rehearsal of it against the real Robinhood bytecode.

Code: `server/equilibrium/robinhood/`. Stacked on PR #12 (`add47bb`). It reuses the pinned NTT/executor bytecode and the `evm/` helpers without changing them.

| File | Role |
| --- | --- |
| `pins.ts` | Robinhood mainnet chain/Wormhole IDs, core, Uniswap v3 factory/QuoterV2/SwapRouter02, USDG fixture, runtime code hashes, proxy implementation slots, and the list of open decisions. |
| `access.ts`, `probe.ts` | Pinned-state access probe and bytecode-pin verification. Read-only. |
| `adapter.ts` | The public adapter. Every entry point refuses with `route_closed` in testnet and live mode and names the missing decisions. Configuration cannot open it. |
| `route.ts` | Fork-only engine: hub/spoke deployment, pool seeding, executable quotes, outbound/return transfers, supply accounting. Refuses any RPC that is not loopback. |
| `fork.ts` | Harness: Arc testnet fork + Robinhood mainnet fork, local Guardian, USDG fixture inventory. |
| `__tests__/closed.test.ts` | Always runs. Closed adapter, loopback guard, transfer binding and conflicts. |
| `__tests__/fork.test.ts`, `__tests__/worker.ts` | Opt-in fork rehearsal with real separate worker processes. |

### Observed infrastructure

Read from `https://rpc.mainnet.chain.robinhood.com` around block 76,826,272:

- Chain 4663. The Wormhole core `0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB` reports Wormhole chain 72 and Guardian set 7. Its message fee is 0.
- Uniswap v3: factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, with the 0.30% tier at tick spacing 60. QuoterV2 is `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` (its factory is the one above). SwapRouter02 is `0xcaf681a66d020601342297493863e78c959e5cb2`. Source: [Uniswap Robinhood deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments).
- USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` has six decimals. Source: [Paxos USDG networks](https://docs.paxos.com/guides/stablecoin/usdg/mainnet). **It is a provisional fork fixture.** It is not USDC, and Robinhood Chain has no documented CCTP domain.
- Robinhood testnet 46630 has no documented Wormhole core, NTT route or Uniswap venue.

### Pinned-state access

The public RPC is not an archive node. It served state about 6,000 blocks back and refused 8,000 blocks back, which is roughly ten minutes. The `finalized` tag lags `latest` by about 10,300 blocks, so **the public RPC never serves finalized state**. A fork at a fixed block is reproducible only with an archive RPC.

The harness handles this in three ways:

- It forks `latest − 32` by default.
- It verifies every pinned runtime code hash and EIP-1967 implementation slot at the fork block, and refuses to start if one differs.
- It fails closed when a requested block is not served.

To pin a block, set `EQUILIBRIUM_ROBINHOOD_FORK_RPC` to an archive RPC and set `EQUILIBRIUM_ROBINHOOD_FORK_BLOCK`.

```sh
bun run server/equilibrium/robinhood/probe.ts                      # latest: exit 0, 9/9 pins match
bun run server/equilibrium/robinhood/probe.ts <rpc> <old block>    # exit 1, "not served"
```

### Rehearsal

```sh
bun test server/equilibrium/robinhood                                   # closed-route tests only
EQUILIBRIUM_ROBINHOOD_FORK=1 bun test server/equilibrium/robinhood      # plus the fork rehearsal, about 15 s
```

This pairs an **Arc testnet** fork (pinned block 64,824,600, as in `evm/fork.ts`) with a **Robinhood mainnet** fork. It is **mixed-environment compatibility evidence, not a route**. Evidence is written to `output/robinhood-fork-evidence.json`.

These parts are real bytecode:

- The pinned NTT `NttManager` and `WormholeTransceiver` (`c636cc15`).
- `EquilibriumExecutor` and the EQUILIBRIUM tokens.
- The Arc testnet Wormhole core, the Robinhood mainnet Wormhole core, and the Robinhood Uniswap v3 factory, pool, QuoterV2 and SwapRouter02.
- USDG.

The rehearsal makes four substitutions, all fork-local:

- It overwrites one local Guardian key into each core.
- It credits USDG inventory by storage write (mapping slot 1).
- The Robinhood fork runs anvil's `shanghai` rules, because Arbitrum Orbit headers have no blob-gas fields.
- Arbitrum gas, including its L1 component, is not modelled.

Each test covers one guarantee:

| Test | What it establishes |
| --- | --- |
| pinned state | The fork runs exactly the pinned Robinhood bytecode. The public RPC does not serve its finalized block. An old pin fails closed. |
| deploy | The hub and spoke deploy through the executors. Only the spoke manager can mint. Repeated deployment calls are refused on-chain. |
| outbound + delayed finality | With 5 required Arc confirmations, three advances return `awaiting_finality` and nothing is minted. After finality, the transfer credits exactly once. Custody always equals spoke supply plus pending. |
| replay | The real transceiver rejects the same VAA a second time. The executor refuses the credit operation a second time. |
| authenticated credit | The destination refuses each of these: a tampered signature, the wrong emitter, the wrong Guardian key, an unpeered source chain, a direct `mint`, and re-binding the minter. After those failures, the genuine VAA still credits. |
| market | The real v3 factory accepts the spoke/USDG pair. A QuoterV2 quote equals an actual SwapRouter02 fill, to the atom. A swap changes no supply. |
| return + crash | A separate worker is SIGKILLed right after sending the Robinhood debit, before it records anything. On restart, a new process finds the debit still pending, waits for it instead of re-sending, and completes. There is one debit, one credit, and no extra operator transaction. |
| stale / concurrent | An in-process worker races a separate process on the same credit. A worker restored from a journal snapshot taken before the credit then resumes. There is exactly one credit execution. |
| round trip | Returning everything the executor holds leaves custody equal to spoke supply, which is exactly the pool's and the trader's tokens. |

### Paid launch job on the fork (49TH-32)

The durable shared-supply launch job now runs end to end over HTTP against this route, still fork-only. Code: `fulfillment.ts` (job adapter), `fulfillment-fork.ts` (harness), `serve.ts` (service on port 4046), `__tests__/fulfillment*.ts`. It uses its own ports (Arc 18655, Robinhood 18656, service 4046) and its own job journal under `output/robinhood-fulfillment-*`. It does not import or change the Arc–Base release gate.

- **One canonical asset.** The harness deploys the asset and its Arc hub once with `deployHub`. A launch job adopts those operations; it does not issue again. Only an Arc+Robinhood request for that exact name, symbol and issuance is accepted. The first job to reach its payment step binds the asset. Any other request for it is refused with `asset_launched` before anything is charged.
- **Step to operation mapping.** Each job step runs exactly one executor operation. The job persists that operation's bytes. The route journal must hold the same digest, or the step is refused as `operation_conflict`. Debit and credit drive one route transfer per job. The debit is complete only once its VAA is attested. The credit mints to the Robinhood executor, which seeds the pool and forwards the recipient's remainder.
- **Labels.** Every response carries `x-equilibrium-environment: mixed:arc-testnet-fork+robinhood-mainnet-fork` and `x-equilibrium-payment: fork-fixture`. `/api/equilibrium` reports the fixed labels:
  - x402 payments use ForkUsdc with an anvil payer.
  - The Robinhood pool quote is USDG credited by storage write. The payer's Arc USDC for it stays on Arc, because Robinhood has no CCTP domain.
  - Robinhood gas is priced at a fixed 5,000 USDC/ETH with no tip, and its L1 component is not modelled.
  A configuration cannot relabel these.

Run it with `EQUILIBRIUM_ROBINHOOD_FULFILLMENT=1 bun test server/equilibrium/robinhood/__tests__/fulfillment.test.ts`. Evidence is written to `output/robinhood-fulfillment-evidence.json`.

| Test | What it establishes |
| --- | --- |
| quote | A real service process returns 402 bound to the Arc executor and the quoted total. It refuses a changed payload under the same requestId (`identity_conflict`), a Base destination (`route_closed`), another asset (`asset_mismatch`), and a header signed for a different quote (`invalid_payment`). |
| crash after payment | The service is SIGKILLed right after sending the payment. The payer is charged exactly once, and the job records no result. |
| crash after debit + race | A worker is SIGKILLed after the debit send. Two workers then race, and the lease admits one; the other gets `job_busy`. The one admitted is SIGKILLed after the credit send. There is one debit and one credit. |
| restart | A restarted service sweeps the journal without a client resend. It completes all eight steps, each executed exactly once. Custody equals spoke supply and nothing is pending. QuoterV2 prices both directions against the job's pool. |
| replay | Re-posting the paid request returns the same job and transactions. Balances and executions are unchanged. A second requestId for the asset is refused uncharged. |
| stale / replayed | Broadcasting every step again from persisted bytes changes nothing, including from the crashed stale snapshot. The stale snapshot cannot be saved. The operator's `execute` for each of the eight operations reverts. The payer's authorization reverts when replayed directly on USDC. The VAA reverts when replayed to the transceiver. |

### What remains before any public Robinhood route

These are the gates the closed adapter reports (`pins.ts`, `ROBINHOOD_DECISIONS`):

1. **environment**: choose the pair of networks for a public rehearsal. No Robinhood testnet has a core or venue. A public test would be Arc mainnet with Robinhood mainnet, or it would wait until a testnet core exists.
2. **quote_asset**: approve the Robinhood quote asset. USDG is only a fixture.
3. **refill**: approve an inventory and refill policy for the quote asset and for ETH gas. CCTP cannot refill from Arc USDC.
4. **custody**: approve who holds the spoke manager/transceiver owner powers (upgrade, peers, threshold, limits, pause) and the executor operator key.
5. **funding**: approve deployment gas, pool seed tokens and quote, and the Wormhole message fee (currently 0).
6. **finality**: approve a finality policy. Guardian attestation latency at consistency level 0 on this route is unmeasured.
7. **state_access**: provide an archive-capable Robinhood RPC if rehearsals must be reproducible at a fixed block.
