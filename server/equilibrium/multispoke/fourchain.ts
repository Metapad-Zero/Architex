/**
 * FOUR-CHAIN FORK + LOCAL-VALIDATOR HARNESS for ONE composed launch job (49TH-44): the three forks of
 * ./fork.ts (Arc testnet, Base Sepolia, Robinhood mainnet) plus a local `solana-test-validator`
 * running the pinned SVM NTT programs and the real mainnet core bridge binary. Own ports (Arc 18855,
 * Base 18856, Robinhood 18857, Solana 18899 with faucet 19000, Robinhood proxy 18858) and its own
 * journal, so it never collides with the three-chain, Arc–Solana, keeper or refill suites.
 *
 * Substitutions on top of ./fork.ts, all local:
 *
 * 1. The validator's core bridge carries one development guardian key (the pinned repository's own
 *    mainnet fixtures with the guardian set substituted, as scripts/solana/localValidator.ts does).
 * 2. The Solana quote asset is a fixture mint whose supply the operator's fee payer holds.
 * 3. Robinhood's RPC is reached through a loopback proxy the harness can close and reopen, so an
 *    unreachable spoke is exercised without losing the fork's in-memory state.
 *
 * Nothing here touches a public chain; every signer is a development key or a fresh local keypair.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { SOLANA_NTT } from '../../../src/lib/equilibriumSolana'
import { awaitConfirmed, send, startValidator, stopValidator, waitForHealth } from '../../../scripts/solana/localValidator'
import { associatedTokenAddress, createAssociatedTokenAccount, createMintAccount, initializeMint2, mintTo } from '../../../scripts/solana/splToken'
import { FOURCHAIN_LABELS, type MultispokeConfig, type Side } from './adapter'
import { configFromJson as threeChainFromJson, configToJson as threeChainToJson, multispokeForkEnvironment, type MultispokeForkEnvironment } from './fork'
import type { SolanaSpokeInfrastructure } from './solana'

export const FOURCHAIN_PORTS = { arc: 18855, base: 18856, robinhood: 18857, robinhoodProxy: 18858, solana: 18899, service: 4049 } as const
const ROOT = resolve(import.meta.dirname, '../../..')
const SVM = join(ROOT, 'lib/ntt-svm/solana')
export const SVM_DEPLOY = join(SVM, 'target/deploy')
const FIXTURES = { cwd: SVM, deploy: SVM_DEPLOY, fixtures: join(SVM, 'programs/example-native-token-transfers/tests/fixtures'), accounts: join(SVM, 'tests/accounts/mainnet') }
/** Quote fixture supply on the Solana spoke: plenty, and never counted as revenue or customer funds. */
const QUOTE_FIXTURE_SUPPLY = 1_000_000_000_000_000n

/**
 * A loopback JSON-RPC proxy in front of one fork. Closing it makes the chain unreachable to the
 * adapter (connection refused) while the fork, and everything the job already did on it, stays up.
 */
export function rpcProxy(port: number, upstream: string) {
  let server: ReturnType<typeof Bun.serve> | null = null
  const open = () => {
    if (server) return
    server = Bun.serve({ port, hostname: '127.0.0.1', fetch: async (request) => {
      const body = await request.text()
      const response = await fetch(upstream, { method: 'POST', body, headers: { 'content-type': 'application/json' } })
      return new Response(await response.text(), { status: response.status, headers: { 'content-type': 'application/json' } })
    } })
  }
  const close = () => { void server?.stop(true); server = null }
  open()
  return { url: `http://127.0.0.1:${port}`, open, close, get up() { return server !== null } }
}

export interface SolanaValidator { infrastructure: SolanaSpokeInfrastructure; process: ChildProcess }

/** Start the validator and its fixtures: the fee payer funded, the quote fixture mint held by the payer. */
export async function startSolanaSpoke(port: number, ledger: string): Promise<SolanaValidator> {
  const payer = Keypair.generate()
  const admin = Keypair.generate()
  const quote = Keypair.generate()
  const child = startValidator(FIXTURES, ledger, { rpc: port, faucet: port + 101 }, true, admin.publicKey)
  const connection = new Connection(`http://127.0.0.1:${port}`, 'confirmed')
  try {
    await waitForHealth(connection)
    await awaitConfirmed(connection, await connection.requestAirdrop(payer.publicKey, 500_000_000_000))
    await send(connection, payer, [await createMintAccount(connection, payer.publicKey, quote.publicKey), initializeMint2(quote.publicKey, SOLANA_NTT.decimals, payer.publicKey),
      createAssociatedTokenAccount(payer.publicKey, payer.publicKey, quote.publicKey)], [quote])
    await send(connection, payer, [mintTo(quote.publicKey, associatedTokenAddress(quote.publicKey, payer.publicKey), payer.publicKey, QUOTE_FIXTURE_SUPPLY)])
  } catch (cause) { stopValidator(child, 'SIGKILL'); throw cause }
  return { infrastructure: { connection, rpcPort: port, ledger, payer, admin, quoteMint: quote.publicKey }, process: child }
}

