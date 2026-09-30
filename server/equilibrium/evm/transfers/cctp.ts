import { concat, decodeEventLog, hexToBigInt, hexToNumber, keccak256, numberToHex, pad, parseAbi, slice, type Address, type Hex, type Log } from 'viem'
import { sign } from 'viem/accounts'
import type { EvmChain } from './types'

/**
 * Circle CCTP V2, as deployed. Addresses from developers.circle.com (CCTP contract addresses,
 * testnet) and docs.arc.io, confirmed by reads on both chains at latest and at the pinned fork
 * blocks (Arc 64,824,600; Base Sepolia 47,513,000) on 2026-09-30: code present, local domains 26
 * and 6, version 1, each TokenMessengerV2 registered as the other's remote, each USDC mapped to the
 * other's, two enabled attesters, threshold 2, not paused. `bun run equilibrium:refill-verify`
 * repeats those reads.
 */
export interface CctpChain { domain: number; tokenMessenger: Address; messageTransmitter: Address; tokenMinter: Address; usdc: Address }
export const CCTP_TESTNET: Record<EvmChain, CctpChain> = {
  arc: { domain: 26, tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', tokenMinter: '0xb43db544E2c27092c107639Ad201b3dEfAbcF192', usdc: '0x3600000000000000000000000000000000000000' },
  base: { domain: 6, tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA', messageTransmitter: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275', tokenMinter: '0xb43db544E2c27092c107639Ad201b3dEfAbcF192', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
}
/** Circle's two V2 attesters on both testnets, as published by Iris /v2/publicKeys and enabled on-chain. */
export const TESTNET_ATTESTERS = ['0x49fD63506E0D88E07511aD95bAe7B2A31aF98b28', '0x8867a67cDa4BC788C6E819BaeaEc60b867865287'] as const
/** Standard transfer: attested at hard finality, no fee. Fast (1000) is never used by this route. */
export const STANDARD = 2000

export const tokenMessengerAbi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
  'function localMessageTransmitter() view returns (address)',
  'function localMinter() view returns (address)',
  'function remoteTokenMessengers(uint32 domain) view returns (bytes32)',
  'function messageBodyVersion() view returns (uint32)',
])
export const messageTransmitterAbi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
  'function localDomain() view returns (uint32)',
  'function version() view returns (uint32)',
  'function getNumEnabledAttesters() view returns (uint256)',
  'function getEnabledAttester(uint256 index) view returns (address)',
  'function signatureThreshold() view returns (uint256)',
  'function paused() view returns (bool)',
  'function usedNonces(bytes32 nonce) view returns (uint256)',
  'event MessageSent(bytes message)',
])
export const tokenMinterAbi = parseAbi([
  'function burnLimitsPerMessage(address token) view returns (uint256)',
  'function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) view returns (address)',
])

/** MessageV2 with a BurnMessageV2 body (circlefin/evm-cctp-contracts src/messages/v2). */
export interface BurnMessage {
  version: number
  sourceDomain: number
  destinationDomain: number
  nonce: Hex
  sender: Hex
  recipient: Hex
  destinationCaller: Hex
  minFinalityThreshold: number
  finalityThresholdExecuted: number
  body: { version: number; burnToken: Hex; mintRecipient: Hex; amount: bigint; messageSender: Hex; maxFee: bigint; feeExecuted: bigint; expirationBlock: bigint; hookData: Hex }
}
export function parseMessage(message: Hex): BurnMessage {
  const at = (offset: number, size: number) => slice(message, offset, offset + size, { strict: true })
  const b = (offset: number, size: number) => at(148 + offset, size)
  if ((message.length - 2) / 2 < 148 + 228) throw new Error('Message too short for a burn message')
  return {
    version: hexToNumber(at(0, 4)), sourceDomain: hexToNumber(at(4, 4)), destinationDomain: hexToNumber(at(8, 4)), nonce: at(12, 32), sender: at(44, 32), recipient: at(76, 32),
    destinationCaller: at(108, 32), minFinalityThreshold: hexToNumber(at(140, 4)), finalityThresholdExecuted: hexToNumber(at(144, 4)),
    body: { version: hexToNumber(b(0, 4)), burnToken: b(4, 32), mintRecipient: b(36, 32), amount: hexToBigInt(b(68, 32)), messageSender: b(100, 32), maxFee: hexToBigInt(b(132, 32)),
      feeExecuted: hexToBigInt(b(164, 32)), expirationBlock: hexToBigInt(b(196, 32)), hookData: (message.length - 2) / 2 > 148 + 228 ? slice(message, 148 + 228) : '0x' },
  }
}

