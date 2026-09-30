/**
 * Quote and, with --yes, authorize one launch against a loopback EVM launch service (fork or
 * approved testnet). Signs an EIP-3009 authorization with EQUILIBRIUM_PAYER_KEY for exactly the
 * quoted total, bound to the job hash as nonce, and refuses anything above --max-total.
 *   bun run equilibrium:evm-launch --request request.json [--server http://127.0.0.1:4043] [--max-total <atoms> --yes]
 */
import { readFileSync } from 'node:fs'
import { encodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'

const flags = process.argv.slice(2)
const flag = (name: string) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined)
const server = flag('--server') ?? 'http://127.0.0.1:4043'
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(server)) throw new Error('The launch service must be on loopback.')
const body = readFileSync(flag('--request') ?? 'request.json', 'utf8')
const request = JSON.parse(body) as { payer: string; quote: { expires: number; costCap: string } }
const post = (headers: Record<string, string> = {}) => fetch(`${server}/x402/equilibrium`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
const first = await post()
if (first.status !== 402) { console.log(first.status, await first.text()); process.exit(first.ok ? 0 : 1) }
const quote = await first.json() as { jobId: Hex; mode: string; total: string; accepts: PaymentRequirements[] }
const terms = quote.accepts[0]
console.log(JSON.stringify({ job: quote.jobId, mode: quote.mode, total: quote.total, network: terms.network, asset: terms.asset, payTo: terms.payTo }))
if (!flags.includes('--yes')) { console.log('Free quote only. Nothing signed. Re-run with --max-total <atoms> --yes to authorize.'); process.exit(0) }
if (!['fork', 'testnet'].includes(quote.mode)) throw new Error(`Refusing to sign for mode ${quote.mode}.`)
const maxTotal = flag('--max-total')
if (!maxTotal || BigInt(quote.total) > BigInt(maxTotal) || BigInt(quote.total) > BigInt(request.quote.costCap)) throw new Error('The quoted total exceeds --max-total or the request cost cap.')
if (terms.extra?.authorizationNonce !== quote.jobId || terms.amount !== quote.total) throw new Error('Terms are not bound to this job.')
const key = process.env.EQUILIBRIUM_PAYER_KEY as Hex | undefined
if (!key) throw new Error('EQUILIBRIUM_PAYER_KEY is required to authorize.')
const account = privateKeyToAccount(key)
if (account.address.toLowerCase() !== request.payer.toLowerCase()) throw new Error('The payer key is not the request payer.')
const authorization = { from: request.payer, to: terms.payTo, value: quote.total, validAfter: '0', validBefore: String(request.quote.expires), nonce: quote.jobId }
const signature = await account.signTypedData({
  domain: { name: String(terms.extra?.name), version: String(terms.extra?.version), chainId: Number(terms.network.split(':')[1]), verifyingContract: terms.asset as Address },
  types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
  primaryType: 'TransferWithAuthorization',
  message: { from: authorization.from as Address, to: authorization.to as Address, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce },
})
const paid = await post({ 'payment-signature': encodePaymentSignatureHeader({ x402Version: 2, accepted: terms, payload: { authorization, signature } }) })
const record = await paid.json() as { state?: string; error?: string; steps?: { id: string; state: string }[] }
console.log(paid.status, JSON.stringify({ state: record.state, error: record.error, steps: record.steps?.map((s) => `${s.id}=${s.state}`) }))
