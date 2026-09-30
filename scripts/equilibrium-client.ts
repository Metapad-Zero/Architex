/**
 * EQUILIBRIUM launch client: template, free quote, authorized local launch, status.
 *
 * LOCAL REHEARSAL ONLY for anything that signs. A launch is refused unless the service is on
 * loopback, reports `mode: local`, and quotes the synthetic chain 31337 asset. The signature is an
 * EIP-3009 authorization bound to that synthetic domain, so it cannot move funds anywhere else.
 * Quotes and status reads are free and never sign.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { fulfillment, recoveryNote, supplyNote, supplyWithheld, usdcAmount as usdc, type PublicJob } from '../src/lib/equilibriumRecord'

export const DEFAULT_SERVER = 'http://127.0.0.1:4042'
/** The only payment domain this client will sign for: the local rehearsal's synthetic USDC. */
export const LOCAL_TERMS = { chainId: 31337, network: 'eip155:31337', asset: '0x0000000000000000000000000000000000003009' } as const
const AUTHORIZATION_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const

/** The fields the client reads from a request file. The service validates the rest strictly. */
type LaunchRequestFile = { payer: string; quote: { expires: number; costCap: string } }

export class ClientError extends Error {
  constructor(public code: string, message: string, public status?: number) { super(message) }
}
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** The free 402 body: bound payment terms plus the plan they pay for. */
export interface Quote {
  jobId: Hex
  mode: string
  total: string
  quoteInventory: string
  steps: { id: string; budget: string }[]
  accepts: PaymentRequirements[]
}
export interface LaunchResult { status: number; job: PublicJob; settlement: ReturnType<typeof decodePaymentResponseHeader> | null }

export { usdc }

export function isLoopback(server: string): boolean {
  try {
    const url = new URL(server)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch { return false }
}

/** A request with a fresh expiry, in the strict shape the service accepts. Amounts are six-decimal atoms. */
export function template(payer: string, options: { requestId?: string; now?: number } = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  return {
    requestId: options.requestId ?? `launch-${now}`, payer: payer.toLowerCase(),
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient: payer },
    destinations: [
      { chain: 'arc', recipient: payer, amount: '500000000000', poolTokens: '1000000000', poolQuote: '10000000' },
      { chain: 'base', recipient: payer, amount: '500000000000', poolTokens: '1000000000', poolQuote: '10000000' },
    ],
    quote: { expires: now + 240, costCap: '100000000' },
  }
}

async function errorOf(response: Response): Promise<ClientError> {
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string }
  const code = body.error ?? `http_${response.status}`
  const advice: Record<string, string> = {
    identity_conflict: 'This requestId is already bound to a different payload. Read the existing job, or use a new requestId for a new launch.',
    quote_expired: 'The unpaid quote expired and nothing was charged. Refresh quote.expires and use a new requestId.',
    reconciliation_required: 'An external step has an unknown result. Do not sign again: read the job status; the service resumes it.',
    route_closed: 'A requested chain is closed in this mode. The local rehearsal enables Arc and Base only.',
    integration_closed: 'Paid launches are closed on this service.',
    cost_cap: 'The quote exceeds quote.costCap. Raise the cap deliberately or reduce the plan.',
  }
  // Known codes carry their own recovery advice; otherwise pass the service message through.
  return new ClientError(code, advice[code] ?? body.message ?? `HTTP ${response.status}`, response.status)
}

/** Free: POST without a signature returns the bound 402 terms. Nothing is signed or charged. */
export async function quote(server: string, request: unknown, fetcher: Fetch = fetch): Promise<Quote> {
  const response = await fetcher(`${server}/x402/equilibrium`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })
  if (response.status === 402) return await response.json() as Quote
  // A job that already holds an authorization answers with its record instead of new terms.
  if (response.ok) throw new ClientError('already_authorized', 'This requestId already holds an authorization. Read its status; resending the same request resumes it without charging again.', response.status)
  throw await errorOf(response)
}

/**
 * Refuse to sign anything that is not the local rehearsal, that exceeds either cap, that has expired,
 * or whose nonce is not the job hash. The nonce binds the signature to exactly this plan.
 */
