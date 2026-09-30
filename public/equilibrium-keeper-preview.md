## EQUILIBRIUM keeper approval preview

Generated 2026-09-30T23:39:00.784Z for keeper version `equilibrium-keeper-v1:73944f0f5a82440d`, mode **fork**.

> **Fork rehearsal, not an approval request.** Every address below belongs to a local anvil fork
> and every signer is a development key. A live preview is regenerated against deployed vaults with
> `bun run equilibrium:keeper preview --config <testnet file> --write <path>`, and only that digest is
> worth approving.

This authorizes **bounded keeper trading** and the maintenance scope below only when paired with
the **separate transfer approval**. Keeper approval alone authorizes no bridge transfer or refill.
It does not authorize a launch, a deployment, an issuance, a public announcement or any change to the
approved launch configuration. The launch release approval is a separate digest over separate files.

### Routes and contracts

| Chain | Keeper vault | Pool | Token | Quote asset |
| --- | --- | --- | --- | --- |
| arc (chain id 5042002) | `0xf57971edebb18bfc75638465a10d623d90bd5e7e` | `0x40bbf67835462e0337e99aD9F796DF7a211D536C` (architex-pair) | `0x922159d26A6D96773861463BF7Af87c9Ed4B41f0` | `0x3600000000000000000000000000000000000000` |
| base (chain id 84532) | `0x4720960b18ffe44b284eef86357ecfa6f935891e` | `0xF72e51FbE88d1614b6754cF8F099F1443eb10259` (uniswap-v3-pool) | `0x4D6f793D19029E85bB372a774Ac1d53133095627` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

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
| arc | 200 EQL | 1 USDC | 5 USDC | 1 USDC | 5 USDC | 1 |
| base | 200 EQL | 1 USDC | 5 USDC | 1 USDC | 5 USDC | 1 |

A leg also carries its chain id, its pool address and a deadline, and the vault refuses a leg whose
id has already run. A repeat, a replay on the wrong chain and a leg planned against a stale quote all
revert on the destination chain.

### Bounds the runner enforces against the durable record

| Bound | Value |
| --- | --- |
| Minimum edge to open a cycle | 0.001 USDC |
| Execution buffer | 0.001 USDC |
| Reserved recovery cost | 0.01 USDC |
| Absolute per-leg gas ceiling | 0.1 USDC |
| Session realized-loss cap | 2 USDC |
| Quote freshness | 600s and 20 blocks behind head |
| Chain availability window | 3600s without a new block |
| Leg validity | 600s |
| Slippage allowance | 50 bps |
| Cycles open at once | 1 |

Worst-case gas and reserved recovery cost for one cycle at current fees: **0.032847 USDC**.

### Current inventory and counters

| Chain | Keeper tokens | Keeper quote | Spent | Received | Open cycles | State |
| --- | --- | --- | --- | --- | --- | --- |
| arc | 400 EQL | 0.195501 USDC | 0 USDC | 0.195501 USDC | 0 | running |
| base | 100 EQL | 2.897018 USDC | 0.208962 USDC | 0.10598 USDC | 0 | running |

### Separately approved inventory maintenance

Launch identity: `0x7caf9cd5c67436417fff688c36af750af1a61bdeb94fd63f264a9000383c7096`.
Source executors: Arc `0x9c409262efa8e122e00b1c6efaf5e1135325b7ca`, Base `0xbf0fe883bbaa0565af4b02fa9d6a6a85c96a2924`.
Token route: Base executor inventory → authenticated NTT return → Arc keeper vault.
USDC route: Arc executor inventory → authenticated CCTP refill → Base executor → Base keeper vault.
Token caps: 500 EQL per transfer, 500 EQL total.
USDC caps: 3 USDC per transfer, 3 USDC total.

This keeper scope permits that bounded maintenance only with the **separate transfer approval** for
the exact adapter configuration, transfer settings, gas caps and code. It uses existing executor
inventory. It never funds a vault from holder inventory or issues tokens. Open local/on-chain
exposure refuses maintenance, and pending maintenance blocks trading until reconciliation finishes.
Maintenance costs are counted separately from trading profit. Its approval preview lists both digests.
Only zero-message-fee NTT and zero-fee CCTP maintenance is accepted; native protocol payments stay closed.

When inventory is exhausted the keeper stops trading that direction and names the separate route.

### What a run does, and what it reports

Each cycle quotes both pools for the same token quantity through the vaults' own `probe`, buys on the
cheaper chain and sells on the dearer one, inside every bound above. Keeper profit is reported
separately from the combined pool and treasury outcome; keeper volume is not customer demand and the
keeper's own payments are not revenue.

Realized leg gas includes execution gas plus the receipt's L1 fee, counted once. Hex and decimal
fees are parsed as exact wei; an absent fee contributes zero. An unreadable fee leaves the leg
unsettled until reconciliation can read a valid receipt, without sending the trade again. This
receipt accounting is pinned by the separate keeper approval manifest.

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
