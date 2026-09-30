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
 *   interruption       a worker that submits the SPL credit and dies before recording it. The store
 *                      is closed and reopened, and the unattended sweep finishes the launch with no
 *                      client request and without crediting twice.
 *   spoke restart      the validator killed with SIGKILL and its ledger reopened mid-launch.
 *   replay             the identical paid request re-sent after completion, and the settled
 *                      authorization resubmitted directly to the token.
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
import { Keypair } from '@solana/web3.js'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { closeRoute, fulfillmentRoute, openRoute, restartSpoke, type RouteInfrastructure } from '../../scripts/solana/fulfillRoute'
import { AUTHORIZATION_TYPES, paymentDomain, paymentRequirements } from './payment'
import { publicJob, reconcile } from './runner'
import { solanaAdapter } from './solanaAdapter'
import { gateLedger, routePending } from './solanaRoute'
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

/* ------------------------------------------------------------------ recording */

interface Checkpoint { checkpoint: string; detail: string; at: string }
const checkpoints: Checkpoint[] = []
const fixtures: string[] = []
const refusals: { case: string; refusal: string }[] = []

function record(checkpoint: string, detail: string): void {
  checkpoints.push({ checkpoint, detail, at: new Date().toISOString() })
  console.log(`  ${checkpoint}: ${detail}`)
}
function fixture(what: string): void {
  fixtures.push(what)
  record('FIXTURE', what)
}
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Fulfilment assertion failed: ${message}`)
}

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

  const ledger = mkdtempSync(join(tmpdir(), 'equilibrium-fulfil-'))
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

  const route = fulfillmentRoute(infrastructure)
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
    const quoted = await post(request(now(), beneficiary))
    assert(quoted.status === 402, `an unpaid quote must answer 402, not ${quoted.status}`)
    assert(typeof quoted.headers.get('PAYMENT-REQUIRED') === 'string', 'the 402 does not carry a PAYMENT-REQUIRED header')
    const jobId = quoted.body.jobId as Hex
    const total = quoted.body.total as string
    assert(typeof jobId === 'string' && /^0x[0-9a-f]{64}$/.test(jobId), 'the quote did not bind a job id')
    record('quote', `402 with a bound job ${jobId}: total ${total} atoms over ${(quoted.body.steps as unknown[]).length} steps, quote inventory ${String(quoted.body.quoteInventory)}. Nothing is issued and nothing is charged.`)

    /* -------------------------------------------------------- 2. request conflicts */

    const conflicting = await post({ ...request(now(), beneficiary), canonical: { ...request(now(), beneficiary).canonical, symbol: 'OTHER' } })
    assert(conflicting.status === 409 && conflicting.body.error === 'identity_conflict',
      `a second payload under the same requestId must be refused as identity_conflict, got ${conflicting.status} ${String(conflicting.body.error)}`)
    refusals.push({ case: 'a different payload under the same payer/requestId', refusal: `${conflicting.status} ${String(conflicting.body.error)}` })

    const unopened = await post({ ...request(now(), beneficiary), requestId: 'arc-solana-fulfilment-base', destinations: [
      { chain: 'arc', recipient: payerAccount.address, amount: '1000', poolTokens: '100', poolQuote: '100' },
      { chain: 'base', recipient: payerAccount.address, amount: '1000', poolTokens: '100', poolQuote: '100' },
    ] })
    assert(unopened.status === 503 && unopened.body.error === 'route_closed',
      `a Base destination must be refused as route_closed, got ${unopened.status} ${String(unopened.body.error)}`)
    refusals.push({ case: 'a destination this route does not open (Base)', refusal: `${unopened.status} ${String(unopened.body.error)}` })
    record('request conflicts', `a conflicting payload and an unopened leg both refused before any quote could be paid: ${refusals.map((r) => r.refusal).join('; ')}`)

    /* -------------------------------------------------------- 3. failed payment */

    const pending = store.get(jobId)!
    const wrongSigner = await post(request(now(), beneficiary), await header(pending, strangerAccount))
    assert(wrongSigner.status === 402 && wrongSigner.body.error === 'invalid_payment',
      `an authorization signed by another key must be refused, got ${wrongSigner.status} ${String(wrongSigner.body.error)}`)
    refusals.push({ case: 'an authorization signed by a key other than the bound payer', refusal: `${wrongSigner.status} ${String(wrongSigner.body.error)}` })

    const wrongAmount = await post(request(now(), beneficiary), await header(pending, payerAccount, { value: (BigInt(total) - 1n).toString() }))
    assert(wrongAmount.status === 402 && wrongAmount.body.error === 'invalid_payment',
      `an authorization for a different amount must be refused, got ${wrongAmount.status} ${String(wrongAmount.body.error)}`)
    refusals.push({ case: 'an authorization for less than the quoted total', refusal: `${wrongAmount.status} ${String(wrongAmount.body.error)}` })

    const expired = await post(request(now(), beneficiary), await header(pending, payerAccount, { validBefore: String(now() - 1) }))
    assert(expired.status === 402 || expired.status === 409, `an expired authorization must be refused, got ${expired.status}`)
    refusals.push({ case: 'an authorization whose validity window already closed', refusal: `${expired.status} ${String(expired.body.error)}` })

    // Nothing may have happened on either chain yet. This is the check that a refused payment is a
    // refusal and not a partially fulfilled launch.
    const beforePaying = await route.observe({ job: pending, step: pending.steps[0] }, await route.plan({ job: { ...pending, payment: await sign(pending) }, step: pending.steps[0] }))
    assert(beforePaying === 'absent', 'the settlement authorization was consumed by a refused payment')
    assert(store.get(jobId)!.state === 'awaiting_payment', 'a refused payment left the job past awaiting_payment')
    record('failed payment', `three refused authorizations — wrong signer, wrong amount, expired window — left the job awaiting payment with the authorization nonce unconsumed on chain: ${refusals.slice(-3).map((r) => r.refusal).join('; ')}`)

    /* -------------------------------------------------------- 4. an interrupted worker */

    // The credit is submitted and then reported unresolved, which is what a worker that dies between
    // sending an effect and recording it leaves behind. Everything before it runs to completion.
    reopen({ pending: new Set(['credit:solana']) })
    const interrupted = await post(request(now(), beneficiary), await header(store.get(jobId)!))
    assert(interrupted.status === 202, `an interrupted launch must answer 202, not ${interrupted.status}`)
    const partial = store.get(jobId)!
    assert(partial.state === 'partial', `the interrupted job is ${partial.state}, not partial`)
    assert(partial.settlement !== undefined, 'the interrupted job has no settlement recorded, so the charge is not inspectable')
    assert(partial.sweep === 'eligible', 'the interrupted job is not eligible for the unattended sweep')
    const creditStep = partial.steps.find((step) => step.id === 'credit:solana')!
    assert(creditStep.state === 'prepared', `the credit step is ${creditStep.state}, so this case is not testing an unrecorded effect`)
    record('interrupted worker', `settled and issued, then the SPL credit was submitted and left unrecorded: ${partial.error ?? 'no error recorded'}. The job is partial, sweep-eligible, and its settlement is readable on its own.`)

    const duringOutage = await route.observeLedger(partial, routePending(partial))
    assert(duringOutage.spokeSupply === SOLANA_ALLOCATION,
      `the submitted credit minted ${duringOutage.spokeSupply} atoms on Solana, not the ${SOLANA_ALLOCATION} it was bound to`)
    assert(duringOutage.hubCustody === SOLANA_ALLOCATION, 'Arc custody does not back the credit the spoke already minted')
    record('unrecorded effect observed', `the credit did land: SPL supply ${duringOutage.spokeSupply} against observed Arc custody ${duringOutage.hubCustody}, while the job still records the step as merely prepared.`)

    /* -------------------------------------------------------- 5. a spoke restart */

    validator = await restartSpoke(infrastructure, validator)
    record('spoke restart', 'the Solana validator was killed with SIGKILL mid-launch and its ledger reopened. The Arc fork stayed up throughout, so the custody backing the claim is a live read of a chain that never restarted.')

    /* -------------------------------------------------------- 6. unattended recovery */

    // No client request and no signature: the store is reopened and the sweep finishes the launch.
    reopen()
    const resumed = await reconcile(store, adapter, Date.now, 5)
    const recovered = store.get(jobId)!
    assert(recovered.state === 'complete', `the sweep left the job ${recovered.state}: ${recovered.error ?? 'no error'}`)
    const afterRecovery = await route.observeLedger(recovered, routePending(recovered))
    assert(afterRecovery.spokeSupply === SOLANA_ALLOCATION,
      `recovery credited again: SPL supply is ${afterRecovery.spokeSupply}, not the ${SOLANA_ALLOCATION} bound to this launch`)
    const gate = await gateLedger(route, recovered)
    assert(gate.compared && gate.reconciliation?.ok === true, 'the completed launch does not reconcile across the two chains')
    record('unattended recovery', `the reopened store's sweep finished the launch with no client request (${JSON.stringify(resumed)}) and credited nothing twice. Both observed ledgers reconcile: issuance ${afterRecovery.issuance}, hub circulating ${afterRecovery.hubCirculating}, hub custody ${afterRecovery.hubCustody}, spoke supply ${afterRecovery.spokeSupply}, spoke custody ${afterRecovery.spokeCustody}.`)

    /* -------------------------------------------------------- 7. replay */

    const settledOnce = recovered.steps[0].result!.transaction
    const replayed = await post(request(now(), beneficiary), await header(recovered))
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
      onChainReplay = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 200)
    }
    assert(!onChainReplay.startsWith('accepted'), 'the settled authorization was accepted a second time by the token')
    refusals.push({ case: 'the settled EIP-3009 authorization resubmitted directly to the token', refusal: onChainReplay })
    record('replay', `the completed request replayed over HTTP changed nothing, and the settled authorization resubmitted straight to the token was refused on chain: ${onChainReplay}`)

    /* -------------------------------------------------------- 8. the record */

    const final = publicJob(store.get(jobId)!)
    const endState = await route.observeLedger(store.get(jobId)!, routePending(store.get(jobId)!))
    const result = {
      observedAt: new Date().toISOString(),
      mode: 'local' as const,
      claim: 'Durable shared-supply launch fulfilment over the verified Arc–Solana route. An Anvil fork of Arc testnet carrying the real deployed Wormhole core bridge, with a locking NTT manager and transceiver deployed onto it per launch, exchanging its own published message bytes with the pinned NTT programs and the real mainnet core bridge binary on a local Solana validator. The paid quote, the job and its status were driven over HTTP. Not a public route, not a devnet, testnet or mainnet deployment, no funds moved.',
      route: { version: route.version, terms: route.terms, port: PORT, journal: JOURNAL },
      infrastructure: {
        arcFork: infrastructure.arc.url, solanaRpc: `http://127.0.0.1:${infrastructure.rpcPort}`,
        factory: infrastructure.factory, registry: infrastructure.registry, distributor: infrastructure.distributor,
        settlementFixture: infrastructure.paymentAsset, quoteFixture: infrastructure.quoteAsset,
        solanaQuoteFixtureMint: infrastructure.quoteMint.publicKey.toBase58(),
        guardianSetIndex: infrastructure.guardianSubstitution.index,
        guardianSetReplaced: infrastructure.guardianSubstitution.replaced,
      },
      job: final,
      endState,
      reconciliation: gate.reconciliation,
      refusals,
      fixtures,
      notExecuted: [
        'Any public route. No canonical token, manager, transceiver, mint, inventory or transfer exists on Arc mainnet or testnet, Solana devnet or mainnet-beta, and no funds moved.',
        'The Solana inbound queue\'s eventual release. The pinned SVM program hard-codes a 24-hour RATE_LIMIT_DURATION against the Clock sysvar and the local validator\'s clock cannot be advanced on this host; this harness keeps the spoke inbound limit at the full issuance so no launch credit is queued. The equivalent hub release is executed in scripts/solana/integrate.ts.',
        'Any venue or AMM pool. The inventory steps place pool tokens and quote inventory into a per-operation holder and deliver the rest of each allocation to the request\'s recipient, atomically. Opening a market adapter is not part of this route.',
        'Solana network fees as launch cost. They are paid in SOL by the operator\'s fee payer and reported as a zero launch cost rather than converted into the customer\'s six-decimal atoms.',
      ],
      publicRouteTested: false,
      checkpoints,
    }
    const asJson = JSON.stringify(result, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2)
    writeFileSync(join(OUT, 'arc-solana-fulfillment.json'), `${asJson}\n`)
    const listed = await get(jobId)
    assert(listed.status === 200, `the job status endpoint answered ${listed.status}`)
    console.log('\nAll checks passed. Record written to output/equilibrium/arc-solana-fulfillment.json')
  } finally {
    await server.stop(true)
    store.close()
    closeRoute(anvil, validator)
    if (!process.env.EQUILIBRIUM_SOLANA_KEEP_LEDGER) rmSync(ledger, { recursive: true, force: true })
  }
}

await main()
