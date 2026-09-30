/**
 * Reproducible keeper rehearsal on pinned forks of Arc testnet and Base Sepolia. Starts the forks,
 * deploys the vaults, seeds the real venues, runs one complete cycle and one deliberately halted
 * cycle with its recovery, then writes the evidence pack, the fork configuration and the keeper
 * approval preview.
 *
 *   bun run equilibrium:keeper-rehearse [--write-preview public/equilibrium-keeper-preview.md]
 *
 * Nothing here touches a public chain: every signer is an anvil development key and both RPCs are
 * loopback. Fork-only substitutions are listed in server/equilibrium/keeper/__tests__/fork.ts.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { toFile } from './config'
import { keeperForkEnvironment } from './fork'
import { createKeeper } from './keeper'
import { decide } from './policy'
import { keeperPreview, keeperPreviewDigest, vaultFacts } from './preview'
import { KeeperStore } from './store'
import { KEEPER_CODE } from './contracts'

const TOKENS = 1_000_000_000n
const argv = process.argv.slice(2)
const previewTarget = argv.includes('--write-preview') ? argv[argv.indexOf('--write-preview') + 1] : undefined

mkdirSync('output', { recursive: true })
const env = await keeperForkEnvironment()
const dir = mkdtempSync(join(process.cwd(), 'output', 'keeper-rehearsal-'))
const store = new KeeperStore(join(dir, 'keeper.sqlite'))
try {
  const keeper = createKeeper(env.config, store)
  await keeper.verify()
  const quoted = await keeper.snapshot(TOKENS)
  const decision = decide(quoted, env.config.policy)
  console.log(`Same-quantity quotes for ${TOKENS} EQL atoms: arc buy ${quoted.quotes.arc.buyCost}, base sell ${quoted.quotes.base.sellProceeds}; ${decision.reason}`)

  const closed = await keeper.runCycle(TOKENS, { id: 'rehearsal-closed' })
  const halted = await keeper.runCycle(TOKENS, { id: 'rehearsal-halted', failSell: true })
  const refusedWhileHalted = decide(await keeper.snapshot(TOKENS), env.config.policy)
  const recovered = await keeper.recover('rehearsal-halted')
  await keeper.resume()

  const configText = JSON.stringify(toFile(env.config), null, 1) + '\n'
  writeFileSync('output/equilibrium-keeper-fork.json', configText)
  const facts = await vaultFacts(env.config, keeper.clients)
  const preview = keeperPreview(env.config, facts, keeper.version, new Date().toISOString().slice(0, 19) + 'Z')
  const digest = keeperPreviewDigest(preview, configText)
  if (previewTarget) writeFileSync(previewTarget, preview)

  // Exercise the operator tool itself against the live forks, in the foreground.
  const cli = spawnSync('bun', ['run', 'server/equilibrium/keeper/cli.ts', 'quote', '--config', 'output/equilibrium-keeper-fork.json', '--tokens', TOKENS.toString()], {
    encoding: 'utf8',
    env: { ...process.env, EQUILIBRIUM_OPERATOR_KEY: env.config.operatorKey, EQUILIBRIUM_KEEPER_DB: join(dir, 'keeper.sqlite') },
  })
  if (cli.status !== 0) console.error(`equilibrium:keeper quote exited ${cli.status}: ${cli.stderr}`)

  const leg = (cycle: typeof closed, kind: string) => {
    const found = cycle.legs.find((item) => item.kind === kind)
    return found?.result ? { chain: found.chain, id: found.plan.id, ...found.result } : null
  }
  const evidence = {
    generatedAt: new Date().toISOString(),
    mode: env.config.mode,
    version: keeper.version,
    keeperCodeSha256: KEEPER_CODE.sha256,
    operator: privateKeyToAccount(env.config.operatorKey).address,
    vaults: { arc: env.config.arc.keeper, base: env.config.base.keeper },
    pools: env.pools,
    tokens: env.tokens,
    quoteAssets: env.quotes,
    policy: env.config.policy,
    sameQuantityQuote: {
      tokens: quoted.tokens,
      arc: { buyCost: quoted.quotes.arc.buyCost, sellProceeds: quoted.quotes.arc.sellProceeds, block: quoted.quotes.arc.blockNumber },
      base: { buyCost: quoted.quotes.base.buyCost, sellProceeds: quoted.quotes.base.sellProceeds, block: quoted.quotes.base.blockNumber },
      decision,
    },
    closedCycle: { state: closed.state, net: closed.net, buy: leg(closed, 'buy'), sell: leg(closed, 'sell'), candidate: closed.candidate },
    haltedCycle: { state: halted.state, note: halted.note, buy: leg(halted, 'buy'), refusedWhileHalted },
    recoveredCycle: { state: recovered.state, net: recovered.net, recover: leg(recovered, 'recover'), note: recovered.note },
    totals: store.totals(),
    approval: { digest, previewBytes: preview.length, previewWrittenTo: previewTarget ?? null },
    operatorTool: { command: 'equilibrium:keeper quote', exit: cli.status, decision: (JSON.parse(cli.stdout || '{}') as { decision?: unknown }).decision ?? null },
    quotesMatchExecution: {
      buy: leg(closed, 'buy')?.amountIn === quoted.quotes.arc.buyCost,
      sell: leg(closed, 'sell')?.amountOut === quoted.quotes.base.sellProceeds,
    },
  }
  writeFileSync('output/equilibrium-keeper-evidence.json', JSON.stringify(evidence, null, 1) + '\n')
  console.log(JSON.stringify(evidence, null, 1))
  console.error(`\nEQUILIBRIUM_KEEPER_APPROVAL for this fork configuration=${digest}`)
} finally {
  store.close()
  env.stop()
  rmSync(dir, { recursive: true, force: true })
}
