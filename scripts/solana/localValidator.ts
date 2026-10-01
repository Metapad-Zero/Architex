/**
 * Local `solana-test-validator` plumbing for the Arc–Solana integration rehearsal: lifecycle,
 * HTTP-only transaction submission, refusal recording and posting a signed VAA.
 *
 * This is a sibling of the equivalent helpers inside `scripts/solana/rehearse.ts` rather than a
 * refactor of them. The spoke rehearsal is under review on its own branch; extracting its internals
 * would rewrite a file someone else is reading. The duplication is deliberate and bounded, and the
 * two scripts run on different ports against different ledgers.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  Connection, Keypair, PublicKey, SendTransactionError, SYSVAR_CLOCK_PUBKEY, Transaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { SOLANA_NTT, toHex, type VaaBody } from '../../src/lib/equilibriumSolana'
import { NttDeployment } from './nttClient'
import {
  DEV_GUARDIAN_ADDRESS, postVaaInstruction, secp256k1Instruction, serializeVaa, signVaa,
  verifySignaturesInstruction,
} from './wormholeCore'

export interface ValidatorPorts { rpc: number; faucet: number }

export interface ValidatorFixtures {
  /** `lib/ntt-svm/solana/programs/example-native-token-transfers/tests/fixtures` */
  fixtures: string
  /** `lib/ntt-svm/solana/tests/accounts/mainnet` */
  accounts: string
  /** `lib/ntt-svm/solana/target/deploy` */
  deploy: string
  cwd: string
}

/**
 * The actual mainnet core bridge binary with mainnet's config, fee collector and guardian set
 * account; guardian set 0 carries the single development key both halves of this rehearsal sign
 * with. The two NTT programs are loaded upgradeable because the manager checks its deployer
 * against the program's upgrade authority.
 */
export interface ValidatorOptions {
  /**
   * A directory of `solana account --output json` files to rebuild the ledger from, in place of the
   * three mainnet core-bridge fixtures. Only meaningful with `reset`: `--account-dir` is ignored
   * when the ledger already exists. The dump carries the current state of those three accounts —
   * including the substituted guardian set — so loading both sources would be two answers to the
   * same question.
   */
  seedDirectory?: string
  /**
   * Extra environment for the validator process only. This is how the clock fixture is applied;
   * see `scripts/solana/clockShift.ts`. It reaches the child and nothing else, so the harness
   * keeps stamping its own records with the real date.
   */
  environment?: Record<string, string>
}

export function startValidator(
  at: ValidatorFixtures, ledger: string, ports: ValidatorPorts, reset: boolean, admin: PublicKey,
  options: ValidatorOptions = {},
): ChildProcess {
  const accounts = options.seedDirectory
    ? ['--account-dir', options.seedDirectory]
    : [
      '--account', '2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn', join(at.accounts, 'core_bridge_config.json'),
      '--account', '9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy', join(at.accounts, 'core_bridge_fee_collector.json'),
      '--account', 'DS7qfSAgYsonPpKoAjcGhX9VFjXdGkiHjEDkTidf8H2P', join(at.accounts, 'guardian_set_0.json'),
    ]
  if (options.seedDirectory && !reset) {
    throw new Error('A seeded ledger has to be a new one: solana-test-validator ignores --account-dir when the ledger exists.')
  }
  const args = [
    '--ledger', ledger, '--rpc-port', String(ports.rpc), '--faucet-port', String(ports.faucet),
    '--limit-ledger-size', '10000', '--quiet',
    ...(reset ? ['--reset'] : []),
    '--bpf-program', SOLANA_NTT.coreBridge, join(at.fixtures, 'mainnet_core_bridge.so'),
    ...accounts,
    '--upgradeable-program', SOLANA_NTT.manager, join(at.deploy, 'example_native_token_transfers.so'), admin.toBase58(),
    '--upgradeable-program', SOLANA_NTT.transceiver, join(at.deploy, 'ntt_transceiver.so'), admin.toBase58(),
  ]
  // Spawned directly, never through a wrapper. nohup, env and setsid are all SIP-protected on
  // macOS, and exec'ing one of them strips DYLD_INSERT_LIBRARIES out of the environment on the way
  // past — the clock fixture would be silently absent and the release it exists for would be
  // refused for a reason that looks like a defect in the manager.
  const child = spawn('solana-test-validator', args, {
    cwd: at.cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...options.environment },
  })
  child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(`    [validator] ${chunk.toString()}`) })
  return child
}

/** The Clock sysvar's own `unix_timestamp`, which is what the manager's queue compares against. */
export async function readChainClock(connection: Connection): Promise<bigint> {
  const account = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed')
  if (!account) throw new Error('The Clock sysvar is missing from this ledger.')
  return new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength).getBigInt64(32, true)
}

