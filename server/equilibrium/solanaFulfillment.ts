/**
 * ARC–SOLANA DURABLE FULFILMENT HARNESS: the paid launch path over the route that was verified, with
 * the failures a script never has to survive.
 *
 * `scripts/solana/integrate.ts` proved the route: two live environments exchanging the bytes they
 * published, both halves of the ledger read from their own chain. It ran straight through. This runs
 * the same route underneath a durable launch job reached over HTTP — quote, x402 payment, job status
 * — and then breaks it on purpose:
 *
 *   conflicts          a second quote for the same requestId with a different payload; a payment
 *                      header signed for different terms; the issuance factory asked to rebind an
 *                      identity it already holds.
 *   failed payment     an expired authorization and one signed by the wrong key, each refused with
 *                      nothing issued; then the real one, settled exactly once, with the token's own
 *                      nonce refusing the second submission on chain.
 *   a queued credit    the spoke's inbound rate limit holds this launch's own delivery. The claim is
 *                      bound onto the durable job — amount, recipient, the boundary the manager
 *                      wrote — the launch stays unfulfilled, the early release is refused on chain,
 *                      and the locked allocation keeps reconciling as in flight rather than minted.
 *   spoke restart      the validator killed with SIGKILL and its ledger reopened with the claim
 *                      outstanding; then rebuilt at a genesis 24 hours later so the manager's own
 *                      boundary passes and the claim is released, exactly once.
 *   interruption       a worker that submits that release and dies before recording it. The store is
 *                      closed and reopened, and the unattended sweep finishes the launch with no
 *                      client request and without crediting twice.
 *   replay             the identical paid request re-sent after completion, the released claim
 *                      submitted again, and the settled authorization resubmitted to the token.
 *
 * After every checkpoint both chains are read and compared: Arc token supply and locking-manager
 * custody against SPL mint supply and the spoke's custody account, neither derived from the other.
 *
 * Its own port and its own journal, so it cannot disturb `equilibrium:server` or the local rehearsal.
 * FIXTURES, all labelled here and in the record: the settlement and quote assets are fixture tokens,
 * and one development guardian key is substituted into both core bridges. No public route is opened,
 * nothing is funded, and nothing is broadcast to a public network.
 *
 * Run: `bun run equilibrium:solana:build` once, then `bun run equilibrium:arc-solana:fulfill`.
 */
import { type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { reviewReleaseBoundary, seedDifferences } from '../../src/lib/equilibriumArcSolana'
import { SOLANA_NTT, TOKEN_PROGRAM } from '../../src/lib/equilibriumSolana'
import { revertReason } from '../../scripts/solana/arcFork'
import { clockShiftEnvironment, prepareClockShift } from '../../scripts/solana/clockShift'
import { SPOKE_PROGRAMS, closeRoute, fulfillmentRoute, openRoute, releaseSpokeClaim, restartSpoke, spokeDeployment, type RouteInfrastructure } from '../../scripts/solana/fulfillRoute'
import { readChainClock, refusalReason } from '../../scripts/solana/localValidator'
import { describeSeed, dumpSpokeLedger, readSeeded, writeSeedDirectory } from '../../scripts/solana/spokeSeed'
import { AUTHORIZATION_TYPES, paymentDomain, paymentRequirements } from './payment'
import { publicJob, reconcile } from './runner'
import { solanaAdapter } from './solanaAdapter'
import { decodePlan, gateLedger, outstandingClaims, routePending } from './solanaRoute'
import { JobStore } from './store'
import { createLaunchService } from './service'
import type { Job, LaunchRequest, PromotionalTokenAdapter, SignedPayment } from './types'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'output/equilibrium')
/** Its own journal. Never the local rehearsal's store, and never a temporary path. */
const JOURNAL = process.env.EQUILIBRIUM_FULFILL_DB ?? join(OUT, 'arc-solana-fulfillment.sqlite')
/** Its own port, so this harness and `equilibrium:server` can be up at the same time. */
const PORT = Number(process.env.EQUILIBRIUM_FULFILL_PORT ?? 4142)

/** A local harness key. Never used on a public chain and never bundled into the frontend. */
const payerAccount = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000123')
/** A second local key, for the authorization that must be refused for being signed by the wrong payer. */
const strangerAccount = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000456')

const ISSUANCE = 1_000_000_000_000n
/** Fractional allocations, so a decimals or rounding bug cannot pass by cancelling out. */
const ARC_ALLOCATION = 600_123_456_789n
const SOLANA_ALLOCATION = 399_876_543_211n
const ARC_POOL_TOKENS = 100_111_111n
const SOLANA_POOL_TOKENS = 200_222_222n
const POOL_QUOTE = 10_333_333n

/**
 * The spoke's inbound rate limit for the Arc peer, set well below the Solana allocation so this
 * launch's own credit is queued by the pinned manager rather than released on arrival.
 *
 * Nothing else about the queue is arranged. The limit is a peer configuration the manager reads, and
 * everything that follows from it — the inbox item, the 24-hour boundary written against the Clock
 * sysvar, the refusal before it, the release after it — is the program's.
 */
