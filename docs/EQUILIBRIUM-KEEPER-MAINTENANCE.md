## Bounded keeper inventory maintenance

The trading loop pauses a direction when inventory is depleted. The operator can separately restore
Arc sale tokens and Base purchase cash through the reviewed PR #15 return/refill paths. This
integration uses existing executor-owned assets from one completed launch. It creates no issuance,
reseeds no pools, and changes no holder inventory or vault contract.

| Asset | Authenticated route | Destination |
| --- | --- | --- |
| EQL | Base executor → NTT burn → Wormhole VAA → Arc NTT unlock | Arc keeper vault |
| USDC | Arc executor → CCTP V2 burn → attestation → Base mint | Base executor, then replay-protected ERC20 deposit to Base keeper vault |

The executor's operation/digest binding enforces each effect at most once. The added USDC deposit
uses the same executor and records its exact calldata before sending. Settlement checks the mined
USDC `Transfer` log from the approved Base executor to the approved Base keeper for the exact amount.
Arc-to-Base **token** refill is outside this scope: depleted Base sale tokens still stop that direction.

### Three separate approvals

Launch approval remains unchanged and authorizes its named launch only. Public maintenance requires
both `EQUILIBRIUM_KEEPER_APPROVAL` and `EQUILIBRIUM_TRANSFER_APPROVAL`, each matching its own exact
files and manifest. A keeper-only approval and a transfer-only approval both fail before sending.

The keeper configuration includes an optional `maintenance` scope:

```json
{
  "maintenance": {
    "launch": "<completed launch ID>",
    "executors": { "arc": "<owned Arc executor>", "base": "<owned Base executor>" },
    "maxTokenPerTransfer": "500000000",
    "maxTokenTotal": "500000000",
    "maxQuotePerTransfer": "3000000",
    "maxQuoteTotal": "3000000"
  }
}
```

These are decimal asset atoms, not human currency amounts. Scope absent means maintenance is closed.
The coordinator checks chain IDs, RPCs, quote assets, gas conversion and finality against the separately
approved transfer configuration. Before every send it checks both executor/vault ownership, the named
launch's completion, its canonical/spoke assets and pools, and absence of open positions on both vaults.
The underlying NTT/CCTP bounds and cumulative transfer gas caps also apply. Changing any settings
requires refreshed approvals; changing settings cannot replace an unfinished request.

`keeper/approval.ts` pins the coordinator along with the keeper's existing broadcast dependencies
(16 files). The transfer approval covers every shared launch dependency through the complete frozen
launch manifest. The keeper and launch file lists stay disjoint. Fork helpers and rehearsals are not
public broadcast dependencies.

### Admission, restart and accounting

Keeper cycle admission and maintenance reservation use `IMMEDIATE` transactions in the **same**
`KeeperStore` SQLite database. New maintenance refuses any open or halted cycle, including a traded
cycle whose close is unfinished. Pending maintenance blocks new keeper cycles, even after balances
arrive but before final settlement is recorded. On-chain exposure also refuses maintenance when it
is missing from the caller's local record. Recover/reconcile the exposure first.

Each request reserves its token and USDC amounts against cumulative maintenance caps before any send.
Pending reservations continue to count. One unfinished maintenance request must finish before another
can start. Stable request IDs identify stable transfer IDs and prepared operations. Reusing an ID
with different amounts or settings is refused. A completed request and a second reconcile send nothing.

Maintenance expenses come from the transfer gas ledger, including L1 fees and mined retries. The
coordinator selects only its linked operations, counts each chain/transaction once, and converts native
cost to quote atoms by rounding up. Outstanding reservations remain visible and prevent completion.
Transferring owned principal is neither trading profit nor an expense.

`maintenance.totals()` reports trading net/loss separately from maintenance realized/reserved costs;
`combinedNet = trading.net − maintenance.realized`. Reopening the record recomputes these totals from
persisted receipts rather than adding the same expense again. Pool/treasury revenue and customer demand
are separate claims. Deployment, fixture setup and keeper control transactions are outside this
maintenance subtotal and the keeper's existing trade-leg profit calculation.

