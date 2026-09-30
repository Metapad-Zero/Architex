/**
 * The durable Arc–Solana fulfilment path: conflicts, failed payment, restarts and replays.
 *
 * These run against a LEDGER DOUBLE, not the chains. The double is not a convenience — it enforces
 * the four uniqueness rules the real route gets from chain code, and it counts how many times each
 * irreversible thing happened, which is the assertion these tests exist to make:
 *
 *   an EIP-3009 nonce settles once            (the token's `authorizationState`)
 *   an issuance identity binds once           (`EquilibriumIssuanceFactory`)
 *   a claim digest releases once              (the pinned NTT manager's inbox item)
 *   an inventory placement happens once       (`EquilibriumDistributor.placed`)
 *
 * and one rule it gets from the chain's absence of a rule: the hub's `transfer` is NOT idempotent, so
 * the double publishes a fresh message at the next sequence on every submission. That is what makes
 * the debit's recorded-sequence observation worth testing rather than assuming.
 *
 * The real route is exercised against the actual Arc fork and the pinned SVM programs by
 * `server/equilibrium/solanaFulfillment.ts`; these tests cover the decisions that layer makes.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, toBytes, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import { reconcileRoute, type ObservedRoute } from '../../../src/lib/equilibriumArcSolana'
import { AUTHORIZATION_TYPES, paymentDomain, paymentRequirements } from '../payment'
import { hash } from '../request'
import { publicJob, quote, reconcile, runJob } from '../runner'
import { createLaunchService } from '../service'
import { solanaAdapter } from '../solanaAdapter'
import {
  assertRouteRequest, decodePlan, gateLedger, inventoryHolder, ledgerComparable, operationOf,
  routePending, solanaSeed,
  type DebitPlan, type RoutePending, type SolanaRoute, type StepPlan,
} from '../solanaRoute'
import { JobStore } from '../store'
import type { EffectContext, EffectResult, Job, LaunchRequest, SignedPayment, StepKind } from '../types'

/* ------------------------------------------------------------------ the request */

const payer = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000123')
const stranger = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000456')
const BENEFICIARY = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const CUSTODIAN = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrq'
const ISSUANCE = 1_000_000_000_000n
const ARC_AMOUNT = 600_123_456_789n
const SOL_AMOUNT = 399_876_543_211n
const ARC_POOL = 100_111_111n
const SOL_POOL = 200_222_222n
const QUOTE = 10_333_333n
const now = 1_800_000_000

function request(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    requestId: 'arc-solana-0001', payer: payer.address.toLowerCase() as Hex,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: ISSUANCE.toString(), recipient: payer.address },
    destinations: [
      { chain: 'arc', recipient: payer.address, amount: ARC_AMOUNT.toString(), poolTokens: ARC_POOL.toString(), poolQuote: QUOTE.toString() },
      { chain: 'solana', recipient: BENEFICIARY, amount: SOL_AMOUNT.toString(), poolTokens: SOL_POOL.toString(), poolQuote: QUOTE.toString() },
    ],
    quote: { expires: now + 240, costCap: '1000000000' },
    ...overrides,
  }
}

const TERMS = { chainId: 5042002, asset: '0x0000000000000000000000000000000000f1c701' as Hex, payTo: '0x0000000000000000000000000000000000004020' as Hex, name: 'USDC-FIXTURE', version: '2' }

async function sign(job: Job, signer = payer, overrides: { value?: string } = {}): Promise<SignedPayment> {
  const authorization = { from: job.request.payer, to: job.terms.payTo, value: overrides.value ?? job.total, validAfter: '0', validBefore: String(job.request.quote.expires), nonce: job.id }
  const signature = await signer.signTypedData({
    domain: paymentDomain(job), types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  })
  return { authorization, signature }
}
async function header(job: Job, signer = payer, overrides: { value?: string } = {}): Promise<string> {
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: paymentRequirements(job), payload: await sign(job, signer, overrides) as unknown as Record<string, unknown> })
}

