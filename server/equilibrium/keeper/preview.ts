/**
 * The keeper approval preview: the exact thing the owner is asked to approve before the keeper may
 * trade anything but a fork. Built from the configuration and from reads of the deployed vaults, so
 * it cannot describe bounds the contracts do not actually carry.
 *
 * Separate from the launch release preview on purpose. Approving a launch does not authorize
 * trading, and approving the keeper does not authorize a launch, a deployment or a refill.
 */
import { formatUnits, type PublicClient } from 'viem'
import { keeperApprovalDigest, keeperManifest } from './approval'
import { erc20Abi, keeperAbi, KEEPER_CODE } from './contracts'
import { LEG_GAS, legFees, legCost, keeperClients } from './quotes'
import { KEEPER_CHAINS, type KeeperChain, type KeeperConfig } from './types'

export interface VaultFacts {
  chain: KeeperChain
  chainId: number
  keeper: string
  owner: string
  token: string
  quote: string
  pool: string
  venue: string
  maxTokensPerLeg: string
  maxQuotePerLeg: string
  spendCap: string
  recoveryReserve: string
  drainCap: string
  maxOpenCycles: number
  spentQuote: string
  receivedQuote: string
  openCycles: number
  halted: boolean
  keeperTokens: string
  keeperQuote: string
  /** Worst-case cost of one leg at current fees, in quote atoms. */
  legCost: string
}

export async function vaultFacts(config: KeeperConfig, clients = keeperClients(config)): Promise<VaultFacts[]> {
  const facts: VaultFacts[] = []
  for (const chain of KEEPER_CHAINS) {
    const c = config[chain]
    const client: PublicClient = clients[chain]
    const at = { address: c.keeper, abi: keeperAbi } as const
    const [owner, token, quote, pool, , maxTokensPerLeg, maxQuotePerLeg, spendCap, recoveryReserve, drainCap, maxOpenCycles, spentQuote, receivedQuote, openCycles, halted] = await Promise.all([
      client.readContract({ ...at, functionName: 'owner' }), client.readContract({ ...at, functionName: 'token' }),
      client.readContract({ ...at, functionName: 'quote' }), client.readContract({ ...at, functionName: 'pool' }),
      client.readContract({ ...at, functionName: 'venue' }), client.readContract({ ...at, functionName: 'maxTokensPerLeg' }),
      client.readContract({ ...at, functionName: 'maxQuotePerLeg' }), client.readContract({ ...at, functionName: 'spendCap' }),
      client.readContract({ ...at, functionName: 'recoveryReserve' }), client.readContract({ ...at, functionName: 'drainCap' }),
      client.readContract({ ...at, functionName: 'maxOpenCycles' }), client.readContract({ ...at, functionName: 'spentQuote' }),
      client.readContract({ ...at, functionName: 'receivedQuote' }), client.readContract({ ...at, functionName: 'openCycles' }),
      client.readContract({ ...at, functionName: 'halted' }),
    ])
    const [keeperTokens, keeperQuote] = await Promise.all([
      client.readContract({ address: c.token, abi: erc20Abi, functionName: 'balanceOf', args: [c.keeper] }),
      client.readContract({ address: c.quote, abi: erc20Abi, functionName: 'balanceOf', args: [c.keeper] }),
    ])
    const fees = await legFees(client, c)
    facts.push({
      chain, chainId: c.chainId, keeper: c.keeper, owner, token, quote, pool, venue: c.venue,
      maxTokensPerLeg: maxTokensPerLeg.toString(), maxQuotePerLeg: maxQuotePerLeg.toString(), spendCap: spendCap.toString(),
      recoveryReserve: recoveryReserve.toString(), drainCap: drainCap.toString(), maxOpenCycles: Number(maxOpenCycles),
      spentQuote: spentQuote.toString(), receivedQuote: receivedQuote.toString(), openCycles: Number(openCycles), halted,
      keeperTokens: keeperTokens.toString(), keeperQuote: keeperQuote.toString(),
      legCost: (await legCost(client, c, LEG_GAS[c.venue], fees.maxFeePerGas)).toString(),
    })
  }
  return facts
}

