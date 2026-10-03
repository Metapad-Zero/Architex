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

### What remains before any public Robinhood route

These are the gates the closed adapter reports (`pins.ts`, `ROBINHOOD_DECISIONS`):

1. **environment**: choose the pair of networks for a public rehearsal. No Robinhood testnet has a core or venue. A public test would be Arc mainnet with Robinhood mainnet, or it would wait until a testnet core exists.
2. **quote_asset**: approve the Robinhood quote asset. USDG is only a fixture.
3. **refill**: approve an inventory and refill policy for the quote asset and for ETH gas. CCTP cannot refill from Arc USDC.
4. **custody**: approve who holds the spoke manager/transceiver owner powers (upgrade, peers, threshold, limits, pause) and the executor operator key.
5. **funding**: approve deployment gas, pool seed tokens and quote, and the Wormhole message fee (currently 0).
6. **finality**: approve a finality policy. Guardian attestation latency at consistency level 0 on this route is unmeasured.
7. **state_access**: provide an archive-capable Robinhood RPC if rehearsals must be reproducible at a fixed block.