### Operator commands

Keep `EQUILIBRIUM_KEEPER_DB` identical for trading and maintenance. `EQUILIBRIUM_DB` names the durable
record containing the approved completed launch; it may be a separate file. Keys stay in environment
variables; the configuration files and previews contain no keys.

```sh
export EQUILIBRIUM_EVM_CONFIG=<approved-adapter-config>
export EQUILIBRIUM_TRANSFER_SETTINGS=<approved-transfer-settings>
export EQUILIBRIUM_KEEPER_PREVIEW=<exact-approved-keeper-preview>
export EQUILIBRIUM_KEEPER_DB=<shared-durable-keeper-record>
export EQUILIBRIUM_DB=<completed-launch-record>

bun run equilibrium:keeper preview --config <keeper-config> --write <keeper-preview>
bun run equilibrium:keeper maintenance-preview --config <keeper-config> --write <maintenance-preview>
bun run equilibrium:keeper maintain --config <keeper-config> --request-id keeper-refill-001 --tokens 500000000 --quote 3000000 --yes
bun run equilibrium:keeper maintenance-reconcile --config <keeper-config> --yes
bun run equilibrium:keeper status --config <keeper-config>
```

The maintenance preview lists both approval digests, routes, recipients, assets, managers, domains,
attestation source and caps. `--yes` is required for sending commands. The trading loop never funds or
automatically restores inventory. Preserve a stopped request and its reservations; reconcile it rather
than creating a replacement. Public mode is bounded testnet only; there is no live mode.

### Combined evidence and limitations

`bun run equilibrium:keeper-maintenance-fork-test` runs the combined regression. The separately
invocable `bun run equilibrium:keeper-maintenance-rehearse` writes keyless reproduction configurations,
`output/equilibrium-keeper-maintenance-evidence.json`, and fresh keeper/maintenance previews. It uses the
real completed launch canonical/spoke, NTT managers, executor, Architex pair and Uniswap v3 pool on
pinned Arc/Base forks.

The proof starts with zero Arc keeper tokens and zero Base keeper USDC. It refuses a trade, restores
500 million token atoms and 3 million USDC atoms within approved bounds, and interrupts after an
actual NTT burn and after the mined final USDC deposit. Reopening SQLite and fresh CLI processes settle
the deposit, run one bounded cycle, and reconcile again without duplicate effects or trades. Five
maintenance operations each have one `Executed` log; both trade legs each have one `LegRun` log.
Only zero-message-fee NTT returns and zero-fee CCTP refills are accepted. A nonzero native protocol
payment is refused before saving or broadcasting the prepared return, including a persisted plan after
restart. Gas approval does not authorize that additional payment. A stopped request remains reserved.

Receipt-derived costs agree with an independent sum and survive restart unchanged. Per-transfer,
cumulative and identity refusals, local/on-chain exposure refusals and both independent approval
failures send nothing. The evidence records sender nonces, balances, receipts and supply conservation.

Fork substitutions are explicit: a local Wormhole Guardian set and CCTP attester set (threshold 1),
an Arc USDC stand-in, development-key gas, and locally staged existing operator-issued spoke inventory.
Base starts at zero USDC and receives its pool and keeper cash through CCTP. Anvil receipts commonly
omit L1 fees. None proves public Guardian/Circle attestations, Arc USDC precompile settlement, real
Base L1 fees, public paid settlement or four-chain fulfillment.

Maintenance and trading remain cross-chain, non-atomic operator workflows. Use one runner per operator
key and the shared record. The local admission lock cannot police manual owner transactions or a
different database, and the checks are not a cross-chain contract lock. Remote close remains the
keeper's existing operator receipt attestation, not a cryptographic proof. Active Robinhood/Solana
work stays outside this branch's integration scope.