/* ------------------------------------------------------------------ the ledger double */

interface DoubleState {
  /** `authorizationState[from][nonce]`, as the token keeps it. */
  settled: Map<string, string>
  /** `tokenOf` and the bound parameters the factory refuses to rebind. */
  issued: Map<Hex, { token: string; bound: Hex }>
  legs: Map<Hex, { manager: string }>
  /** Published hub messages by sequence. `transfer` is not idempotent, so this only ever grows. */
  published: { sequence: bigint; amount: bigint; custodian: string }[]
  nextSequence: bigint
  /** Inbox items by claim digest, and whether each has been released. */
  claims: Map<Hex, { amount: bigint; released: boolean }>
  placements: Map<Hex, { tokens: bigint; quote: bigint; delivered: bigint }>
  /** How many times each irreversible effect was actually performed. */
  counts: Record<string, number>
}

function state(): DoubleState {
  return { settled: new Map(), issued: new Map(), legs: new Map(), published: [], nextSequence: 7n, claims: new Map(), placements: new Map(), counts: {} }
}

interface DoubleOptions {
  /** Publish the debit at a sequence other than the one the plan recorded. */
  stealSequence?: boolean
  /** Credit more than the claim carries, so the two ledgers stop reconciling. */
  overMint?: bigint
}

/**
 * A route whose effects are recorded in memory under the same uniqueness rules the chains impose,
 * and whose ledger is read back out of those records rather than from the job.
 */
