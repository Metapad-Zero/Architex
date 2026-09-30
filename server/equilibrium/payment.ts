import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import { verifyTypedData } from 'viem'
import { LaunchError, type Job, type SignedPayment } from './types'

export const AUTHORIZATION_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const
export function paymentDomain(job: Job) { return { name: job.terms.name, version: job.terms.version, chainId: job.terms.chainId, verifyingContract: job.terms.asset } }
export function paymentRequirements(job: Job): PaymentRequirements {
  return { scheme: 'exact', network: `eip155:${job.terms.chainId}`, asset: job.terms.asset, amount: job.total, payTo: job.terms.payTo, maxTimeoutSeconds: 300,
    extra: { name: job.terms.name, version: job.terms.version, requestHash: job.id, authorizationNonce: job.id, quoteExpires: job.request.quote.expires, mode: job.mode } }
}
export function required(job: Job, url: string): Response {
  const body = { x402Version: 2, error: 'Payment authorization required. Settlement and fulfillment are separate.', resource: { url, description: 'Recoverable shared-supply launch job', mimeType: 'application/json' }, accepts: [paymentRequirements(job)] }
  return Response.json({ ...body, jobId: job.id, mode: job.mode, total: job.total, quoteInventory: job.request.destinations.reduce((n, d) => n + BigInt(d.poolQuote), 0n).toString(), steps: job.steps.map(({ id, budget }) => ({ id, budget })) },
    { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(body), 'cache-control': 'no-store' } })
}
/** Validate cryptographic authorization AND every signed term, not merely the presence of a header. */
export async function verifyPayment(header: string, job: Job, now: number): Promise<SignedPayment> {
  try {
    if (header.length > 12_000) throw new Error('Oversized header')
    const decoded = decodePaymentSignatureHeader(header)
    const expected = paymentRequirements(job)
    if (decoded.x402Version !== 2 || decoded.accepted.scheme !== expected.scheme || decoded.accepted.network !== expected.network
      || decoded.accepted.asset.toLowerCase() !== expected.asset.toLowerCase() || decoded.accepted.payTo.toLowerCase() !== expected.payTo.toLowerCase() || decoded.accepted.amount !== expected.amount) throw new Error('Payment terms differ')
    const payment = decoded.payload as unknown as SignedPayment
    const a = payment.authorization
    if (!a || a.from.toLowerCase() !== job.request.payer || a.to.toLowerCase() !== job.terms.payTo.toLowerCase()
      || a.nonce !== job.id || a.value !== job.total || a.validAfter !== '0' || a.validBefore !== String(job.request.quote.expires) || !/^0x[0-9a-fA-F]{130}$/.test(payment.signature)) throw new Error('Authorization is not bound to this job')
    if (now >= job.request.quote.expires) throw new LaunchError(409, 'quote_expired', 'The unpaid quote expired. Use a new requestId for a new quote.')
    const valid = await verifyTypedData({ address: job.request.payer, domain: paymentDomain(job), types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: 0n, validBefore: BigInt(a.validBefore), nonce: a.nonce }, signature: payment.signature })
    if (!valid) throw new Error('Invalid signature')
    return payment
  } catch (cause) {
    if (cause instanceof LaunchError) throw cause
    throw new LaunchError(402, 'invalid_payment', 'Payment must be signed by the bound payer with the quoted amount, destination, nonce and expiry.')
  }
}