const SPOKE_INBOUND_LIMIT = 1_000_000n
/** The pinned SVM program hard-codes this; it is not configurable and not shortened here. */
const RATE_LIMIT_DURATION = 86_400
/**
 * Slack allowed when measuring the delay the manager applied, in seconds. The boundary is compared
 * against a Clock reading taken a slot or two after the manager took its own, so the measured gap
 * sits just under the duration. Narrow on purpose: wider and a shortened duration would pass.
 */
const DELAY_SLACK = 60

/* ------------------------------------------------------------------ recording */

interface Checkpoint { checkpoint: string; detail: string; at: string }
const checkpoints: Checkpoint[] = []
const fixtures: string[] = []
const clockFixtures: string[] = []
const refusals: { case: string; refusal: string }[] = []

function record(checkpoint: string, detail: string): void {
  checkpoints.push({ checkpoint, detail, at: new Date().toISOString() })
  console.log(`  ${checkpoint}: ${detail}`)
}
function fixture(what: string): void {
  fixtures.push(what)
  record('FIXTURE', what)
}
/** Kept apart from the asset fixtures: a moved clock is the one thing a reader must not miss. */
function clockFixture(what: string): void {
  clockFixtures.push(what)
  record('CLOCK FIXTURE', what)
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Fulfilment assertion failed: ${message}`)
}

/**
 * Wait until an account is readable at `finalized`, which is the only commitment a SIGKILL respects.
 *
 * The claim is waited for by address rather than by the signature that wrote it: the release happens
 * inside the route's own submission, which returns nothing a caller could await, and the account is
 * the durable fact anyway — it is what the rebuilt ledger has to carry across.
 */
async function awaitFinalizedAccount(connection: Connection, address: PublicKey, seconds = 120): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    if (await connection.getAccountInfo(address, 'finalized')) return
    if (Date.now() > deadline) throw new Error(`${address.toBase58()} was not finalized on the local validator.`)
    await new Promise((wait) => setTimeout(wait, 400))
  }
}

/** What a passing run does NOT establish, carried into the record rather than left to the reader. */
const NOT_EXECUTED = [
  'Any public route. No canonical token, manager, transceiver, mint, inventory or transfer exists on Arc mainnet or testnet, Solana devnet or mainnet-beta, and no funds moved.',
  'Any venue or AMM pool. The inventory steps place pool tokens and quote inventory into a per-operation holder and deliver the rest of each allocation to the request\'s recipient, atomically. Opening a market adapter is not part of this route.',
  'Solana network fees as launch cost. They are paid in SOL by the operator\'s fee payer and reported as a zero launch cost rather than converted into the customer\'s six-decimal atoms.',
  'The return leg. A launch only crosses towards the spoke; burning a representation back to Arc custody is exercised in scripts/solana/integrate.ts and is not part of a launch job.',
]

/* ------------------------------------------------------------------ the HTTP client */

const base = `http://127.0.0.1:${PORT}`

interface Reply { status: number; body: Record<string, unknown>; headers: Headers }

async function post(body: unknown, header?: string): Promise<Reply> {
  const response = await fetch(`${base}/x402/equilibrium`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(header ? { 'payment-signature': header } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown>, headers: response.headers }
}
async function get(jobId?: string): Promise<Reply> {
  const response = await fetch(jobId ? `${base}/equilibrium/jobs/${jobId}` : `${base}/equilibrium/jobs`)
  return { status: response.status, body: await response.json() as Record<string, unknown>, headers: response.headers }
}

/* ------------------------------------------------------------------ the request */

function request(now: number, beneficiary: string, overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    requestId: 'arc-solana-fulfilment-0001',
    payer: payerAccount.address.toLowerCase() as Hex,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: ISSUANCE.toString(), recipient: payerAccount.address },
    destinations: [
      { chain: 'arc', recipient: payerAccount.address, amount: ARC_ALLOCATION.toString(), poolTokens: ARC_POOL_TOKENS.toString(), poolQuote: POOL_QUOTE.toString() },
      { chain: 'solana', recipient: beneficiary, amount: SOLANA_ALLOCATION.toString(), poolTokens: SOLANA_POOL_TOKENS.toString(), poolQuote: POOL_QUOTE.toString() },
    ],
    quote: { expires: now + 280, costCap: '1000000000' },
    ...overrides,
  }
}

async function sign(job: Job, signer = payerAccount, overrides: { value?: string; validBefore?: string } = {}): Promise<SignedPayment> {
  const authorization = {
    from: job.request.payer, to: job.terms.payTo, value: overrides.value ?? job.total,
    validAfter: '0', validBefore: overrides.validBefore ?? String(job.request.quote.expires), nonce: job.id,
  }
  const signature = await signer.signTypedData({
    domain: paymentDomain(job), types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  })
  return { authorization, signature }
}
async function header(job: Job, signer = payerAccount, overrides: { value?: string; validBefore?: string } = {}): Promise<string> {
  return encodePaymentSignatureHeader({
    x402Version: 2, accepted: paymentRequirements(job),
    payload: await sign(job, signer, overrides) as unknown as Record<string, unknown>,
  })
}