function double(recorded: DoubleState, options: DoubleOptions = {}): SolanaRoute {
  const count = (what: string) => { recorded.counts[what] = (recorded.counts[what] ?? 0) + 1 }
  const digestOf = (job: Job, sequence: bigint): Hex => keccak256(toBytes(`${job.id}:${sequence}`))

  const debitPlanOf = (job: Job, chain: string): DebitPlan => {
    const step = job.steps.find((candidate) => candidate.id === `debit:${chain}`)
    if (!step?.prepared) throw new Error(`debit:${chain} is not prepared`)
    const plan = decodePlan(step.prepared.operation, step.prepared.bytes)
    if (plan.kind !== 'debit') throw new Error('not a debit plan')
    return plan
  }

  return {
    version: 'arc-solana-double-v1',
    terms: TERMS,
    assertReady() { /* the double opens both legs */ },
    budgets: (): Record<StepKind, Atoms> => ({ payment: '1000000', canonical: '2000000', manager: '3000000', debit: '1000000', credit: '1000000', pool: '1000000' }),

    plan({ job, step }: EffectContext): Promise<StepPlan> {
      const operation = operationOf(job, step)
      const destination = job.request.destinations.find((d) => d.chain === step.chain)!
      switch (step.kind) {
        case 'payment': {
          const a = job.payment!.authorization
          return Promise.resolve({ kind: 'payment', asset: TERMS.asset, from: a.from, to: a.to, value: a.value, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce, signature: job.payment!.signature })
        }
        case 'canonical':
          return Promise.resolve({ kind: 'canonical', identity: operation, name: job.request.canonical.name, symbol: job.request.canonical.symbol, custody: TERMS.payTo, issuance: job.request.canonical.issuance })
        case 'manager':
          return Promise.resolve({ kind: 'leg', chain: step.chain === 'solana' ? 'solana' : 'arc', operation })
        case 'debit':
          return Promise.resolve({ kind: 'debit', amount: destination.amount, custodian: CUSTODIAN, beneficiary: destination.recipient, expectedSequence: recorded.nextSequence.toString() })
        case 'credit': {
          const debit = debitPlanOf(job, step.chain)
          return Promise.resolve({ kind: 'credit', amount: destination.amount, custodian: CUSTODIAN, digest: digestOf(job, BigInt(debit.expectedSequence)), sequence: debit.expectedSequence })
        }
        default:
          return Promise.resolve({
            kind: 'inventory', chain: step.chain === 'solana' ? 'solana' : 'arc', tokens: destination.poolTokens,
            quote: destination.poolQuote, holder: step.chain === 'solana' ? BENEFICIARY : inventoryHolder(operation),
            recipient: destination.recipient, delivered: (BigInt(destination.amount) - BigInt(destination.poolTokens)).toString(),
          })
      }
    },

    observe({ job, step }: EffectContext, plan: StepPlan): Promise<EffectResult | 'absent' | 'pending'> {
      const operation = operationOf(job, step)
      const done = (transaction: string, extra: Partial<EffectResult> = {}): EffectResult =>
        ({ operation, transaction, finalized: true, cost: step.budget, ...extra })
      switch (plan.kind) {
        case 'payment': {
          const transaction = recorded.settled.get(`${plan.from}:${plan.nonce}`)
          return Promise.resolve(transaction ? { operation, transaction, finalized: true, cost: '0', amount: plan.value } : 'absent')
        }
        case 'canonical': {
          const issued = recorded.issued.get(plan.identity)
          return Promise.resolve(issued ? done(`arc:issue:${plan.identity}`, { address: issued.token, amount: plan.issuance }) : 'absent')
        }
        case 'leg': {
          const leg = recorded.legs.get(plan.operation)
          return Promise.resolve(leg ? done(`arc:leg:${plan.operation}`, { address: leg.manager }) : 'absent')
        }
        case 'debit': {
          const at = recorded.published.find((message) => message.sequence === BigInt(plan.expectedSequence))
          if (!at) {
            // The recorded sequence is the only handle on a non-idempotent transfer. A matching
            // payload elsewhere means the handle is wrong, not that nothing was sent.
            if (recorded.published.some((message) => message.amount === BigInt(plan.amount))) {
              throw new Error(`A matching debit is published at another sequence rather than the recorded ${plan.expectedSequence}`)
            }
            return Promise.resolve('absent')
          }
          if (at.amount !== BigInt(plan.amount) || at.custodian !== plan.custodian) throw new Error('The message at the recorded sequence is not this debit')
          return Promise.resolve(done(`arc:debit:${plan.expectedSequence}`, { address: '0xmanager', amount: plan.amount }))
        }
        case 'credit': {
          const claim = recorded.claims.get(plan.digest)
          if (!claim?.released) return Promise.resolve('absent')
          return Promise.resolve({ operation, transaction: `solana:inbox:${plan.digest}`, finalized: true, cost: '0', address: plan.custodian, amount: plan.amount })
        }
        case 'inventory': {
          const placement = recorded.placements.get(operation)
          if (!placement) return Promise.resolve('absent')
          if (placement.tokens !== BigInt(plan.tokens) || placement.quote !== BigInt(plan.quote)) throw new Error('The recorded placement does not match this step')
          return Promise.resolve({ operation, transaction: `place:${operation}`, finalized: true, cost: plan.chain === 'solana' ? '0' : step.budget, address: plan.holder, amount: plan.tokens, quoteAmount: plan.quote })
        }
      }
    },

    submit({ job, step }: EffectContext, plan: StepPlan): Promise<void> {
      const operation = operationOf(job, step)
      switch (plan.kind) {
        case 'payment': {
          const key = `${plan.from}:${plan.nonce}`
          // The token consumes the nonce. A second submission reverts; it does not transfer again.
          if (recorded.settled.has(key)) throw new Error('AuthorizationAlreadyUsed()')
          count('settlement')
          recorded.settled.set(key, `arc:settle:${plan.nonce}`)
          return Promise.resolve()
        }
        case 'canonical': {
          const bound = hash([plan.name, plan.symbol, plan.custody, plan.issuance])
          const existing = recorded.issued.get(plan.identity)
          if (existing) {
            if (existing.bound !== bound) throw new Error('Identity conflict')
            return Promise.resolve()
          }
          count('issuance')
          recorded.issued.set(plan.identity, { token: `0xtoken${plan.identity.slice(2, 10)}`, bound })
          return Promise.resolve()
        }
        case 'leg': {
          if (!recorded.legs.has(plan.operation)) {
            count(`leg:${plan.chain}`)
            recorded.legs.set(plan.operation, { manager: `0xmanager${plan.operation.slice(2, 10)}` })
          }
          return Promise.resolve()
        }
        case 'debit': {
          // NOT idempotent, exactly as the hub manager is not: every submission locks again and
          // publishes at whatever the next sequence happens to be.
          count('debit')
          const sequence = options.stealSequence ? recorded.nextSequence + 1n : recorded.nextSequence
          recorded.published.push({ sequence, amount: BigInt(plan.amount), custodian: plan.custodian })
          recorded.nextSequence = sequence + 1n
          return Promise.resolve()
        }
        case 'credit': {
          const claim = recorded.claims.get(plan.digest)
          if (claim?.released) throw new Error('The claim is already released')
          count('credit')
          recorded.claims.set(plan.digest, { amount: BigInt(plan.amount) + (options.overMint ?? 0n), released: true })
          return Promise.resolve()
        }
        case 'inventory': {
          if (!recorded.placements.has(operation)) {
            count(`inventory:${plan.chain}`)
            recorded.placements.set(operation, { tokens: BigInt(plan.tokens), quote: BigInt(plan.quote), delivered: BigInt(plan.delivered) })
          }
          return Promise.resolve()
        }
      }
    },

    /** Read out of the recorded effects, never out of the job's own steps. */
    observeLedger(job: Job, pending: RoutePending): Promise<ObservedRoute> {
      const canonical = recorded.issued.get(operationOf(job, job.steps.find((s) => s.id === 'canonical:arc')!))
      const issuance = canonical ? BigInt(job.request.canonical.issuance) : 0n
      const hubCustody = recorded.published.reduce((total, message) => total + message.amount, 0n)
      const spokeSupply = [...recorded.claims.values()].reduce((total, claim) => total + (claim.released ? claim.amount : 0n), 0n)
      return Promise.resolve({ issuance, hubCustody, hubCirculating: issuance - hubCustody, spokeSupply, spokeCustody: 0n, pendingToSpoke: pending.toSpoke, pendingToHub: pending.toHub })
    },
  }
}

