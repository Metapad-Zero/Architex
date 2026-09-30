/**
 * The keeper operator tool. Read-only by default; the two commands that send anything say so.
 *
 *   bun run equilibrium:keeper verify   --config deployments/equilibrium-keeper-fork.json
 *   bun run equilibrium:keeper quote    --config <file> --tokens 25000000
 *   bun run equilibrium:keeper status   --config <file>
 *   bun run equilibrium:keeper preview  --config <file> [--write public/equilibrium-keeper-preview.md]
 *   bun run equilibrium:keeper run      --config <file> --tokens 25000000 [--ticks 1] [--interval-ms 15000] --yes
 *   bun run equilibrium:keeper recover  --config <file> --cycle <id> --yes
 *   bun run equilibrium:keeper resume   --config <file> --yes
 *
 * EQUILIBRIUM_OPERATOR_KEY signs. EQUILIBRIUM_KEEPER_DB names the durable record. In testnet mode
 * EQUILIBRIUM_KEEPER_APPROVAL must equal the digest this tool's `preview` prints.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { assertKeeperApproved } from './approval'
import { fromFile, type KeeperFileConfig } from './config'
import { createKeeper } from './keeper'
import { keeperPreview, keeperPreviewDigest, vaultFacts } from './preview'
import { KeeperStore } from './store'
import { session } from './run'
import { decide } from './policy'

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const present = (name: string) => argv.includes(`--${name}`)
const PREVIEW_PATH = process.env.EQUILIBRIUM_KEEPER_PREVIEW ?? './public/equilibrium-keeper-preview.md'
const say = (value: unknown) => console.log(JSON.stringify(value, null, 2))

const configPath = flag('config')
if (!command || !configPath) {
  console.error('Usage: equilibrium:keeper <verify|quote|status|preview|run|recover|resume> --config <file> [...]')
  process.exit(2)
}
const configText = readFileSync(configPath, 'utf8')
const file = JSON.parse(configText) as KeeperFileConfig
const config = fromFile(file)
const store = new KeeperStore(process.env.EQUILIBRIUM_KEEPER_DB ?? './output/equilibrium/keeper.sqlite', { allowEphemeral: config.mode === 'fork' })
const keeper = createKeeper(config, store)
const tokensFlag = () => {
  const raw = flag('tokens')
  if (!raw || !/^\d+$/.test(raw) || BigInt(raw) === 0n) throw new Error('--tokens must be a positive whole number of token atoms.')
  return BigInt(raw)
}
/** Every command that sends a transaction is gated on --yes and, off a fork, on the approval digest. */
function assertMaySend() {
  if (!present('yes')) throw new Error('This command sends transactions. Re-run it with --yes.')
  assertKeeperApproved(config.mode, readFileSync(PREVIEW_PATH, 'utf8'), configText, config.approval, [config.arc.rpc, config.base.rpc])
}

try {
  if (command === 'verify') {
    await keeper.verify()
    say({ ok: true, version: keeper.version, manifest: keeper.manifest })
  } else if (command === 'quote') {
    await keeper.verify()
    const snapshot = await keeper.snapshot(tokensFlag())
    say({ version: keeper.version, snapshot, decision: decide(snapshot, config.policy) })
  } else if (command === 'status') {
    say({
      version: keeper.version, totals: store.totals(),
      unresolved: store.unresolved().map((cycle) => ({ id: cycle.id, state: cycle.state, note: cycle.note, legs: cycle.legs.map((leg) => ({ kind: leg.kind, chain: leg.chain, state: leg.state, result: leg.result })) })),
      cycles: store.list(20).map((cycle) => ({ id: cycle.id, state: cycle.state, net: cycle.net, candidate: cycle.candidate, note: cycle.note })),
    })
  } else if (command === 'preview') {
    await keeper.verify()
    const facts = await vaultFacts(config, keeper.clients)
    const preview = keeperPreview(config, facts, keeper.version, new Date().toISOString().slice(0, 19) + 'Z')
    const target = flag('write')
    if (target) writeFileSync(target, preview)
    console.log(preview)
    console.error(`\nEQUILIBRIUM_KEEPER_APPROVAL=${keeperPreviewDigest(preview, configText)}`)
  } else if (command === 'run') {
    assertMaySend()
    await keeper.verify()
    const result = await session(keeper, store, tokensFlag(), {
      maxTicks: Number(flag('ticks') ?? '1'), idleTicks: Number(flag('idle-ticks') ?? '1'),
      intervalMs: Number(flag('interval-ms') ?? '0'),
      onTick: (outcome) => console.error(`tick ${outcome.at}: ${outcome.cycle ? `cycle ${outcome.cycle.id} ${outcome.cycle.state} net ${outcome.cycle.net}` : outcome.decision?.detail ?? 'reconciled'}`),
    })
    say(result)
    if (result.stopped) process.exitCode = 1
  } else if (command === 'recover') {
    assertMaySend()
    const cycle = flag('cycle')
    if (!cycle) throw new Error('--cycle names the cycle to unwind.')
    say(await keeper.recover(cycle))
  } else if (command === 'resume') {
    assertMaySend()
    await keeper.resume()
    say({ ok: true, unresolved: store.unresolved().map((c) => c.id) })
  } else {
    throw new Error(`Unknown command ${command}.`)
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
} finally {
  store.close()
}