/**
 * Restart the validator: in place by default (same ledger), or at a new genesis seeded from a dump when
 * the clock has to move. The new client is written back onto the infrastructure record the adapter reads.
 */
export async function restartSolanaSpoke(v: SolanaValidator, options: { seedDirectory?: string; ledger?: string; environment?: Record<string, string>; fund?: Keypair[] } = {}): Promise<void> {
  if (options.seedDirectory && !options.ledger) throw new Error('A seeded rebuild needs its own ledger directory.')
  stopValidator(v.process, 'SIGKILL')
  await new Promise((done) => setTimeout(done, 3_000))
  const ledger = options.ledger ?? v.infrastructure.ledger
  v.process = startValidator(FIXTURES, ledger, { rpc: v.infrastructure.rpcPort, faucet: v.infrastructure.rpcPort + 101 }, options.seedDirectory !== undefined, v.infrastructure.admin.publicKey,
    { seedDirectory: options.seedDirectory, environment: options.environment })
  v.infrastructure.ledger = ledger
  v.infrastructure.connection = new Connection(`http://127.0.0.1:${v.infrastructure.rpcPort}`, 'confirmed')
  await waitForHealth(v.infrastructure.connection)
  for (const account of options.fund ?? []) await awaitConfirmed(v.infrastructure.connection, await v.infrastructure.connection.requestAirdrop(account.publicKey, 500_000_000_000))
}

export interface FourChainEnvironment extends Omit<MultispokeForkEnvironment, 'config'> {
  config: MultispokeConfig
  solana: SolanaValidator
  robinhoodProxy: ReturnType<typeof rpcProxy>
}

/**
 * Bring all four chains up. `solanaInboundLimit` below the Solana allocation makes the pinned spoke
 * manager hold this launch's delivery as a queued claim, which is how the delayed-spoke case is built.
 */
export async function fourChainEnvironment(options: { solanaInboundLimit?: bigint; payerUsdc?: bigint } = {}): Promise<FourChainEnvironment> {
  const out = join(ROOT, 'output/equilibrium')
  mkdirSync(out, { recursive: true })
  const env = await multispokeForkEnvironment({ ports: { arc: FOURCHAIN_PORTS.arc, base: FOURCHAIN_PORTS.base, robinhood: FOURCHAIN_PORTS.robinhood }, payerUsdc: options.payerUsdc })
  let solana: SolanaValidator | undefined
  let proxy: ReturnType<typeof rpcProxy> | undefined
  try {
    proxy = rpcProxy(FOURCHAIN_PORTS.robinhoodProxy, env.urls.robinhood)
    solana = await startSolanaSpoke(FOURCHAIN_PORTS.solana, mkdtempSync(join(out, 'fourchain-ledger-')))
    const config: MultispokeConfig = {
      ...env.config, labels: FOURCHAIN_LABELS,
      spokes: { ...env.config.spokes, robinhood: { ...env.config.spokes.robinhood, rpc: proxy.url } },
      solana: { infrastructure: solana.infrastructure, inboundLimit: options.solanaInboundLimit },
    }
    const stop = () => { env.stop(); proxy?.close(); stopValidator(solana?.process ?? null, 'SIGKILL') }
    return { ...env, config, solana, robinhoodProxy: proxy, stop }
  } catch (cause) {
    env.stop(); proxy?.close(); stopValidator(solana?.process ?? null, 'SIGKILL')
    throw cause
  }
}

/** The on-disk form a worker process loads. Every key in it is a local development or fresh fixture key. */
export function configToJson(config: MultispokeConfig, guardianSets: Record<Side, number>): string {
  const s = config.solana!
  const three = JSON.parse(threeChainToJson({ ...config, solana: undefined }, guardianSets)) as Record<string, unknown>
  return JSON.stringify({ ...three, solana: { rpcPort: s.infrastructure.rpcPort, ledger: s.infrastructure.ledger, inboundLimit: s.inboundLimit?.toString() ?? null,
    payer: Buffer.from(s.infrastructure.payer.secretKey).toString('base64'), admin: Buffer.from(s.infrastructure.admin.secretKey).toString('base64'), quoteMint: s.infrastructure.quoteMint.toBase58() } })
}
export function configFromJson(json: string): MultispokeConfig {
  const raw = JSON.parse(json) as { solana: { rpcPort: number; ledger: string; inboundLimit: string | null; payer: string; admin: string; quoteMint: string } }
  const config = threeChainFromJson(json)
  const s = raw.solana
  const key = (secret: string) => Keypair.fromSecretKey(Buffer.from(secret, 'base64'))
  return { ...config, solana: { inboundLimit: s.inboundLimit === null ? undefined : BigInt(s.inboundLimit),
    infrastructure: { connection: new Connection(`http://127.0.0.1:${s.rpcPort}`, 'confirmed'), rpcPort: s.rpcPort, ledger: s.ledger, payer: key(s.payer), admin: key(s.admin), quoteMint: new PublicKey(s.quoteMint) } } }
}