/* ------------------------------------------------------------------ harness */

type Atoms = string

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function journal(): string {
  const directory = mkdtempSync(join(tmpdir(), 'equilibrium-arc-solana-'))
  directories.push(directory)
  return join(directory, 'fulfilment.sqlite')
}

/**
 * Accepts a thunk as well as a promise: the double throws synchronously where the chain reverts, so
 * a refusal from `submit` escapes before there is a promise to await.
 */
async function rejects(work: Promise<unknown> | (() => Promise<unknown>), message: string) {
  let failure: unknown
  try { await (typeof work === 'function' ? work() : work) } catch (cause) { failure = cause }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain(message)
}

function setup(options: { path?: string; recorded?: DoubleState; pending?: Set<string>; unavailable?: Set<string>; route?: DoubleOptions } = {}) {
  const recorded = options.recorded ?? state()
  const route = double(recorded, options.route)
  const store = new JobStore(options.path ?? ':memory:', { leaseMs: 60_000 })
  const adapter = solanaAdapter(route, { pending: options.pending, unavailable: options.unavailable })
  return { recorded, route, store, adapter, service: createLaunchService(store, adapter, () => now * 1000) }
}

/** Quote, pay and run to whatever state the adapter's injected failures leave behind. */
async function launch(context: ReturnType<typeof setup>) {
  const job = quote(context.store, context.adapter, request(), now)
  const result = await runJob(context.store, context.adapter, job.id, await sign(job), () => now * 1000)
  return result
}

/* ------------------------------------------------------------------ admission */