export function checkTerms(q: Quote, request: LaunchRequestFile, maxTotal: string, now: number): PaymentRequirements {
  const terms = q.accepts?.[0]
  if (!terms) throw new ClientError('no_terms', 'The service offered no payment terms.')
  if (q.mode !== 'local' || terms.network !== LOCAL_TERMS.network || terms.asset.toLowerCase() !== LOCAL_TERMS.asset) {
    throw new ClientError('not_local', `Refusing to sign: the service reports mode ${q.mode} on ${terms.network}. This client authorizes the local synthetic rehearsal only.`)
  }
  if (terms.amount !== q.total) throw new ClientError('terms_mismatch', 'The payment amount differs from the quoted total.')
  if (BigInt(q.total) > BigInt(request.quote.costCap)) throw new ClientError('cost_cap', 'The quoted total exceeds your cost cap.')
  if (BigInt(q.total) > BigInt(maxTotal)) throw new ClientError('max_total', `The quoted total ${usdc(q.total)} exceeds --max-total ${usdc(maxTotal)}.`)
  if (terms.extra?.authorizationNonce !== q.jobId) throw new ClientError('nonce_unbound', 'The authorization nonce must be the job hash; refusing a random or missing nonce.')
  if (now >= request.quote.expires) throw new ClientError('quote_expired', 'The quote expired before signing. Nothing was charged; start again with a new requestId.')
  return terms
}

/** Sign the EIP-3009 authorization with the job hash as nonce, exactly as the service verifies it. */
export async function authorize(q: Quote, terms: PaymentRequirements, request: { payer: string; quote: { expires: number } }, key: Hex): Promise<string> {
  const account = privateKeyToAccount(key)
  if (account.address.toLowerCase() !== request.payer.toLowerCase()) throw new ClientError('payer_mismatch', `The signing key is ${account.address}, not the request payer ${request.payer}.`)
  const authorization = { from: request.payer, to: terms.payTo.toLowerCase(), value: q.total, validAfter: '0', validBefore: String(request.quote.expires), nonce: q.jobId }
  const signature = await account.signTypedData({
    domain: { name: String(terms.extra?.name), version: String(terms.extra?.version), chainId: LOCAL_TERMS.chainId, verifyingContract: terms.asset as Hex },
    types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
    message: { from: authorization.from as Hex, to: authorization.to as Hex, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
  })
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: terms, payload: { authorization, signature } })
}

/**
 * Quote, check, sign, submit. Resending the identical request resumes the same job: the service
 * returns its record without new terms, so this never signs twice for one requestId.
 */
export async function launch(server: string, request: LaunchRequestFile, key: Hex, maxTotal: string, fetcher: Fetch = fetch, now = Math.floor(Date.now() / 1000)): Promise<LaunchResult> {
  if (!isLoopback(server)) throw new ClientError('not_local', 'Refusing to sign for a non-loopback service. Public paid routes are closed.')
  const post = (headers: Record<string, string> = {}) => fetcher(`${server}/x402/equilibrium`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(request) })
  const first = await post()
  let response = first
  if (first.status === 402) {
    const q = await first.json() as Quote
    const terms = checkTerms(q, request, maxTotal, now)
    response = await post({ 'payment-signature': await authorize(q, terms, request, key) })
  }
  if (response.status !== 200 && response.status !== 202) throw await errorOf(response)
  const header = response.headers.get('payment-response')
  return { status: response.status, job: await response.json() as LaunchResult['job'], settlement: header ? decodePaymentResponseHeader(header) : null }
}

/** Free record read. */
export async function status(server: string, jobId: string, fetcher: Fetch = fetch) {
  const response = await fetcher(`${server}/equilibrium/jobs/${encodeURIComponent(jobId)}`)
  if (!response.ok) throw await errorOf(response)
  return (await response.json() as { jobs: PublicJob[] }).jobs[0]
}

/** One line per fact a person needs: settlement and fulfillment stated apart, synthetic money labeled. */
export function describe(job: PublicJob): string[] {
  const unit = job.mode === 'local' ? 'synthetic USDC' : 'USDC'
  const lines = [`job ${job.id} · mode ${job.mode}${job.mode === 'local' ? ' (synthetic payment and addresses)' : ''} · state ${job.state}`]
  lines.push(job.settlement ? `settlement: ${usdc(job.settlement.amount)} ${unit} (${job.settlement.amount} atoms) in ${job.settlement.transaction}` : `settlement: ${job.payment?.settled ? 'settled, no separate settlement record (older job)' : 'none'}`)
  lines.push(`fulfillment: ${fulfillment(job) === 'not_started' ? 'not started' : fulfillment(job)}${job.error ? ` · last attempt: ${job.error}` : ''}`)
  lines.push(`recovery: ${recoveryNote(job)}`)
  const funds = job.funds
  if (funds) lines.push(`funds: fee ${usdc(funds.platformFee ?? '0')} · execution ${usdc(funds.feesSpent ?? '0')} · pool quote ${usdc(funds.quoteInventoryDeployed ?? '0')} · held ${usdc(funds.unallocatedHeld ?? '0')} ${unit}${funds.determinate === undefined ? ' (older record: finality not reported)' : funds.determinate ? '' : ' (not final: operations outstanding)'}`)
  lines.push(supplyWithheld(job) ? `supply: ${supplyNote(job)}` : `supply: issuance ${job.supply.issuance ?? 'withheld'} · custody ${job.supply.custody ?? 'withheld'} · remote ${job.supply.remote ?? 'withheld'} · pending ${job.supply.pending ?? 'withheld'} atoms. ${supplyNote(job)}`)
  lines.push(`steps: ${job.steps.map((s) => `${s.id}=${s.state}`).join(' ')}`)
  return lines
}

