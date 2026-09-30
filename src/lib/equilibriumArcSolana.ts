/**
 * The bytes and the arithmetic that join the Arc hub to the Solana spoke.
 *
 * `equilibriumSolana.ts` covers one side: the SVM wire codec, PDAs and a spoke-only reconciliation
 * whose hub figures have to be supplied by the caller. This module covers the join — reading a
 * message out of whichever environment published it, and reconciling two independently observed
 * ledgers instead of one observed ledger and one calculation.
 *
 * Pure functions over bytes and numbers. Nothing here opens a socket, signs, pays a fee or
 * broadcasts; `scripts/solana/integrate.ts` drives the actual contracts and programs and
 * `docs/EQUILIBRIUM-ARC-SOLANA.md` records what that run does and does not prove.
 */
import { PublicKey } from '@solana/web3.js'
import { encodeAbiParameters, keccak256, pad, type Hex } from 'viem'

/* ------------------------------------------------------------------ address conversions */

/** Wormhole's 32-byte address format: an EVM address is right-aligned and zero-padded. */
export function evmToWormholeFormat(address: Hex): Uint8Array {
  return Buffer.from(pad(address, { size: 32 }).slice(2), 'hex')
}
/**
 * The inverse, which only exists for addresses that really are EVM addresses. A 32-byte Solana
 * pubkey has no EVM form, so the twelve leading bytes are required to be zero rather than
 * truncated away: silently dropping them is how a transfer gets addressed to the wrong account.
 */
export function wormholeFormatToEvm(address: Uint8Array): Hex {
  if (address.length !== 32) throw new Error('A Wormhole-format address is 32 bytes.')
  if (address.subarray(0, 12).some((byte) => byte !== 0)) {
    throw new Error('This 32-byte address does not fit an EVM address; it is not left-padded.')
  }
  return `0x${Buffer.from(address.subarray(12)).toString('hex')}`
}

/* ------------------------------------------------------------------ guardian set substitution */

/**
 * Storage slots of a Wormhole core bridge guardian set, mirroring `WormholeSimulator`'s
 * `overrideToDevnetGuardian` so the same substitution can be made over an Anvil RPC instead of a
 * forge cheatcode.
 *
 * `getGuardianSet` reads `mapping(uint32 => GuardianSet) guardianSets` at slot 2, and
 * `GuardianSet { address[] keys; uint32 expirationTime; }` puts the array length in the mapping
 * value's first slot with the elements at `keccak256(thatSlot)`.
 *
 * Writing these is the reason a passing run is local evidence and not a public route: the real
 * Guardian set never signed anything here.
 */
export function guardianSetSlots(index: number): { lengthSlot: Hex; keySlot: (position: number) => Hex } {
  const base = keccak256(encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }], [index, 2n]))
  const elements = BigInt(keccak256(base))
  return {
    lengthSlot: base,
    keySlot: (position: number) => pad(`0x${(elements + BigInt(position)).toString(16)}`, { size: 32 }),
  }
}

/* ------------------------------------------------------------------ EVM published messages */

/** `LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)`. */
export const LOG_MESSAGE_PUBLISHED_TOPIC =
  '0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2' as const

export interface EvmPublishedMessage {
  emitter: Hex
  sequence: bigint
  nonce: number
  consistencyLevel: number
  payload: Uint8Array
}

/**
 * Reads the core bridge's own event rather than re-deriving what the transceiver "should" have
 * sent. The whole point of the exercise is that the bytes crossing to Solana are the bytes Arc
 * published, so they are taken from the receipt.
 *
 * The three unindexed value fields are ABI-encoded as a head of three words followed by the
 * `bytes` tail, so the payload offset is read rather than assumed.
 */
export function parseLogMessagePublished(log: { topics: readonly Hex[]; data: Hex }): EvmPublishedMessage {
  if (log.topics[0] !== LOG_MESSAGE_PUBLISHED_TOPIC) throw new Error('Not a LogMessagePublished log.')
  const emitter = wormholeFormatToEvm(Buffer.from(log.topics[1].slice(2), 'hex'))
  const data = Buffer.from(log.data.slice(2), 'hex')
  const word = (index: number): bigint => BigInt(`0x${data.subarray(index * 32, index * 32 + 32).toString('hex')}`)
  const payloadAt = Number(word(2))
  const payloadLength = Number(word(payloadAt / 32))
  return {
    emitter,
    sequence: word(0),
    nonce: Number(word(1)),
    consistencyLevel: Number(word(3)),
    payload: Uint8Array.from(data.subarray(payloadAt + 32, payloadAt + 32 + payloadLength)),
  }
}