describe('route admission', () => {
  test('refuses a destination this route does not open', () => {
    expect(() => assertRouteRequest(request({ destinations: [
      { chain: 'arc', recipient: payer.address, amount: '1000', poolTokens: '100', poolQuote: '100' },
      { chain: 'base', recipient: payer.address, amount: '1000', poolTokens: '100', poolQuote: '100' },
      { chain: 'solana', recipient: BENEFICIARY, amount: '1000', poolTokens: '100', poolQuote: '100' },
    ] }))).toThrow('opens Arc and Solana only')
  })

  test('refuses a request with no Solana leg, which this adapter exists to fulfil', () => {
    expect(() => assertRouteRequest(request({ destinations: [
      { chain: 'arc', recipient: payer.address, amount: '1000', poolTokens: '100', poolQuote: '100' },
    ] }))).toThrow('select Solana as a destination')
  })

  test('the closed route quotes nothing at all', async () => {
    const { closedSolanaRoute } = await import('../solanaAdapter')
    const closed = closedSolanaRoute()
    expect(() => closed.assertReady(request())).toThrow('No Arc–Solana route is configured')
  })
})

/* ------------------------------------------------------------------ derivations */

describe('deterministic derivations', () => {
  test('an inventory holder and a Solana seed are recoverable from the operation alone', () => {
    const operation = keccak256(toBytes('operation'))
    expect(inventoryHolder(operation)).toBe(`0x${operation.slice(-40)}`)
    expect(inventoryHolder(operation)).toBe(inventoryHolder(operation))
    expect(solanaSeed(operation, 'mint')).toHaveLength(32)
    expect(Buffer.from(solanaSeed(operation, 'mint')).toString('hex')).toBe(Buffer.from(solanaSeed(operation, 'mint')).toString('hex'))
    // Different labels must not collide: the mint and the inventory holder are different accounts.
    expect(Buffer.from(solanaSeed(operation, 'mint')).toString('hex')).not.toBe(Buffer.from(solanaSeed(operation, 'inventory')).toString('hex'))
  })

  test('a step plan is bound to its operation and refuses to be read under another', () => {
    const operation = keccak256(toBytes('one'))
    const bytes = JSON.stringify({ operation, plan: { kind: 'leg', chain: 'arc', operation } })
    expect(decodePlan(operation, bytes).kind).toBe('leg')
    expect(() => decodePlan(keccak256(toBytes('two')), bytes)).toThrow('belongs to a different operation')
    expect(() => decodePlan(operation, 'not json')).toThrow('not readable')
  })
})

/* ------------------------------------------------------------------ the conservation gate */

describe('two-sided conservation', () => {
  test('pending is derived from the job\'s own recorded steps, including the step being completed', async () => {
    const context = setup()
    const job = await launch(context)
    expect(routePending(job)).toEqual({ toSpoke: 0n, toHub: 0n })
    const debited = { ...job, steps: job.steps.map((step) => step.id === 'credit:solana' ? { ...step, state: 'prepared' as const } : step) }
    expect(routePending(debited)).toEqual({ toSpoke: SOL_AMOUNT, toHub: 0n })
    // The step about to be recorded counts as done, because its effect is already on chain.
    expect(routePending(debited, 'credit:solana')).toEqual({ toSpoke: 0n, toHub: 0n })
  })

  test('the gate declares itself inapplicable rather than passing trivially', async () => {
    const context = setup()
    const job = quote(context.store, context.adapter, request(), now)
    expect(ledgerComparable(job)).toBe(false)
    expect(await gateLedger(context.route, job)).toEqual({ compared: false })
  })

  test('a completed launch reconciles across two independently observed ledgers', async () => {
    const context = setup()
    const job = await launch(context)
    expect(job.state).toBe('complete')
    const gate = await gateLedger(context.route, job)
    expect(gate.compared).toBe(true)
    expect(gate.reconciliation).toEqual({ conserved: true, backed: true, custodyClean: true, ok: true })
    expect(gate.observed!.hubCustody).toBe(SOL_AMOUNT)
    expect(gate.observed!.spokeSupply).toBe(SOL_AMOUNT)
  })

  test('a credit that minted more than the hub holds is refused, and the step is not recorded', async () => {
    const context = setup({ route: { overMint: 1n } })
    const job = await launch(context).catch((cause: Error) => cause)
    expect(job).toBeInstanceOf(Error)
    expect((job as Error).message).toContain('do not reconcile')
    const durable = context.store.get(quote(context.store, context.adapter, request(), now).id)!
    expect(durable.steps.find((step) => step.id === 'credit:solana')!.state).not.toBe('complete')
    expect(durable.state).toBe('partial')
    // The over-mint really did happen on the far side; what the gate prevents is recording it as
    // delivered and letting the rest of the launch proceed on top of it.
    expect(reconcileRoute(await context.route.observeLedger(durable, routePending(durable))).ok).toBe(false)
  })
})