const USAGE = `EQUILIBRIUM client (local rehearsal)

  bun run equilibrium:client init --payer <0xaddress> [--out request.json]
  bun run equilibrium:client quote --request request.json            free; signs nothing
  bun run equilibrium:client launch --request request.json --max-total <atoms> --yes
                                                                      signs with EQUILIBRIUM_LOCAL_KEY; loopback + mode local only
  bun run equilibrium:client status <jobId>                           free

  --server <url>   default ${DEFAULT_SERVER}   --json   print the raw record`

async function main(argv: string[]) {
  const [command, ...rest] = argv
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
  const server = flag('--server') ?? DEFAULT_SERVER
  const json = rest.includes('--json')
  const readRequest = () => {
    const path = flag('--request')
    if (!path) throw new ClientError('usage', 'Pass --request <file>. Create one with init.')
    return JSON.parse(readFileSync(path, 'utf8')) as LaunchRequestFile
  }
  const print = (job: PublicJob) => console.log(json ? JSON.stringify(job, null, 2) : describe(job).join('\n'))
  if (command === 'init') {
    const payer = flag('--payer') ?? (process.env.EQUILIBRIUM_LOCAL_KEY ? privateKeyToAccount(process.env.EQUILIBRIUM_LOCAL_KEY as Hex).address : undefined)
    if (!payer) throw new ClientError('usage', 'Pass --payer <address>, or set EQUILIBRIUM_LOCAL_KEY.')
    const body = JSON.stringify(template(payer), null, 2) + '\n'
    const out = flag('--out')
    if (out) { writeFileSync(out, body); console.log(`Wrote ${out}. The quote expires in 240 s; run quote next.`) } else process.stdout.write(body)
  } else if (command === 'quote') {
    const q = await quote(server, readRequest())
    if (json) { console.log(JSON.stringify(q, null, 2)); return }
    const unit = q.mode === 'local' ? 'synthetic USDC' : 'USDC'
    console.log([`job ${q.jobId} · mode ${q.mode} · nothing signed or charged`,
      `total ${usdc(q.total)} ${unit} (${q.total} atoms), of which pool quote inventory ${usdc(q.quoteInventory)} ${unit}`,
      `pay to ${q.accepts[0].payTo} on ${q.accepts[0].network} · expires ${new Date(Number(q.accepts[0].extra?.quoteExpires) * 1000).toISOString()}`,
      `steps: ${q.steps.map((s) => `${s.id} ${usdc(s.budget)}`).join(' · ')}`,
      'Settlement pays for the plan; it does not mean the launch is fulfilled. Launch with --max-total and --yes to authorize.'].join('\n'))
  } else if (command === 'launch') {
    if (!rest.includes('--yes')) throw new ClientError('usage', 'Review the free quote first, then pass --yes to authorize.')
    const maxTotal = flag('--max-total')
    if (!maxTotal || !/^[1-9]\d*$/.test(maxTotal)) throw new ClientError('usage', 'Pass --max-total <atoms>: the most you authorize, in six-decimal atoms.')
    const key = process.env.EQUILIBRIUM_LOCAL_KEY
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new ClientError('usage', 'Set EQUILIBRIUM_LOCAL_KEY to a local test key. It signs only for the synthetic chain 31337 domain.')
    const result = await launch(server, readRequest(), key as Hex, maxTotal)
    print(result.job)
    if (!json) console.log(result.status === 200 ? 'HTTP 200: fulfilled.' : 'HTTP 202: authorization held or settled. Read status and recovery eligibility before resuming. Resending the same request never charges again.')
    if (!json && result.settlement) console.log(`payment-response: settlement ${result.settlement.transaction} on ${result.settlement.network} (settlement only)`)
  } else if (command === 'status') {
    const id = rest.find((a) => !a.startsWith('--') && a !== flag('--server'))
    if (!id) throw new ClientError('usage', 'Pass the job id.')
    print(await status(server, id))
  } else { console.log(USAGE); if (command && command !== 'help') process.exitCode = 2 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((cause) => {
    const error = cause instanceof ClientError ? cause : new ClientError('unreachable', cause instanceof Error ? `${cause.message}. Is the service running? bun run equilibrium:server` : 'Request failed.')
    console.error(`${error.code}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`)
    process.exitCode = 1
  })
}