/** Cancels only the process this run started, by its own pid. */
export function stopValidator(child: ChildProcess | null, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child?.pid) return
  try { process.kill(child.pid, signal) } catch { /* already gone */ }
}

export async function waitForHealth(connection: Connection, seconds = 120): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    try {
      if (await connection.getSlot('confirmed') > 0) return
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('The local validator did not become healthy.')
    await new Promise((done) => setTimeout(done, 500))
  }
}

/**
 * A hard kill can only be survived by state the validator has already rooted, so wait for finality
 * before pulling the plug. Killing mid-confirmation would test the validator's snapshot cadence
 * rather than the manager's recovery.
 */
export async function awaitFinalized(connection: Connection, signature: string, seconds = 120): Promise<void> {
  await awaitStatus(connection, signature, (status) => status === 'finalized', seconds, 'finalize')
}
export async function awaitConfirmed(connection: Connection, signature: string, seconds = 90): Promise<void> {
  await awaitStatus(connection, signature, (status) => status !== null, seconds, 'confirm')
}
async function awaitStatus(
  connection: Connection, signature: string,
  done: (status: string | null) => boolean, seconds: number, what: string,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true })
    if (done(status.value?.confirmationStatus ?? null)) return
    if (Date.now() > deadline) throw new Error(`Transaction ${signature} did not ${what} on the local validator.`)
    await new Promise((wait) => setTimeout(wait, 400))
  }
}

/**
 * Sends and confirms over HTTP only. `sendAndConfirmTransaction` opens a signature subscription,
 * and this run deliberately kills the validator underneath its client; polling keeps the restart
 * from leaving a websocket reconnecting for the rest of the run.
 */
export async function send(
  connection: Connection, payer: Keypair, instructions: TransactionInstruction[], signers: Keypair[] = [],
): Promise<string> {
  const transaction = new Transaction().add(...instructions)
  const latest = await connection.getLatestBlockhash('confirmed')
  transaction.recentBlockhash = latest.blockhash
  transaction.feePayer = payer.publicKey
  transaction.sign(payer, ...signers)
  // Preflight first: a rejection surfaces the program's own logs instead of an expiry timeout.
  const simulated = await connection.simulateTransaction(transaction)
  if (simulated.value.err) {
    throw new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage: `Simulation failed: ${JSON.stringify(simulated.value.err)}`,
      logs: simulated.value.logs ?? [],
    })
  }
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 })
  const deadline = Date.now() + 90_000
  for (;;) {
    const status = await connection.getSignatureStatus(signature, { searchTransactionHistory: true })
    if (status.value?.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.value.err)}`)
    const level = status.value?.confirmationStatus
    if (level === 'confirmed' || level === 'finalized') return signature
    if (Date.now() > deadline) throw new Error(`Transaction ${signature} was not confirmed.`)
    await new Promise((wait) => setTimeout(wait, 300))
  }
}

/**
 * Records the on-chain refusal rather than swallowing it, so the evidence names the constraint that
 * held. Not every refusal is an NTT error number: re-validating an already-delivered VAA is refused
 * by the runtime with `Allocate ... already in use`, because the validated-message account is a PDA
 * of the message id and already exists. Weaker-looking line, same guarantee.
 */
export function refusalReason(error: unknown): string {
  const logs = error instanceof SendTransactionError ? error.logs ?? [] : []
  const named = logs.find((line) => /Error Code:|Error Message:|already in use|custom program error/i.test(line))
  const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
  return (named ?? message).trim().slice(0, 200)
}

/** Posts a signed VAA through the core bridge: verify the signature, then write the account. */
export async function postVaa(
  connection: Connection, payer: Keypair, deployment: NttDeployment, body: VaaBody,
): Promise<{ posted: PublicKey; vaa: string }> {
  const signed = signVaa(body)
  const signatureSet = Keypair.generate()
  const guardianSet = deployment.at.guardianSet(0)
  await send(connection, payer, [
    secp256k1Instruction(signed, DEV_GUARDIAN_ADDRESS),
    verifySignaturesInstruction(deployment.coreBridge, payer.publicKey, guardianSet, signatureSet.publicKey),
  ], [signatureSet])
  const posted = deployment.at.postedVaa(signed.hash)
  await send(connection, payer, [
    postVaaInstruction(
      deployment.coreBridge, payer.publicKey, guardianSet, deployment.at.coreBridgeConfig,
      signatureSet.publicKey, posted, body,
    ),
  ])
  return { posted, vaa: toHex(serializeVaa(signed)) }
}