const usdc = (atoms: string) => `${formatUnits(BigInt(atoms), 6)} USDC`
const tokens = (atoms: string) => `${formatUnits(BigInt(atoms), 6)} EQL`

/**
 * The markdown the owner approves. `keeperApprovalDigest(preview, config)` over this text, the exact
 * configuration file and the keeper code manifest is what the runner then requires.
 */
export function keeperPreview(config: KeeperConfig, facts: VaultFacts[], version: string, generatedAt: string): string {
  const p = config.policy
  const worstCaseCycle = facts.reduce((sum, fact) => sum + BigInt(fact.legCost), 0n) + BigInt(p.recoveryCost)
  const rows = facts.map((f) => `| ${f.chain} (chain id ${f.chainId}) | \`${f.keeper}\` | \`${f.pool}\` (${f.venue}) | \`${f.token}\` | \`${f.quote}\` |`).join('\n')
  const bounds = facts.map((f) => `| ${f.chain} | ${tokens(f.maxTokensPerLeg)} | ${usdc(f.maxQuotePerLeg)} | ${usdc(f.spendCap)} | ${usdc(f.recoveryReserve)} | ${usdc(f.drainCap)} | ${f.maxOpenCycles} |`).join('\n')
  const inventory = facts.map((f) => `| ${f.chain} | ${tokens(f.keeperTokens)} | ${usdc(f.keeperQuote)} | ${usdc(f.spentQuote)} | ${usdc(f.receivedQuote)} | ${f.openCycles} | ${f.halted ? 'halted' : 'running'} |`).join('\n')
  const forkBanner = config.mode === 'fork'
    ? `
> **Fork rehearsal, not an approval request.** Every address below belongs to a local anvil fork
> and every signer is a development key. A live preview is regenerated against deployed vaults with
> \`bun run equilibrium:keeper preview --config <testnet file> --write <path>\`, and only that digest is
> worth approving.
`
    : ''
  return `## EQUILIBRIUM keeper approval preview

Generated ${generatedAt} for keeper version \`${version}\`, mode **${config.mode}**.
${forkBanner}
This authorizes **bounded keeper trading only**. It does not authorize a launch, a deployment, an
issuance, a bridge transfer, an inventory refill, a public announcement or any change to the
approved launch configuration. The launch release approval is a separate digest over separate files.

### Routes and contracts

| Chain | Keeper vault | Pool | Token | Quote asset |
| --- | --- | --- | --- | --- |
${rows}

Keeper creation code \`${KEEPER_CODE.sha256}\` built with solc ${KEEPER_CODE.compiler}.

### Signing and admin powers

The operator key \`${facts[0]?.owner ?? 'unset'}\` owns both vaults. Through them it may run legs,
halt, resume, attest a remote sale and withdraw inventory. It has **no** power over the canonical
issuance, the NTT managers, the pools' liquidity positions or any holder balance: the keeper trades
only its own vault inventory and can neither mint, rebase nor redistribute. A vault's bounds are
immutable — changing one means deploying a new vault and a new approval.

### Bounds the contracts enforce

| Chain | Max tokens / leg | Max quote / leg | Session spend cap | Recovery reserve | Net drain cap | Max open cycles |
| --- | --- | --- | --- | --- | --- | --- |
${bounds}

A leg also carries its chain id, its pool address and a deadline, and the vault refuses a leg whose
id has already run. A repeat, a replay on the wrong chain and a leg planned against a stale quote all
revert on the destination chain.

### Bounds the runner enforces against the durable record

| Bound | Value |
| --- | --- |
| Minimum edge to open a cycle | ${usdc(p.minEdge)} |
| Execution buffer | ${usdc(p.buffer)} |
| Reserved recovery cost | ${usdc(p.recoveryCost)} |
| Absolute per-leg gas ceiling | ${usdc(p.maxLegCost)} |
| Session realized-loss cap | ${usdc(p.lossCap)} |
| Quote freshness | ${p.maxQuoteAgeSeconds}s and ${p.maxBlockLag} blocks behind head |
| Chain availability window | ${p.maxHeadAgeSeconds}s without a new block |
| Leg validity | ${p.legTtlSeconds}s |
| Slippage allowance | ${p.slippageBps} bps |
| Cycles open at once | ${p.maxOpenCycles} |

Worst-case gas and reserved recovery cost for one cycle at current fees: **${usdc(worstCaseCycle.toString())}**.

### Current inventory and counters

| Chain | Keeper tokens | Keeper quote | Spent | Received | Open cycles | State |
| --- | --- | --- | --- | --- | --- | --- |
${inventory}

Inventory refill and the Base-to-Arc return route are **not** part of this approval. When a chain's
inventory is exhausted the keeper stops trading that direction and says so.

### What a run does, and what it reports

Each cycle quotes both pools for the same token quantity through the vaults' own \`probe\`, buys on the
cheaper chain and sells on the dearer one, inside every bound above. Keeper profit is reported
separately from the combined pool and treasury outcome; keeper volume is not customer demand and the
keeper's own payments are not revenue.

### Verification steps

1. \`bun run scripts/equilibrium-keeper-bytecode.ts --check\` — the pinned keeper code matches a fresh build.
2. \`bun run equilibrium:keeper preview --config <file>\` — regenerates this preview and its digest from live reads.
3. \`bun run equilibrium:keeper verify --config <file>\` — both vaults are owned by the operator and bound to these pools and bounds.
   \`bun run equilibrium:keeper status --config <file>\` — nothing unresolved and nothing unfinished before a session starts.
4. \`bun run equilibrium:keeper quote --config <file> --tokens <n>\` — both pools quoted for the same quantity, with the decision and its reason.
5. \`EQUILIBRIUM_FORK=1 bun test server/equilibrium/keeper/__tests__/fork.test.ts\` — the fork rehearsal.

### Operating duration and stop conditions

One session, ended by the operator. The keeper stops on its own when: a sale leg fails (both vaults
halt and the position stays open until it is recovered), the realized-loss cap is reached, a chain is
unavailable or its quotes are stale, inventory is exhausted, or a spend cap is reached.

### Recovery and cleanup

1. \`bun run equilibrium:keeper status --config <file>\` lists two things separately: **unresolved**
   cycles, which still hold a position, and **unfinished** ones, whose trade completed but whose close
   attestation on the purchase vault never landed.
2. \`bun run equilibrium:keeper reconcile --config <file> --yes\` finishes the unfinished ones. It
   observes before it sends, costs at most one attestation transaction per cycle, and is safe to run
   again — run it first, before anything else, because an outstanding close blocks trading, resuming
   and withdrawing while nothing is actually at risk.
3. \`bun run equilibrium:keeper recover --config <file> --cycle <id>\` unwinds a position on the market
   it was bought on, inside the remaining loss budget. If the unwind would pass the cap it is refused
   and the position stays open — the cap is never relaxed to close a position.
4. \`bun run equilibrium:keeper resume --config <file>\` only succeeds once no cycle is open.
5. Preserve the keeper record (and its WAL). Restarting with the same configuration re-observes every
   planned leg before sending anything, and finishes any outstanding close.
6. To end the pilot: reconcile, halt, resolve every open cycle, then withdraw both assets from each
   vault. The vault refuses a withdrawal while a cycle is open or while it is halted.
`
}

export function keeperPreviewDigest(preview: string, configText: string): string {
  return keeperApprovalDigest(preview, configText, keeperManifest())
}