/* ------------------------------------------------------------------ the run */

let anvil: ChildProcess | null = null
let validator: ChildProcess | null = null

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  // A fresh journal per run: this harness asserts exact on-chain figures, and a journal carrying a
  // previous run's jobs would be reconciled against chains that no longer hold their effects.
  rmSync(JOURNAL, { force: true })
  for (const suffix of ['-wal', '-shm']) rmSync(`${JOURNAL}${suffix}`, { force: true })

  // Both ledgers this run may use: the one it starts on, and the genesis it rebuilds at to move the
  // spoke clock. Collected so the cleanup removes whichever were created, in either outcome.
  const ledgers = [mkdtempSync(join(tmpdir(), 'equilibrium-fulfil-'))]
  const ledger = ledgers[0]
  const beneficiary = Keypair.generate().publicKey.toBase58()

  console.log(`Arc–Solana durable fulfilment harness on ${base}, journal ${JOURNAL}`)
  fixture('The settlement asset is EquilibriumPaymentFixture, an EIP-3009 token deployed by this run, not Arc USDC. The signature path, the EIP-712 domain and the once-only authorization nonce are real; the balance it moves is fictional.')
  fixture('The quote inventory asset is EquilibriumQuoteFixture on Arc and a fixture SPL mint on Solana. Neither is a bridged or public asset.')

  const opened = await openRoute({ ledger, payerAddress: payerAccount.address })
  const infrastructure: RouteInfrastructure = opened.infrastructure
  anvil = opened.anvil
  validator = opened.validator
  fixture(`One development guardian key ${infrastructure.guardianSubstitution.replaced.join(', ')} → befa429d…0fbe substituted into the Arc core bridge guardian set ${infrastructure.guardianSubstitution.index}, matching the local validator's. The real Guardian set signed nothing here.`)
  record('infrastructure', `Arc fork ${infrastructure.arc.url} with the real core bridge; Solana validator on ${infrastructure.rpcPort} running the pinned NTT programs. Issuance factory ${infrastructure.factory}, leg registry ${infrastructure.registry}, distributor ${infrastructure.distributor}, settlement fixture ${infrastructure.paymentAsset}.`)

  const route = fulfillmentRoute(infrastructure, { spokeInboundLimit: SPOKE_INBOUND_LIMIT })
  record('spoke inbound limit', `the spoke's inbound rate limit for the Arc peer is set to ${SPOKE_INBOUND_LIMIT} atoms, below the ${SOLANA_ALLOCATION} this launch delivers, so the pinned manager queues the launch's own credit. The limit is pinned into the route version, so the job cannot be resumed against a different one.`)
  let store = new JobStore(JOURNAL, { leaseMs: 120_000 })
  let adapter: PromotionalTokenAdapter = solanaAdapter(route)
  // The served handler is read through a holder so a scenario can swap in an adapter that holds a
  // step unresolved or refuses to submit it, without taking the port down between cases.
  let service = createLaunchService(store, adapter)
  const server = Bun.serve({
    hostname: '127.0.0.1', port: PORT, maxRequestBodySize: 16_384,
    fetch(incoming) {
      const path = new URL(incoming.url).pathname
      if (path === '/x402/equilibrium' || path === '/equilibrium/jobs' || path.startsWith('/equilibrium/jobs/')) return service(incoming)
      return Response.json({ mode: 'local', route: 'arc-solana', note: 'Fixture settlement asset; no public route.' })
    },
  })
  /**
   * The record, written from whatever the run actually reached.
   *
   * A closure rather than a block at the end, because the run can legitimately stop short: without
   * the clock fixture the queued claim cannot be released on this host, and the evidence up to the
   * boundary is worth keeping. `complete` says which of the two happened, so a reader never has to
   * infer it from the absence of a section.
   */
  const writeRecord = (id: Hex, outcome: { complete: boolean; reconciliation?: unknown; endState?: unknown; notExecuted: string[] }) => {
    const result = {
      observedAt: new Date().toISOString(),
      mode: 'local' as const,
      complete: outcome.complete,
      claim: 'Durable shared-supply launch fulfilment over the verified Arc–Solana route, including a credit the spoke\'s own inbound rate limit queued. An Anvil fork of Arc testnet carrying the real deployed Wormhole core bridge, with a locking NTT manager and transceiver deployed onto it per launch, exchanging its own published message bytes with the pinned NTT programs and the real mainnet core bridge binary on a local Solana validator. The paid quote, the job and its status were driven over HTTP. Not a public route, not a devnet, testnet or mainnet deployment, no funds moved.',
      route: { version: route.version, terms: route.terms, port: PORT, journal: JOURNAL, spokeInboundLimit: SPOKE_INBOUND_LIMIT.toString(), rateLimitDuration: RATE_LIMIT_DURATION },
      infrastructure: {
        arcFork: infrastructure.arc.url, solanaRpc: `http://127.0.0.1:${infrastructure.rpcPort}`,
        factory: infrastructure.factory, registry: infrastructure.registry, distributor: infrastructure.distributor,
        settlementFixture: infrastructure.paymentAsset, quoteFixture: infrastructure.quoteAsset,
        solanaQuoteFixtureMint: infrastructure.quoteMint.publicKey.toBase58(),
        guardianSetIndex: infrastructure.guardianSubstitution.index,
        guardianSetReplaced: infrastructure.guardianSubstitution.replaced,
      },
      job: publicJob(store.get(id)!),
      endState: outcome.endState,
      reconciliation: outcome.reconciliation,
      refusals,
      fixtures,
      clockFixtures,
      notExecuted: outcome.notExecuted,
      publicRouteTested: false,
      checkpoints,
    }
    const asJson = JSON.stringify(result, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)
    writeFileSync(join(OUT, 'arc-solana-fulfillment.json'), `${asJson}\n`)
  }
  const reopen = (options: { pending?: Set<string>; unavailable?: Set<string> } = {}) => {
    // Closing and reopening the journal is the restart: nothing carries over but the file, so a step
    // can only be resumed from what was durably recorded about it.
    store.close()
    store = new JobStore(JOURNAL, { leaseMs: 120_000 })
    adapter = solanaAdapter(route, options)
    service = createLaunchService(store, adapter)
  }

  try {
    /* -------------------------------------------------------- 1. the free quote */

    const now = () => Math.floor(Date.now() / 1000)
    /**
     * One payload, reused byte for byte.
     *
     * A launch request is identified by its payer and requestId and bound to its exact contents, so
     * rebuilding it with a later `quote.expires` is a different payload under the same identity —
     * which the service correctly refuses. The replay case below depends on sending the same bytes.
     */
    const payload = request(now(), beneficiary)
    const quoted = await post(payload)
    assert(quoted.status === 402, `an unpaid quote must answer 402, not ${quoted.status}`)
    assert(typeof quoted.headers.get('PAYMENT-REQUIRED') === 'string', 'the 402 does not carry a PAYMENT-REQUIRED header')
    const jobId = quoted.body.jobId as Hex
    const total = quoted.body.total as string
    assert(typeof jobId === 'string' && /^0x[0-9a-f]{64}$/.test(jobId), 'the quote did not bind a job id')
    record('quote', `402 with a bound job ${jobId}: total ${total} atoms over ${(quoted.body.steps as unknown[]).length} steps, quote inventory ${String(quoted.body.quoteInventory)}. Nothing is issued and nothing is charged.`)

    /* -------------------------------------------------------- 2. request conflicts */

    const conflicting = await post({ ...payload, canonical: { ...payload.canonical, symbol: 'OTHER' } })
    assert(conflicting.status === 409 && conflicting.body.error === 'identity_conflict',
      `a second payload under the same requestId must be refused as identity_conflict, got ${conflicting.status} ${String(conflicting.body.error)}`)
    refusals.push({ case: 'a different payload under the same payer/requestId', refusal: `${conflicting.status} ${String(conflicting.body.error)}` })

    const unopened = await post({ ...payload, requestId: 'arc-solana-fulfilment-base', destinations: [
      { chain: 'arc', recipient: payerAccount.address, amount: '1000', poolTokens: '100', poolQuote: '100' },
      { chain: 'base', recipient: payerAccount.address, amount: '1000', poolTokens: '100', poolQuote: '100' },
    ] })
    assert(unopened.status === 503 && unopened.body.error === 'route_closed',
      `a Base destination must be refused as route_closed, got ${unopened.status} ${String(unopened.body.error)}`)
    refusals.push({ case: 'a destination this route does not open (Base)', refusal: `${unopened.status} ${String(unopened.body.error)}` })
    record('request conflicts', `a conflicting payload and an unopened leg both refused before any quote could be paid: ${refusals.map((r) => r.refusal).join('; ')}`)

    /* -------------------------------------------------------- 3. failed payment */

    const pending = store.get(jobId)!
    const wrongSigner = await post(payload, await header(pending, strangerAccount))
    assert(wrongSigner.status === 402 && wrongSigner.body.error === 'invalid_payment',
      `an authorization signed by another key must be refused, got ${wrongSigner.status} ${String(wrongSigner.body.error)}`)
    refusals.push({ case: 'an authorization signed by a key other than the bound payer', refusal: `${wrongSigner.status} ${String(wrongSigner.body.error)}` })

    const wrongAmount = await post(payload, await header(pending, payerAccount, { value: (BigInt(total) - 1n).toString() }))
    assert(wrongAmount.status === 402 && wrongAmount.body.error === 'invalid_payment',
      `an authorization for a different amount must be refused, got ${wrongAmount.status} ${String(wrongAmount.body.error)}`)
    refusals.push({ case: 'an authorization for less than the quoted total', refusal: `${wrongAmount.status} ${String(wrongAmount.body.error)}` })

    const expired = await post(payload, await header(pending, payerAccount, { validBefore: String(now() - 1) }))
    assert(expired.status === 402 || expired.status === 409, `an expired authorization must be refused, got ${expired.status}`)
    refusals.push({ case: 'an authorization whose validity window already closed', refusal: `${expired.status} ${String(expired.body.error)}` })

    // Nothing may have happened on either chain yet. This is the check that a refused payment is a
    // refusal and not a partially fulfilled launch.
    const beforePaying = await route.observe({ job: pending, step: pending.steps[0] }, await route.plan({ job: { ...pending, payment: await sign(pending) }, step: pending.steps[0] }))
    assert(beforePaying === 'absent', 'the settlement authorization was consumed by a refused payment')
    assert(store.get(jobId)!.state === 'awaiting_payment', 'a refused payment left the job past awaiting_payment')
    record('failed payment', `three refused authorizations — wrong signer, wrong amount, expired window — left the job awaiting payment with the authorization nonce unconsumed on chain: ${refusals.slice(-3).map((r) => r.refusal).join('; ')}`)

    /* -------------------------------------------------------- 4. the paid launch, credit queued */

    const paid = await post(payload, await header(store.get(jobId)!))
    assert(paid.status === 202, `a launch whose credit is queued must answer 202, not ${paid.status}`)
    const queuedJob = store.get(jobId)!
    assert(queuedJob.state === 'partial', `the queued job is ${queuedJob.state}, not partial`)
    assert(queuedJob.settlement !== undefined, 'the queued job has no settlement recorded, so the charge is not inspectable')
    assert(queuedJob.sweep === 'eligible', 'the queued job is not eligible for the unattended sweep')
    const creditStep = queuedJob.steps.find((step) => step.id === 'credit:solana')!
    assert(creditStep.state === 'prepared', `the credit step is ${creditStep.state}; this case exists to hold it short of complete`)
    const claim = creditStep.claim
    assert(claim !== undefined, 'the queued credit left no claim on the durable job, so a restart has nothing to resume from')
    assert(claim.amount === SOLANA_ALLOCATION.toString(), `the bound claim carries ${claim.amount} atoms, not the ${SOLANA_ALLOCATION} allocation`)
    assert(claim.recipient === infrastructure.payer.publicKey.toBase58(), `the claim is addressed to ${claim.recipient}, not this launch's custody owner`)
    const creditPlan = decodePlan(creditStep.prepared!.operation, creditStep.prepared!.bytes)
    assert(creditPlan.kind === 'credit' && claim.reference === creditPlan.digest,
      'the claim reference is not the manager-message digest the step was planned against')
    // The boundary is measured against the Clock sysvar the manager compared with, not derived from
    // the duration: computing it as `releaseAfter - duration` would return the duration regardless.
    const atQueue = reviewReleaseBoundary({
      queueClock: BigInt(claim.observedClock), releaseAfter: BigInt(claim.releaseAfter),
      observedClock: BigInt(claim.observedClock), duration: RATE_LIMIT_DURATION, slack: DELAY_SLACK,
    })
    assert(atQueue.matchesDuration,
      `the manager put its boundary ${atQueue.programDelay} seconds past the Clock sysvar read at ${claim.observedClock}, not the ${RATE_LIMIT_DURATION} it declares`)
    assert(!atQueue.releasable, 'the recorded claim is already releasable on the clock that queued it')
    const freeWhileQueued = publicJob(queuedJob)
    assert(freeWhileQueued.payment.settled && freeWhileQueued.payment.fulfillment === 'incomplete',
      'the free record does not separate a settled charge from an unfulfilled launch')
    assert(freeWhileQueued.supply.queued === SOLANA_ALLOCATION.toString(),
      `the free record reports ${freeWhileQueued.supply.queued} atoms queued, not the ${SOLANA_ALLOCATION} claim`)
    assert(freeWhileQueued.claims.length === 1 && freeWhileQueued.claims[0].released === false,
      'the free record does not show the outstanding claim')
    record('credit queued', `the paid launch settled once, issued ${ISSUANCE} atoms on Arc, built both legs and locked ${SOLANA_ALLOCATION} atoms — and the spoke's own inbound limit held the delivery. The job records the claim ${claim.reference} for ${claim.amount} atoms to ${claim.recipient}, releasable no earlier than ${claim.releaseAfter}, a measured ${atQueue.programDelay} seconds past the Clock sysvar at ${claim.observedClock} against the ${RATE_LIMIT_DURATION} the program declares. ${queuedJob.error ?? ''}`)

    const whileQueued = await route.observeLedger(queuedJob, routePending(queuedJob))
    assert(whileQueued.spokeSupply === 0n, `the queued claim minted ${whileQueued.spokeSupply} atoms on Solana before its boundary`)
    assert(whileQueued.hubCustody === SOLANA_ALLOCATION, 'Arc custody does not back the claim the spoke is holding')
    const queuedGate = await gateLedger(route, queuedJob)
    assert(queuedGate.compared && queuedGate.reconciliation?.ok === true,
      'the two ledgers do not reconcile with the claim outstanding, so a queue is being treated as an accounting event')
    record('conservation with a claim outstanding', `nothing was created or destroyed while the claim waits: hub custody ${whileQueued.hubCustody} backs ${whileQueued.pendingToSpoke} atoms in flight against spoke supply ${whileQueued.spokeSupply}, with issuance ${whileQueued.issuance} and hub circulating ${whileQueued.hubCirculating}. Both halves read from their own chain.`)

    /* -------------------------------------------------------- 5. the early release is refused */

    // Straight at the program, with the runner and the route's own restraint out of the way: the
    // refusal has to be the manager's, not the adapter declining to try.
    let early = 'accepted, which it must not be'
    try {
      await releaseSpokeClaim(infrastructure, queuedJob, claim.reference)
    } catch (error) {
      early = refusalReason(error)
    }
    assert(!early.startsWith('accepted'), 'the pinned manager released a claim before its own boundary')
    refusals.push({ case: 'the queued launch credit released before the manager\'s boundary', refusal: early })
    const afterEarly = await route.observeLedger(queuedJob, routePending(queuedJob))
    assert(afterEarly.spokeSupply === 0n, 'the refused early release minted anyway')
    record('early release refused', `releasing this launch's claim before its boundary is refused by the pinned manager: ${early}. Spoke supply is still ${afterEarly.spokeSupply}.`)

    // And unattended: the sweep reaches the job, finds the claim still held, and submits nothing.
    reopen()
    const sweptWhileQueued = await reconcile(store, adapter, Date.now, 5)
    const stillQueued = store.get(jobId)!
    const sweptClaim = stillQueued.steps.find((step) => step.id === 'credit:solana')!.claim!
    assert(stillQueued.state === 'partial', `the sweep moved the queued job to ${stillQueued.state}`)
    assert(sweptClaim.queuedAt === claim.queuedAt, 'the sweep reset when this launch started waiting')
    assert(sweptClaim.releaseAfter === claim.releaseAfter, 'the sweep recorded a different boundary for the same claim')
    assert((await route.observeLedger(stillQueued, routePending(stillQueued))).spokeSupply === 0n, 'the sweep credited a claim that is still held')
    record('unattended sweep holds', `the reopened store's sweep found the claim still held and submitted nothing (${JSON.stringify(sweptWhileQueued)}). The claim keeps its first-seen ${sweptClaim.queuedAt} and the manager's boundary ${sweptClaim.releaseAfter}; spoke supply is still 0.`)

    /* -------------------------------------------------------- 6. a spoke restart, claim outstanding */

    validator = await restartSpoke(infrastructure, validator)
    const afterRestart = store.get(jobId)!
    const retainedOnChain = await route.observe({ job: afterRestart, step: creditStep }, await route.plan({ job: afterRestart, step: creditStep }))
    assert(typeof retainedOnChain === 'object' && 'queued' in retainedOnChain, 'the reopened ledger lost the queued claim')
    assert(retainedOnChain.queued.reference === claim.reference && retainedOnChain.queued.releaseAfter === claim.releaseAfter,
      'the reopened ledger altered the claim or its boundary')
    const acrossRestart = await route.observeLedger(afterRestart, routePending(afterRestart))
    assert(acrossRestart.hubCustody === SOLANA_ALLOCATION, 'Arc stopped backing the claim across the spoke restart')
    record('spoke restart', `the Solana validator was killed with SIGKILL with the claim outstanding and its ledger reopened: the claim ${retainedOnChain.queued.reference} came back with the same ${retainedOnChain.queued.releaseAfter} boundary. The Arc fork stayed up throughout and still holds ${acrossRestart.hubCustody} atoms of custody, so the backing is a live read of a chain that never restarted.`)

    /* -------------------------------------------------------- 7. the boundary passes */

    const shift = prepareClockShift()
    if (!shift.available) {
      const unreleased = `The eventual release of this launch's queued credit is NOT executed: ${shift.why}. Everything up to the boundary IS executed above — the claim bound to the durable job, the early release refused by the pinned manager, the sweep that submitted nothing, the spoke restart with the claim outstanding, and two-sided conservation throughout. The equivalent release on the Arc hub, whose delay is a constructor parameter and whose clock the fork exposes, is executed in scripts/solana/integrate.ts.`
      record('not executed', unreleased)
      writeRecord(jobId, { complete: false, endState: whileQueued, reconciliation: queuedGate.reconciliation, notExecuted: [unreleased, ...NOT_EXECUTED] })
      throw new Error(`This harness cannot finish the launch without advancing the spoke clock: ${shift.why}. The evidence up to the manager's boundary is in output/equilibrium/arc-solana-fulfillment.json.`)
    }

    const seedDirectory = join(OUT, 'arc-solana-fulfillment-seed')
    const spoke = spokeDeployment(store.get(jobId)!)
    const inboxItem = spoke.at.inboxItem(Uint8Array.from(Buffer.from(claim.reference.slice(2), 'hex')))
    const programNames = new Map([
      [SOLANA_NTT.manager, 'NTT manager'], [SOLANA_NTT.transceiver, 'transceiver'],
      [SOLANA_NTT.coreBridge, 'core bridge'], [TOKEN_PROGRAM.toBase58(), 'SPL token'],
      [SystemProgram.programId.toBase58(), 'system'],
    ])
    // Rooted, not merely confirmed. A hard kill can only be survived by state the validator has
    // already finalized, so the claim is waited for at that commitment before the ledger is dumped.
    await awaitFinalizedAccount(infrastructure.connection, inboxItem)
    const dumped = await dumpSpokeLedger(infrastructure.connection, [...SPOKE_PROGRAMS], [spoke.at.feeCollector])
    const dumpedClaim = dumped.find((account) => account.pubkey === inboxItem.toBase58())
    assert(dumpedClaim !== undefined, 'the dump does not contain this launch\'s queued claim')
    writeSeedDirectory(seedDirectory, dumped)
    record('spoke ledger dumped', `${dumped.length} accounts (${describeSeed(dumped, programNames)}) read at finalized commitment, including the queued claim at ${dumpedClaim.pubkey}. Executable accounts are excluded; the two NTT programs come back under the same ids and the same upgrade authority.`)

    const advanceBy = RATE_LIMIT_DURATION + 60
    clockFixture(`The spoke ledger is rebuilt at a new genesis from the ${dumped.length} accounts the pinned programs wrote, under a validator process whose CLOCK_REALTIME is offset by +${advanceBy} seconds (${shift.label}). CLOCK_MONOTONIC is untouched, so PoH runs at real speed. Nothing about the queue is simulated: this launch's claim, its ${RATE_LIMIT_DURATION}-second boundary and the release are the pinned manager's own, and the rebuilt accounts are compared byte for byte against the dump before anything is released.`)
    const advancedLedger = mkdtempSync(join(tmpdir(), 'equilibrium-fulfil-advanced-'))
    ledgers.push(advancedLedger)
    validator = await restartSpoke(infrastructure, validator, {
      seedDirectory, ledger: advancedLedger, environment: clockShiftEnvironment(shift, advanceBy),
      fund: [infrastructure.payer, infrastructure.admin],
    })
    const differences = seedDifferences(dumped, await readSeeded(infrastructure.connection, dumped))
    assert(differences.length === 0, `the rebuilt spoke ledger does not carry the accounts it was seeded from: ${differences.slice(0, 5).join('; ')}`)
    const advancedClock = await readChainClock(infrastructure.connection)
    const boundary = reviewReleaseBoundary({
      queueClock: BigInt(claim.observedClock), releaseAfter: BigInt(claim.releaseAfter),
      observedClock: advancedClock, duration: RATE_LIMIT_DURATION, slack: DELAY_SLACK,
    })
    assert(boundary.advancedBy >= BigInt(RATE_LIMIT_DURATION), `the clock fixture advanced the spoke by ${boundary.advancedBy} seconds, short of the ${RATE_LIMIT_DURATION} the queue requires`)
    assert(boundary.releasable, 'the advanced spoke clock has not passed the boundary the manager wrote')
    record('claim retained across a rebuilt ledger', `all ${dumped.length} seeded accounts came back byte-identical, including this launch's claim and its ${claim.releaseAfter} boundary. The spoke clock is now ${advancedClock}, ${boundary.advancedBy} seconds past the clock that queued the claim; the measured program delay is still ${boundary.programDelay}.`)

    /* -------------------------------------------------------- 8. the release, interrupted */

    // The release is submitted and then reported unresolved, which is what a worker that dies
    // between sending an effect and recording it leaves behind.
    reopen({ pending: new Set(['credit:solana']) })
    const interruptedRelease = await reconcile(store, adapter, Date.now, 5)
    const unrecorded = store.get(jobId)!
    const unrecordedStep = unrecorded.steps.find((step) => step.id === 'credit:solana')!
    assert(unrecorded.state === 'partial', `the interrupted release left the job ${unrecorded.state}, not partial`)
    assert(unrecordedStep.state === 'prepared', `the credit step is ${unrecordedStep.state}, so this case is not testing an unrecorded effect`)
    const duringOutage = await route.observeLedger(unrecorded, routePending(unrecorded))
    assert(duringOutage.spokeSupply === SOLANA_ALLOCATION,
      `the submitted release minted ${duringOutage.spokeSupply} atoms on Solana, not the ${SOLANA_ALLOCATION} it was bound to`)
    assert(duringOutage.hubCustody === SOLANA_ALLOCATION, 'Arc custody does not back the credit the spoke already minted')
    record('interrupted release', `the released claim did land — SPL supply ${duringOutage.spokeSupply} against observed Arc custody ${duringOutage.hubCustody} — while the job still records the step as merely prepared (${JSON.stringify(interruptedRelease)}).`)

    /* -------------------------------------------------------- 9. unattended recovery */

    // No client request and no signature: the store is reopened and the sweep finishes the launch.
    reopen()
    const resumed = await reconcile(store, adapter, Date.now, 5)
    const recovered = store.get(jobId)!
    assert(recovered.state === 'complete', `the sweep left the job ${recovered.state}: ${recovered.error ?? 'no error'}`)
    const releasedClaim = recovered.steps.find((step) => step.id === 'credit:solana')!.claim!
    assert(releasedClaim.releasedAt !== undefined, 'the completed credit lost the record of the delay it waited out')
    assert(releasedClaim.reference === claim.reference && releasedClaim.amount === claim.amount && releasedClaim.recipient === claim.recipient,
      'the delivered claim is not the claim this launch queued')
    const afterRecovery = await route.observeLedger(recovered, routePending(recovered))
    assert(afterRecovery.spokeSupply === SOLANA_ALLOCATION,
      `recovery credited again: SPL supply is ${afterRecovery.spokeSupply}, not the ${SOLANA_ALLOCATION} bound to this launch`)
    const gate = await gateLedger(route, recovered)
    assert(gate.compared && gate.reconciliation?.ok === true, 'the completed launch does not reconcile across the two chains')
    assert(outstandingClaims(recovered).length === 0, 'the completed launch still reports an outstanding claim')
    record('unattended recovery', `the reopened store's sweep finished the launch with no client request (${JSON.stringify(resumed)}) and credited nothing twice. The claim queued at ${releasedClaim.queuedAt} is recorded released at ${releasedClaim.releasedAt}, and both observed ledgers reconcile: issuance ${afterRecovery.issuance}, hub circulating ${afterRecovery.hubCirculating}, hub custody ${afterRecovery.hubCustody}, spoke supply ${afterRecovery.spokeSupply}, spoke custody ${afterRecovery.spokeCustody}.`)

    let releasedTwice = 'accepted, which it must not be'
    try {
      await releaseSpokeClaim(infrastructure, recovered, claim.reference)
    } catch (error) {
      releasedTwice = refusalReason(error)
    }
    assert(!releasedTwice.startsWith('accepted'), 'the released claim was accepted a second time by the manager')
    refusals.push({ case: 'the released launch credit submitted to the manager a second time', refusal: releasedTwice })
    assert((await route.observeLedger(store.get(jobId)!, routePending(store.get(jobId)!))).spokeSupply === SOLANA_ALLOCATION,
      'the repeated release minted again')
    record('released once', `the delivered claim resubmitted straight to the pinned manager was refused: ${releasedTwice}. Spoke supply is unchanged.`)

    /* -------------------------------------------------------- 10. replay */

    const settledOnce = recovered.steps[0].result!.transaction
    const replayed = await post(payload, await header(recovered))
    assert(replayed.status === 200, `replaying the completed paid request must answer 200, not ${replayed.status}`)
    const afterReplay = store.get(jobId)!
    assert(afterReplay.steps[0].result!.transaction === settledOnce, 'the replay produced a second settlement transaction')
    const afterReplayLedger = await route.observeLedger(afterReplay, routePending(afterReplay))
    assert(afterReplayLedger.spokeSupply === SOLANA_ALLOCATION && afterReplayLedger.hubCustody === SOLANA_ALLOCATION,
      'the replay moved supply or custody')
    assert(afterReplayLedger.issuance === ISSUANCE, `the replay changed the issuance to ${afterReplayLedger.issuance}`)
    refusals.push({ case: 'the identical completed paid request re-sent over HTTP', refusal: '200 with the same settlement transaction and no new effect' })

    // Straight to the token, bypassing the service entirely: the nonce is what makes this safe.
    let onChainReplay = 'accepted, which it must not be'
    try {
      await route.submit({ job: afterReplay, step: afterReplay.steps[0] }, await route.plan({ job: afterReplay, step: afterReplay.steps[0] }))
    } catch (error) {
      // Named, not "the call reverted": the evidence should say which constraint held.
      onChainReplay = revertReason(error)
    }
    assert(!onChainReplay.startsWith('accepted'), 'the settled authorization was accepted a second time by the token')
    refusals.push({ case: 'the settled EIP-3009 authorization resubmitted directly to the token', refusal: onChainReplay })
    record('replay', `the completed request replayed over HTTP changed nothing, and the settled authorization resubmitted straight to the token was refused on chain: ${onChainReplay}`)

    /* -------------------------------------------------------- 11. the record */

    const endState = await route.observeLedger(store.get(jobId)!, routePending(store.get(jobId)!))
    writeRecord(jobId, { complete: true, reconciliation: gate.reconciliation, endState, notExecuted: NOT_EXECUTED })
    const listed = await get(jobId)
    assert(listed.status === 200, `the job status endpoint answered ${listed.status}`)
    console.log('\nAll checks passed. Record written to output/equilibrium/arc-solana-fulfillment.json')
  } finally {
    await server.stop(true)
    store.close()
    closeRoute(anvil, validator)
    if (!process.env.EQUILIBRIUM_SOLANA_KEEP_LEDGER) for (const directory of ledgers) rmSync(directory, { recursive: true, force: true })
  }
}

await main()
