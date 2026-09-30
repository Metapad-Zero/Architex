## EQUILIBRIUM keeper approval preview

Generated 2026-09-30T22:01:32Z for keeper version `equilibrium-keeper-v1:22b98c8fceaf8605`, mode **fork**.

> **Fork rehearsal, not an approval request.** Every address below belongs to a local anvil fork
> and every signer is a development key. A live preview is regenerated against deployed vaults with
> `bun run equilibrium:keeper preview --config <testnet file> --write <path>`, and only that digest is
> worth approving.

This authorizes **bounded keeper trading only**. It does not authorize a launch, a deployment, an
issuance, a bridge transfer, an inventory refill, a public announcement or any change to the
approved launch configuration. The launch release approval is a separate digest over separate files.

### Routes and contracts

| Chain | Keeper vault | Pool | Token | Quote asset |
| --- | --- | --- | --- | --- |
| arc (chain id 5042002) | `0xf1a2ee3969061d6e36a210508c288b50c91c63c3` | `0x3fFF12004565035D4Cf9525eF7E8e3b37436E556` (architex-pair) | `0x1339e1782CE2F7a7f233e82De47c50faf6e5fFB4` | `0x3600000000000000000000000000000000000000` |
| base (chain id 84532) | `0xf1a2ee3969061d6e36a210508c288b50c91c63c3` | `0x69222911Dd9207eeb2728310E2a363B1F3F0352F` (uniswap-v3-pool) | `0x7ac0E82C82503b9b648C52a25ed27A6eBd01E869` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

Keeper creation code `565b8e941a773295e8d4d9670229072ded0608bc7c700f36aa1c4ae2b56ffb85` built with solc 0.8.28+commit.7893614a.

### Signing and admin powers

The operator key `0x500d75F1329cf98352c32Cf238c2192ca78faFFE` owns both vaults. Through them it may run legs,
halt, resume, attest a remote sale and withdraw inventory. It has **no** power over the canonical
issuance, the NTT managers, the pools' liquidity positions or any holder balance: the keeper trades
only its own vault inventory and can neither mint, rebase nor redistribute. A vault's bounds are
immutable — changing one means deploying a new vault and a new approval.

### Bounds the contracts enforce

| Chain | Max tokens / leg | Max quote / leg | Session spend cap | Recovery reserve | Net drain cap | Max open cycles |
| --- | --- | --- | --- | --- | --- | --- |
| arc | 2000 EQL | 3000 USDC | 5000 USDC | 1500 USDC | 4000 USDC | 1 |
| base | 2000 EQL | 3000 USDC | 5000 USDC | 1500 USDC | 4000 USDC | 1 |

A leg also carries its chain id, its pool address and a deadline, and the vault refuses a leg whose
id has already run. A repeat, a replay on the wrong chain and a leg planned against a stale quote all
revert on the destination chain.

### Bounds the runner enforces against the durable record

| Bound | Value |
| --- | --- |
| Minimum edge to open a cycle | 1 USDC |
| Execution buffer | 0.5 USDC |
| Reserved recovery cost | 2 USDC |
| Absolute per-leg gas ceiling | 1 USDC |
| Session realized-loss cap | 200 USDC |
| Quote freshness | 600s and 20 blocks behind head |
| Chain availability window | 3600s without a new block |
| Leg validity | 600s |
| Slippage allowance | 50 bps |
| Cycles open at once | 1 |

Worst-case gas and reserved recovery cost for one cycle at current fees: **2.022917 USDC**.

### Current inventory and counters

| Chain | Keeper tokens | Keeper quote | Spent | Received | Open cycles | State |
| --- | --- | --- | --- | --- | --- | --- |
| arc | 6000 EQL | 5979.862075 USDC | 3027.208503 USDC | 1007.070578 USDC | 0 | running |
| base | 2000 EQL | 10383.295417 USDC | 0 USDC | 2383.295417 USDC | 0 | running |

Inventory refill and the Base-to-Arc return route are **not** part of this approval. When a chain's
inventory is exhausted the keeper stops trading that direction and says so.

### What a run does, and what it reports

Each cycle quotes both pools for the same token quantity through the vaults' own `probe`, buys on the
cheaper chain and sells on the dearer one, inside every bound above. Keeper profit is reported
separately from the combined pool and treasury outcome; keeper volume is not customer demand and the
keeper's own payments are not revenue.

### Verification steps

1. `bun run scripts/equilibrium-keeper-bytecode.ts --check` — the pinned keeper code matches a fresh build.
2. `bun run equilibrium:keeper preview --config <file>` — regenerates this preview and its digest from live reads.
3. `bun run equilibrium:keeper verify --config <file>` — both vaults are owned by the operator and bound to these pools and bounds.
   `bun run equilibrium:keeper status --config <file>` — nothing unresolved and nothing unfinished before a session starts.
4. `bun run equilibrium:keeper quote --config <file> --tokens <n>` — both pools quoted for the same quantity, with the decision and its reason.
5. `EQUILIBRIUM_FORK=1 bun test server/equilibrium/keeper/__tests__/fork.test.ts` — the fork rehearsal.

### Operating duration and stop conditions

One session, ended by the operator. The keeper stops on its own when: a sale leg fails (both vaults
halt and the position stays open until it is recovered), the realized-loss cap is reached, a chain is
unavailable or its quotes are stale, inventory is exhausted, or a spend cap is reached.

### Recovery and cleanup

1. `bun run equilibrium:keeper status --config <file>` lists two things separately: **unresolved**
   cycles, which still hold a position, and **unfinished** ones, whose trade completed but whose close
   attestation on the purchase vault never landed.
2. `bun run equilibrium:keeper reconcile --config <file> --yes` finishes the unfinished ones. It
   observes before it sends, costs at most one attestation transaction per cycle, and is safe to run
   again — run it first, before anything else, because an outstanding close blocks trading, resuming
   and withdrawing while nothing is actually at risk.
3. `bun run equilibrium:keeper recover --config <file> --cycle <id>` unwinds a position on the market
   it was bought on, inside the remaining loss budget. If the unwind would pass the cap it is refused
   and the position stays open — the cap is never relaxed to close a position.
4. `bun run equilibrium:keeper resume --config <file>` only succeeds once no cycle is open.
5. Preserve the keeper record (and its WAL). Restarting with the same configuration re-observes every
   planned leg before sending anything, and finishes any outstanding close.
6. To end the pilot: reconcile, halt, resolve every open cycle, then withdraw both assets from each
   vault. The vault refuses a withdrawal while a cycle is open or while it is halted.
