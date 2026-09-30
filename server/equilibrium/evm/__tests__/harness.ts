import { encodePaymentSignatureHeader } from '@x402/core/http'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { AUTHORIZATION_TYPES, paymentDomain, paymentRequirements } from '../../payment'
import type { Job, LaunchRequest } from '../../types'
import { DEV } from '../fork'

export const payer = privateKeyToAccount(DEV.payer)
/** A two-chain request paying the Arc executor, in the strict shape the service accepts. */
export function request(requestId: string, now: number, recipient: Address = '0x00000000000000000000000000000000000000a1'): LaunchRequest {
  return { requestId, payer: payer.address.toLowerCase() as Address,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient },
    destinations: [
      { chain: 'arc', recipient, amount: '500000000000', poolTokens: '5000000000', poolQuote: '10000000' },
      { chain: 'base', recipient, amount: '10000000000', poolTokens: '5000000000', poolQuote: '10000000' },
    ], quote: { expires: now + 240, costCap: '100000000' } }
}
export async function signedHeader(job: Job) {
  const authorization = { from: job.request.payer, to: job.terms.payTo, value: job.total, validAfter: '0', validBefore: String(job.request.quote.expires), nonce: job.id }
  const signature = await payer.signTypedData({ domain: paymentDomain(job), types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) } })
  return encodePaymentSignatureHeader({ x402Version: 2, accepted: paymentRequirements(job), payload: { authorization, signature } })
}

export async function signedPayment(job: Job) {
  const authorization = { from: job.request.payer, to: job.terms.payTo, value: job.total, validAfter: '0', validBefore: String(job.request.quote.expires), nonce: job.id }
  const signature = await payer.signTypedData({ domain: paymentDomain(job), types: AUTHORIZATION_TYPES, primaryType: 'TransferWithAuthorization',
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) } })
  return { authorization, signature }
}
