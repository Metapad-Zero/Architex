import { encodePaymentSignatureHeader } from '@x402/core/http'
import { privateKeyToAccount } from 'viem/accounts'
import { AUTHORIZATION_TYPES, paymentDomain, paymentRequirements } from '../payment'
import type { Job, LaunchRequest, SignedPayment } from '../types'

// A local test key, never used on a public chain or bundled into the frontend.
export const account = privateKeyToAccount('0x0000000000000000000000000000000000000000000000000000000000000123')
export function fixture(now = Math.floor(Date.now() / 1000)): LaunchRequest {
  return { requestId: 'rehearsal-0001', payer: account.address.toLowerCase() as typeof account.address,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient: account.address },
    destinations: [
      { chain: 'arc', recipient: account.address, amount: '500000000000', poolTokens: '1000000000', poolQuote: '10000000' },
      { chain: 'base', recipient: account.address, amount: '500000000000', poolTokens: '1000000000', poolQuote: '10000000' },
    ], quote: { expires: now + 240, costCap: '100000000' } }
}
export async function sign(job: Job): Promise<SignedPayment> {
  const authorization = { from: job.request.payer, to: job.terms.payTo, value: job.total, validAfter: '0', validBefore: String(job.request.quote.expires), nonce: job.id }
  const signature = await account.signTypedData({ domain: paymentDomain(job), types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) } })
  return { authorization, signature }
}
export async function header(job: Job) {
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: paymentRequirements(job), payload: await sign(job) as unknown as Record<string, unknown> })
}
