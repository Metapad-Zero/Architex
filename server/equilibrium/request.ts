import { isAddress, keccak256, toBytes, type Address, type Hex } from 'viem'
import { CHAINS, LaunchError, type LaunchRequest, type Job, type PromotionalTokenAdapter, type Step, type StepKind } from './types'

const bad = (message: string): never => { throw new LaunchError(400, 'invalid_request', message) }
export const hash = (value: unknown): Hex => keccak256(toBytes(JSON.stringify(value)))
export function atoms(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n || (positive && value === '0')) return bad('Amounts must be canonical unsigned decimal strings, within uint64.')
  return value
}
function text(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) return bad(`Invalid ${label}.`)
  return value
}
function address(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value) || /^0x0+$/.test(value)) return bad('A nonzero EVM address is required.')
  return value.toLowerCase() as Address
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('Expected a JSON object.')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) bad('Unknown request field.')
}
/** Reject unknown fields; normalize order/casing so the SAME intent has exactly one hash. */
export function parseRequest(raw: unknown): LaunchRequest {
  const r = object(raw); keys(r, ['requestId', 'payer', 'canonical', 'destinations', 'quote'])
  const c = object(r.canonical); keys(c, ['chain', 'name', 'symbol', 'decimals', 'issuance', 'recipient'])
  const q = object(r.quote); keys(q, ['expires', 'costCap'])
  if (c.chain !== 'arc' || c.decimals !== 6) return bad('Canonical issuance is on Arc with six decimals.')
  if (!Number.isSafeInteger(q.expires) || (q.expires as number) <= 0) return bad('quote.expires must be Unix seconds.')
  if (!Array.isArray(r.destinations) || r.destinations.length < 1 || r.destinations.length > 4) return bad('Select one to four destinations, including Arc.')
  const destinations = r.destinations.map((rawDestination) => {
    const d = object(rawDestination); keys(d, ['chain', 'recipient', 'amount', 'poolTokens', 'poolQuote'])
    const chain = CHAINS.find((chain) => chain === d.chain)
    if (!chain) return bad('Unknown chain.')
    // Full base58 decoding is checked by the SVM adapter before it can open. Never lowercase SVM addresses.
    const recipient = chain === 'solana' ? text(d.recipient, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Solana recipient') : address(d.recipient)
    const amount = atoms(d.amount, true); const poolTokens = atoms(d.poolTokens, true); const poolQuote = atoms(d.poolQuote, true)
    if (BigInt(poolTokens) > BigInt(amount)) return bad('Pool token inventory exceeds the chain allocation.')
    return { chain, recipient, amount, poolTokens, poolQuote }
  }).sort((a, b) => CHAINS.indexOf(a.chain) - CHAINS.indexOf(b.chain))
  if (new Set(destinations.map((d) => d.chain)).size !== destinations.length || destinations[0].chain !== 'arc') return bad('Destinations must be unique and include Arc.')
  const issuance = atoms(c.issuance, true)
  if (destinations.reduce((n, d) => n + BigInt(d.amount), 0n) > BigInt(issuance)) return bad('Allocations exceed the canonical issuance.')
  return {
    requestId: text(r.requestId, /^[a-zA-Z0-9_-]{8,80}$/, 'requestId'), payer: address(r.payer),
    canonical: { chain: 'arc', name: text(c.name, /^[^\x00-\x1f]{1,32}$/u, 'name'), symbol: text(c.symbol, /^[A-Z0-9]{1,10}$/, 'symbol'), decimals: 6, issuance, recipient: address(c.recipient) },
    destinations, quote: { expires: q.expires as number, costCap: atoms(q.costCap, true) },
  }
}
export function identity(request: LaunchRequest): Hex { return hash([request.payer, request.requestId]) }
export function createJob(request: LaunchRequest, adapter: PromotionalTokenAdapter, now: number): Job {
  adapter.assertReady(request)
  if (request.quote.expires <= now || request.quote.expires > now + 300) throw new LaunchError(409, 'quote_expired', 'New quotes must expire within the next 300 seconds.')
  const budgets = adapter.budgets(request)
  const steps: Step[] = []
  function add(kind: StepKind, chain: typeof CHAINS[number]) {
    steps.push({ id: `${kind}:${chain}`, kind, chain, budget: atoms(budgets[kind]), state: 'planned' })
  }
  add('payment', 'arc'); add('canonical', 'arc'); add('manager', 'arc'); add('pool', 'arc')
  for (const d of request.destinations.filter((d) => d.chain !== 'arc')) {
    add('manager', d.chain); add('debit', d.chain); add('credit', d.chain); add('pool', d.chain)
  }
  // Quote inventory is principal, separately identified from deployment/network costs.
  const total = (steps.reduce((n, s) => n + BigInt(s.budget), 0n) + request.destinations.reduce((n, d) => n + BigInt(d.poolQuote), 0n)).toString()
  if (BigInt(total) > BigInt(request.quote.costCap)) throw new LaunchError(409, 'cost_cap', 'Quoted fees plus quote inventory exceed the payer cost cap.')
  const terms = { ...adapter.terms }
  // Domain, route plan, destinations, cap, expiry and payer are all bound to the EIP-3009 nonce.
  const id = hash({ version: 1, mode: adapter.mode, adapterVersion: adapter.version, request, terms, steps, total })
  return { id, identity: identity(request), mode: adapter.mode, adapterVersion: adapter.version, request, terms, total, steps, state: 'awaiting_payment', revision: 0, createdAt: now }
}