/**
 * The attester may only fill the fields the source leaves empty: the nonce, the finality it attested
 * at, the fee it charged and an expiry. Everything the burn decided must be byte-identical.
 */
export function assertAttestedFrom(emitted: Hex, attested: Hex) {
  const e = parseMessage(emitted); const a = parseMessage(attested)
  const fixed = (m: BurnMessage) => JSON.stringify({ ...m, nonce: 0, finalityThresholdExecuted: 0, body: { ...m.body, feeExecuted: 0, expirationBlock: 0 } }, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
  if (fixed(e) !== fixed(a) || emitted.length !== attested.length) throw new Error('The attested message differs from the finalized burn')
  if (/^0x0+$/.test(a.nonce)) throw new Error('The attested message carries no nonce')
  if (a.finalityThresholdExecuted < STANDARD) throw new Error('The attestation is not at hard finality')
  if (a.body.feeExecuted > a.body.maxFee) throw new Error('The attested fee exceeds the burn\'s maximum')
}

export function messagesSent(logs: Log[], transmitter: Address): Hex[] {
  return logs.filter((l) => l.address.toLowerCase() === transmitter.toLowerCase()).flatMap((l) => {
    try {
      const e = decodeEventLog({ abi: messageTransmitterAbi, data: l.data, topics: l.topics })
      return e.eventName === 'MessageSent' ? [e.args.message] : []
    } catch { return [] }
  })
}

/** Where attested messages come from. `null` means not attested yet: pending, not absent. */
export interface AttestationSource {
  readonly kind: 'iris' | 'local-attester'
  attested(burn: { sourceDomain: number; transaction: Hex; message: Hex }): Promise<{ message: Hex; attestation: Hex } | null>
}

/** Circle's attestation service. The testnet sandbox is https://iris-api-sandbox.circle.com. */
export function iris(api: string, fetcher: typeof fetch = fetch): AttestationSource {
  return {
    kind: 'iris',
    async attested({ sourceDomain, transaction, message }) {
      const response = await fetcher(`${api}/v2/messages/${sourceDomain}?transactionHash=${transaction}`)
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Iris ${response.status}`)
      const json = await response.json() as { messages?: { message?: string; attestation?: string; status?: string }[] }
      // One burn transaction may carry several messages; take the one this burn emitted.
      const matches = (json.messages ?? []).filter((m) => m.message && m.message !== '0x' && (() => { try { assertAttestedFrom(message, m.message as Hex); return true } catch { return false } })())
      const done = matches.find((m) => m.status === 'complete' && m.attestation && /^0x[0-9a-fA-F]+$/.test(m.attestation))
      return done ? { message: done.message as Hex, attestation: done.attestation as Hex } : null
    },
  }
}

/**
 * FORK ONLY. Stands in for Iris with one local attester key the fork harness wrote into the
 * destination MessageTransmitterV2. It fills the fields Iris fills (a nonzero nonce, hard finality,
 * zero fee) and signs keccak256(message) exactly as the real attesters do. The destination's
 * signature check, destination-caller check and nonce replay protection are the real contract's.
 */
export function localAttester(privateKey: Hex): AttestationSource {
  return {
    kind: 'local-attester',
    async attested({ transaction, message }) {
      const nonce = keccak256(concat([transaction, message]))
      const filled = concat([slice(message, 0, 12), nonce, slice(message, 44, 144), numberToHex(STANDARD, { size: 4 }), slice(message, 148)])
      const signature = await sign({ hash: keccak256(filled), privateKey })
      return { message: filled, attestation: concat([signature.r, signature.s, numberToHex(Number(signature.v ?? 27n), { size: 1 })]) }
    },
  }
}
export const bytes32 = (address: Address): Hex => pad(address.toLowerCase() as Hex, { size: 32 })