/* ------------------------------------------------------------------ SVM published messages */

export interface PostedMessage {
  consistencyLevel: number
  vaaTime: number
  submissionTime: number
  nonce: number
  sequence: bigint
  emitterChain: number
  emitter: PublicKey
  payload: Uint8Array
}

/**
 * The core bridge's `PostedMessageV1` account, read field by field instead of scanning the buffer
 * for the NTT payload prefix. Scanning finds the payload but tells you nothing about the sequence,
 * nonce or timestamp, and a VAA assembled with the wrong sequence is a VAA the far side will
 * refuse for a reason that has nothing to do with the transfer.
 *
 * Layout: a three-byte magic, then `MessageData` (vaa_version, consistency_level, vaa_time,
 * vaa_signature_account, submission_time, nonce, sequence, emitter_chain, emitter_address) and a
 * length-prefixed payload. Little-endian, as everything in a Solana account is; the payload it
 * carries is big-endian NTT wire format.
 */
export function decodePostedMessage(raw: Uint8Array): PostedMessage {
  const magic = Buffer.from(raw.subarray(0, 3)).toString('ascii')
  // "msg" is the reliable variant the transceiver posts; "msu" is the unreliable one it does not.
  if (magic !== 'msg') throw new Error(`Not a posted core bridge message: magic ${JSON.stringify(magic)}.`)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const payloadLength = view.getUint32(91, true)
  if (95 + payloadLength !== raw.length) {
    throw new Error(`Posted message declares ${payloadLength} payload bytes but the account holds ${raw.length - 95}.`)
  }
  return {
    consistencyLevel: raw[4],
    vaaTime: view.getUint32(5, true),
    submissionTime: view.getUint32(41, true),
    nonce: view.getUint32(45, true),
    sequence: view.getBigUint64(49, true),
    emitterChain: view.getUint16(57, true),
    emitter: new PublicKey(raw.subarray(59, 91)),
    payload: Uint8Array.from(raw.subarray(95)),
  }
}

/* ------------------------------------------------------------------ two-sided accounting */

/**
 * Both halves of the route, each read from its own chain.
 *
 * The distinction from {@link import('./equilibriumSolana').SpokeSupply} is that nothing here is
 * derived from anything else here: `hubCirculating` and `hubCustody` come from the Arc token, the
 * spoke figures come from the SPL mint and its custody account, and the two pending counters come
 * from messages that have been observed leaving one side and not yet arriving at the other. That
 * is what makes the reconciliation able to fail.
 */
export interface ObservedRoute {
  /** Fixed canonical issuance in six-decimal atoms, read from the Arc token's total supply. */
  issuance: bigint
  /** Arc tokens held by anyone other than the locking manager. */
  hubCirculating: bigint
  /** Arc tokens the locking manager holds as backing. */
  hubCustody: bigint
  /** Minted SPL supply on the Solana spoke. */
  spokeSupply: bigint
  /** The burning spoke's custody account, which a correct burning manager never leaves funded. */
  spokeCustody: bigint
  /** Locked on Arc, not yet minted on Solana. */
  pendingToSpoke: bigint
  /** Burned on Solana, not yet unlocked on Arc. */
  pendingToHub: bigint
}

export interface RouteReconciliation {
  /** Nothing was created or destroyed: every atom is circulating, represented, or in flight. */
  conserved: boolean
  /** Every represented or in-flight atom is backed by an atom the hub actually holds. */
  backed: boolean
  /** A burning spoke holds no custody; tokens exist as supply or not at all. */
  custodyClean: boolean
  ok: boolean
}

export function reconcileRoute(route: ObservedRoute): RouteReconciliation {
  const remote = route.spokeSupply + route.pendingToSpoke + route.pendingToHub
  const conserved = route.hubCirculating + remote === route.issuance
  const backed = route.hubCustody === remote
  const custodyClean = route.spokeCustody === 0n
  return { conserved, backed, custodyClean, ok: conserved && backed && custodyClean }
}

/** The one-line form a record and a failure message both want. */
export function describeRoute(route: ObservedRoute): string {
  return [
    `issuance ${route.issuance}`,
    `hub circulating ${route.hubCirculating}`,
    `hub custody ${route.hubCustody}`,
    `spoke supply ${route.spokeSupply}`,
    `spoke custody ${route.spokeCustody}`,
    `in flight to spoke ${route.pendingToSpoke}`,
    `in flight to hub ${route.pendingToHub}`,
  ].join(', ')
}