/* ------------------------------------------------------------------ the paid path */

describe('the paid HTTP path', () => {
  test('an unpaid request answers 402 with the bound plan and charges nothing', async () => {
    const context = setup()
    const response = await context.service(new Request('http://x/x402/equilibrium', { method: 'POST', body: JSON.stringify(request()) }))
    expect(response.status).toBe(402)
    expect(response.headers.get('PAYMENT-REQUIRED')).toBeTruthy()
    const body = await response.json() as { jobId: Hex; total: string; quoteInventory: string }
    // Eight step budgets (13.000000) plus the two chains' quote inventory (20.666666).
    expect(body.total).toBe('33666666')
    expect(body.quoteInventory).toBe((QUOTE * 2n).toString())
    expect(context.recorded.counts).toEqual({})
  })

  test('a paid request fulfils the launch once and reports settlement separately', async () => {
    const context = setup()
    const job = quote(context.store, context.adapter, request(), now)
    const response = await context.service(new Request('http://x/x402/equilibrium', {
      method: 'POST', body: JSON.stringify(request()), headers: { 'payment-signature': await header(job) },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('payment-response')).toBeTruthy()
    const body = await response.json() as ReturnType<typeof publicJob>
    expect(body.state).toBe('complete')
    expect(body.payment.settled).toBe(true)
    expect(body.payment.fulfillment).toBe('complete')
    expect(body.settlement).not.toBeNull()
    expect(body.supply.reconciled).toBe(true)
    expect(body.supply.custody).toBe(SOL_AMOUNT.toString())
    expect(body.supply.remote).toBe(SOL_AMOUNT.toString())
    expect(context.recorded.counts).toEqual({
      settlement: 1, issuance: 1, 'leg:arc': 1, 'leg:solana': 1, debit: 1, credit: 1, 'inventory:arc': 1, 'inventory:solana': 1,
    })
  })

  test('a conflicting payload under the same requestId is refused before anything is charged', async () => {
    const context = setup()
    const first = await context.service(new Request('http://x/x402/equilibrium', { method: 'POST', body: JSON.stringify(request()) }))
    expect(first.status).toBe(402)
    const conflicting = request()
    conflicting.canonical = { ...conflicting.canonical, symbol: 'OTHER' }
    const second = await context.service(new Request('http://x/x402/equilibrium', { method: 'POST', body: JSON.stringify(conflicting) }))
    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ error: 'identity_conflict' })
    expect(context.recorded.counts).toEqual({})
  })

  test('an authorization signed by another key settles nothing and issues nothing', async () => {
    const context = setup()
    const job = quote(context.store, context.adapter, request(), now)
    const response = await context.service(new Request('http://x/x402/equilibrium', {
      method: 'POST', body: JSON.stringify(request()), headers: { 'payment-signature': await header(job, stranger) },
    }))
    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({ error: 'invalid_payment' })
    expect(context.recorded.settled.size).toBe(0)
    expect(context.recorded.issued.size).toBe(0)
    expect(context.store.get(job.id)!.state).toBe('awaiting_payment')
  })

  test('an authorization for less than the quoted total is refused', async () => {
    const context = setup()
    const job = quote(context.store, context.adapter, request(), now)
    const response = await context.service(new Request('http://x/x402/equilibrium', {
      method: 'POST', body: JSON.stringify(request()), headers: { 'payment-signature': await header(job, payer, { value: (BigInt(job.total) - 1n).toString() }) },
    }))
    expect(response.status).toBe(402)
    expect(context.recorded.counts.settlement).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ replay */

describe('replay', () => {
  test('the identical paid request re-sent changes nothing on either chain', async () => {
    const context = setup()
    const job = quote(context.store, context.adapter, request(), now)
    const paid = { method: 'POST', body: JSON.stringify(request()), headers: { 'payment-signature': await header(job) } }
    const first = await context.service(new Request('http://x/x402/equilibrium', paid))
    expect(first.status).toBe(200)
    const counts = { ...context.recorded.counts }
    const settlement = context.store.get(job.id)!.steps[0].result!.transaction

    for (let attempt = 0; attempt < 3; attempt++) {
      const again = await context.service(new Request('http://x/x402/equilibrium', paid))
      expect(again.status).toBe(200)
    }
    expect(context.recorded.counts).toEqual(counts)
    expect(context.store.get(job.id)!.steps[0].result!.transaction).toBe(settlement)
    expect((await context.route.observeLedger(context.store.get(job.id)!, { toSpoke: 0n, toHub: 0n })).spokeSupply).toBe(SOL_AMOUNT)
  })

  test('the settled authorization resubmitted straight to the asset is refused by the asset', async () => {
    const context = setup()
    const job = await launch(context)
    const step = job.steps[0]
    const plan = await context.route.plan({ job, step })
    await rejects(() => context.route.submit({ job, step }, plan), 'AuthorizationAlreadyUsed')
    expect(context.recorded.counts.settlement).toBe(1)
  })

  test('the issuance factory refuses to rebind an identity it already holds', async () => {
    const context = setup()
    const job = await launch(context)
    const step = job.steps.find((candidate) => candidate.id === 'canonical:arc')!
    const plan = await context.route.plan({ job, step })
    await rejects(() => context.route.submit({ job, step }, { ...plan, symbol: 'OTHER' } as StepPlan), 'Identity conflict')
    expect(context.recorded.counts.issuance).toBe(1)
  })
})

/* ------------------------------------------------------------------ interruption and restart */

describe('interruption and restart', () => {
  test('a credit submitted and not recorded is finished by the unattended sweep, exactly once', async () => {
    const path = journal()
    const interrupted = setup({ path, pending: new Set(['credit:solana']) })
    const job = quote(interrupted.store, interrupted.adapter, request(), now)
    const held = await runJob(interrupted.store, interrupted.adapter, job.id, await sign(job), () => now * 1000)
    expect(held.state).toBe('partial')
    expect(held.sweep).toBe('eligible')
    expect(held.settlement).toBeDefined()
    expect(held.steps.find((step) => step.id === 'credit:solana')!.state).toBe('prepared')
    // The effect landed even though the job does not record it: that is the state being recovered from.
    expect(interrupted.recorded.counts.credit).toBe(1)
    const recordedEffects = interrupted.recorded
    interrupted.store.close()

    // A restart: nothing survives but the journal file.
    const resumed = setup({ path, recorded: recordedEffects })
    const swept = await reconcile(resumed.store, resumed.adapter, () => now * 1000)
    expect(swept).toHaveLength(1)
    const finished = resumed.store.get(job.id)!
    expect(finished.state).toBe('complete')
    expect(recordedEffects.counts.credit).toBe(1)
    expect(recordedEffects.counts.settlement).toBe(1)
    expect(recordedEffects.counts.debit).toBe(1)
    expect((await gateLedger(resumed.route, finished)).reconciliation!.ok).toBe(true)
    resumed.store.close()
  })

  test('a step that could not be submitted blocks the sweep but not an explicit request', async () => {
    const path = journal()
    const failing = setup({ path, unavailable: new Set(['pool:solana']) })
    const job = quote(failing.store, failing.adapter, request(), now)
    await rejects(runJob(failing.store, failing.adapter, job.id, await sign(job), () => now * 1000), 'unavailable on this route')
    const stopped = failing.store.get(job.id)!
    expect(stopped.state).toBe('partial')
    // Nothing went out on that attempt, so repeating it unattended would only repeat the failure.
    expect(stopped.sweep).toBe('blocked')
    expect(await reconcile(failing.store, failing.adapter, () => now * 1000)).toHaveLength(0)
    const effects = failing.recorded
    failing.store.close()

    const recovered = setup({ path, recorded: effects })
    const finished = await runJob(recovered.store, recovered.adapter, job.id, undefined, () => now * 1000)
    expect(finished.state).toBe('complete')
    expect(effects.counts).toMatchObject({ settlement: 1, issuance: 1, debit: 1, credit: 1, 'inventory:solana': 1 })
    recovered.store.close()
  })

  test('a debit published at a sequence other than the recorded one fails closed instead of locking again', async () => {
    const context = setup({ route: { stealSequence: true } })
    const job = quote(context.store, context.adapter, request(), now)
    await rejects(runJob(context.store, context.adapter, job.id, await sign(job), () => now * 1000), 'published at another sequence')
    // One lock happened. The point is that the retry did not add a second.
    expect(context.recorded.counts.debit).toBe(1)
    const durable = context.store.get(job.id)!
    expect(durable.steps.find((step) => step.id === 'debit:solana')!.state).toBe('prepared')
    await rejects(runJob(context.store, context.adapter, job.id, undefined, () => now * 1000), 'published at another sequence')
    expect(context.recorded.counts.debit).toBe(1)
  })

  test('a second worker cannot claim a job another owns, and a stale one cannot record', () => {
    const context = setup()
    const job = quote(context.store, context.adapter, request(), now)
    const owner = context.store.claim(job.id, 'first', now * 1000)
    expect(() => context.store.claim(job.id, 'second', now * 1000)).toThrow('A worker owns this job')
    context.store.save(owner, 'first', now * 1000)
    expect(() => context.store.save({ ...owner, revision: owner.revision - 1 }, 'first', now * 1000)).toThrow('lost its lease or revision')
  })

  test('the adapter refuses to submit bytes that were not the ones persisted', async () => {
    const context = setup()
    const job = quote(context.store, context.adapter, request(), now)
    job.payment = await sign(job)
    const step = job.steps.find((candidate) => candidate.id === 'canonical:arc')!
    const prepared = await context.adapter.prepare({ job, step })
    expect(prepared.operation).toBe(hash([job.id, step.id]))
    await rejects(context.adapter.broadcast({ job, step }, { ...prepared, bytes: `${prepared.bytes} ` }), 'do not match their persisted digest')
    const other = job.steps.find((candidate) => candidate.id === 'manager:arc')!
    await rejects(context.adapter.broadcast({ job, step: other }, prepared), 'not bound to this job step')
    expect(context.recorded.counts).toEqual({})
  })

  test('a persisted plan the route would no longer derive is refused rather than substituted', async () => {
    const context = setup()
    const job = quote(context.store, context.adapter, request(), now)
    job.payment = await sign(job)
    const step = job.steps.find((candidate) => candidate.id === 'canonical:arc')!
    const prepared = await context.adapter.prepare({ job, step })
    const plan = decodePlan(prepared.operation, prepared.bytes)
    const tampered = JSON.stringify({ operation: prepared.operation, plan: { ...plan, symbol: 'OTHER' } })
    await rejects(
      context.adapter.broadcast({ job, step }, { ...prepared, bytes: tampered, digest: hash(tampered) }),
      'differs from the plan this route derives now',
    )
    expect(context.recorded.counts).toEqual({})
  })
})
