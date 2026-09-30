/**
 * Solana (SVM) side of the EQUILIBRIUM NTT route: wire codec, account addresses and supply
 * accounting for the pinned Wormhole NTT programs.
 *
 * Pure functions over bytes and addresses. Nothing here opens a socket, signs, pays a fee or
 * broadcasts; `scripts/solana/rehearse.ts` drives the actual programs on a local validator and
 * `docs/EQUILIBRIUM-SOLANA.md` records what that run does and does not prove.
 *
 * Every encoder mirrors `lib/ntt-svm/solana/modules/ntt-messages` at the pinned commit. The wire
 * format is big-endian throughout; Solana instruction data is Borsh, which is little-endian. The
 * two are deliberately kept in separate helpers so neither leaks into the other.
 */
import { PublicKey } from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha2'
import { keccak256, type Hex } from 'viem'

/** The pinned SVM deployment. `commit` is the source tag, never evidence of a deployed manager. */
export const SOLANA_NTT = {
  version: 'v3.0.0+solana',
  commit: '1a2a92ef7f289972b2d00dd1d58077d139fe68d7',
  /** Program ids as `declare_id!` at the pin. A funded deployment mints its own ids. */
  manager: 'nttiK1SepaQt6sZ4WGW5whvc9tEnGXGxuKeptcQPCcS',
  transceiver: 'Ee6jpX9oq2EsGuqGb6iZZxvtcpmMGZk8SAUbnQy4jcHR',
  coreBridge: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
  /** Burning spoke: the SPL mint's authority is the manager's `token_authority` PDA. */
  mode: 'burning',
  decimals: 6,
  /** NTT caps VAA amounts at eight decimals. Six fits with no dust. */
  wireDecimals: 8,
  solanaWormholeId: 1,
  arcWormholeId: 71,
} as const

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')

export const TRANSCEIVER_MESSAGE_PREFIX = Uint8Array.from([0x99, 0x45, 0xff, 0x10])
export const NATIVE_TOKEN_TRANSFER_PREFIX = Uint8Array.from([0x99, 0x4e, 0x54, 0x54])

/* ------------------------------------------------------------------ byte writing */

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}
/** Big-endian, as the NTT wire format uses throughout. */
function beBytes(value: bigint, width: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(8 * width)) throw new Error(`Value does not fit in ${width} bytes.`)
  const out = new Uint8Array(width)
  let rest = value
  for (let i = width - 1; i >= 0; i--) { out[i] = Number(rest & 0xffn); rest >>= 8n }
  return out
}
/** Little-endian, as Borsh instruction data uses. */
export function leBytes(value: bigint, width: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(8 * width)) throw new Error(`Value does not fit in ${width} bytes.`)
  const out = new Uint8Array(width)
  let rest = value
  for (let i = 0; i < width; i++) { out[i] = Number(rest & 0xffn); rest >>= 8n }
  return out
}
function readBe(bytes: Uint8Array, offset: number, width: number): bigint {
  let value = 0n
  for (let i = 0; i < width; i++) value = (value << 8n) | BigInt(bytes[offset + i])
  return value
}
export function bytes32(key: PublicKey): Uint8Array { return key.toBytes() }
export function toHex(bytes: Uint8Array): Hex { return `0x${Buffer.from(bytes).toString('hex')}` }

/* ------------------------------------------------------------------ trimmed amounts */

export interface TrimmedAmount { amount: bigint; decimals: number }

function scale(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount
  const power = BigInt(10) ** BigInt(Math.abs(from - to))
  return from > to ? amount / power : amount * power
}
/**
 * `TrimmedAmount::trim`. The wire carries at most eight decimals, so an amount crossing to a peer
 * with fewer decimals loses its dust here rather than silently on the far side.
 */
export function trimAmount(amount: bigint, fromDecimals: number, peerDecimals: number): TrimmedAmount {
  const decimals = Math.min(SOLANA_NTT.wireDecimals, fromDecimals, peerDecimals)
  return { amount: scale(amount, fromDecimals, decimals), decimals }
}
export function untrimAmount(trimmed: TrimmedAmount, toDecimals: number): bigint {
  return scale(trimmed.amount, trimmed.decimals, toDecimals)
}
/** The amount that will actually leave the source account once dust is dropped. */
export function removeDust(amount: bigint, fromDecimals: number, peerDecimals: number): bigint {
  return untrimAmount(trimAmount(amount, fromDecimals, peerDecimals), fromDecimals)
}

/* ------------------------------------------------------------------ NTT wire codec */

export interface NativeTokenTransfer {
  amount: TrimmedAmount
  sourceToken: Uint8Array
  to: Uint8Array
  toChain: number
}
export interface NttManagerMessage {
  id: Uint8Array
  sender: Uint8Array
  payload: NativeTokenTransfer
}
export interface TransceiverMessage {
  sourceNttManager: Uint8Array
  recipientNttManager: Uint8Array
  managerPayload: NttManagerMessage
  transceiverPayload: Uint8Array
}

/**
 * `NativeTokenTransfer` with the empty additional payload the manager is built with, so the
 * additional-payload length prefix is omitted. Note the wire order: `to` precedes `to_chain`, and
 * the trimmed amount writes its decimals before its amount, both inherited from the EVM encoding.
 */
export function encodeNativeTokenTransfer(transfer: NativeTokenTransfer): Uint8Array {
  return concat([
    NATIVE_TOKEN_TRANSFER_PREFIX,
    Uint8Array.from([transfer.amount.decimals]),
    beBytes(transfer.amount.amount, 8),
    transfer.sourceToken,
    transfer.to,
    beBytes(BigInt(transfer.toChain), 2),
  ])
}
export function encodeNttManagerMessage(message: NttManagerMessage): Uint8Array {
  const payload = encodeNativeTokenTransfer(message.payload)
  return concat([message.id, message.sender, beBytes(BigInt(payload.length), 2), payload])
}
export function encodeTransceiverMessage(message: TransceiverMessage): Uint8Array {
  const managerPayload = encodeNttManagerMessage(message.managerPayload)
  return concat([
    TRANSCEIVER_MESSAGE_PREFIX,
    message.sourceNttManager,
    message.recipientNttManager,
    beBytes(BigInt(managerPayload.length), 2),
    managerPayload,
    beBytes(BigInt(message.transceiverPayload.length), 2),
    message.transceiverPayload,
  ])
}
/** Reads back what the transceiver actually posted, so a rehearsal asserts on the emitted bytes. */
export function decodeTransceiverMessage(wire: Uint8Array): TransceiverMessage {
  const prefix = wire.subarray(0, 4)
  if (!prefix.every((byte, index) => byte === TRANSCEIVER_MESSAGE_PREFIX[index])) throw new Error('Not a Wormhole NTT transceiver message.')
  const managerLength = Number(readBe(wire, 68, 2))
  const manager = wire.subarray(70, 70 + managerLength)
  const nttPrefix = manager.subarray(64 + 2, 64 + 6)
  if (!nttPrefix.every((byte, index) => byte === NATIVE_TOKEN_TRANSFER_PREFIX[index])) throw new Error('Not a NativeTokenTransfer payload.')
  const ntt = manager.subarray(66)
  const transceiverLength = Number(readBe(wire, 70 + managerLength, 2))
  return {
    sourceNttManager: wire.subarray(4, 36),
    recipientNttManager: wire.subarray(36, 68),
    managerPayload: {
      id: manager.subarray(0, 32),
      sender: manager.subarray(32, 64),
      payload: {
        amount: { decimals: ntt[4], amount: readBe(ntt, 5, 8) },
        sourceToken: ntt.subarray(13, 45),
        to: ntt.subarray(45, 77),
        toChain: Number(readBe(ntt, 77, 2)),
      },
    },
    transceiverPayload: wire.subarray(72 + managerLength, 72 + managerLength + transceiverLength),
  }
}
/**
 * `NttManagerMessage::keccak256`. This is the inbox item's address, which is why a replayed
 * message credits nothing: the second delivery lands on the same account, already released.
 */
export function managerMessageDigest(fromChain: number, message: NttManagerMessage): Uint8Array {
  return Buffer.from(keccak256(concat([beBytes(BigInt(fromChain), 2), encodeNttManagerMessage(message)])).slice(2), 'hex')
}

/* ------------------------------------------------------------------ VAA codec */

export interface VaaBody {
  timestamp: number
  nonce: number
  emitterChain: number
  emitterAddress: Uint8Array
  sequence: bigint
  consistencyLevel: number
  payload: Uint8Array
}
export function encodeVaaBody(body: VaaBody): Uint8Array {
  return concat([
    beBytes(BigInt(body.timestamp), 4),
    beBytes(BigInt(body.nonce), 4),
    beBytes(BigInt(body.emitterChain), 2),
    body.emitterAddress,
    beBytes(body.sequence, 8),
    Uint8Array.from([body.consistencyLevel]),
    body.payload,
  ])
}
/**
 * The core bridge keys a posted VAA by `keccak256(body)`, and guardians sign
 * `keccak256(keccak256(body))`. The double hash is why the secp256k1 precompile is handed the
 * single hash as its message: the precompile applies the second one.
 */
export function vaaBodyHash(body: VaaBody): Uint8Array {
  return Buffer.from(keccak256(encodeVaaBody(body)).slice(2), 'hex')
}

/* ------------------------------------------------------------------ program addresses */

function pda(seeds: Uint8Array[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}
const seed = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Every account the manager, the transceiver and the core bridge derive, in one place. */
export function nttAddresses(manager: PublicKey, transceiver: PublicKey, coreBridge: PublicKey) {
  const chainSeed = (chain: number) => beBytes(BigInt(chain), 2)
  const emitter = pda([seed('emitter')], transceiver)
  return {
    config: pda([seed('config')], manager),
    tokenAuthority: pda([seed('token_authority')], manager),
    outboxRateLimit: pda([seed('outbox_rate_limit')], manager),
    // Derived from the transceiver program, not the manager: it is the transceiver that signs the
    // CPI marking an outbox item released (`seeds::program = transceiver.transceiver_address`).
    outboxItemSigner: pda([seed('outbox_item_signer')], transceiver),
    inboxRateLimit: (chain: number) => pda([seed('inbox_rate_limit'), chainSeed(chain)], manager),
    peer: (chain: number) => pda([seed('peer'), chainSeed(chain)], manager),
    registeredTransceiver: (program: PublicKey) => pda([seed('registered_transceiver'), program.toBytes()], manager),
    inboxItem: (digest: Uint8Array) => pda([seed('inbox_item'), digest], manager),
    sessionAuthority: (owner: PublicKey, argsHash: Uint8Array) => pda([seed('session_authority'), owner.toBytes(), argsHash], manager),
    programData: (program: PublicKey) => pda([program.toBytes()], BPF_LOADER_UPGRADEABLE),
    transceiverPeer: (chain: number) => pda([seed('transceiver_peer'), chainSeed(chain)], transceiver),
    transceiverMessage: (chain: number, id: Uint8Array) => pda([seed('transceiver_message'), chainSeed(chain), id], transceiver),
    wormholeMessage: (outboxItem: PublicKey) => pda([seed('message'), outboxItem.toBytes()], transceiver),
    emitter,
    coreBridgeConfig: pda([seed('Bridge')], coreBridge),
    feeCollector: pda([seed('fee_collector')], coreBridge),
    sequence: pda([seed('Sequence'), emitter.toBytes()], coreBridge),
    guardianSet: (index: number) => pda([seed('GuardianSet'), leBytes(BigInt(index), 4)], coreBridge),
    postedVaa: (hash: Uint8Array) => pda([seed('PostedVAA'), hash], coreBridge),
  }
}
/**
 * The session authority is seeded by the exact transfer arguments, so an approval authorizes one
 * transfer and nothing else. Anyone may then submit it; they cannot redirect it.
 */
export function transferArgsHash(amount: bigint, recipientChain: number, recipient: Uint8Array, shouldQueue: boolean): Uint8Array {
  return Buffer.from(keccak256(concat([
    beBytes(amount, 8), beBytes(BigInt(recipientChain), 2), recipient, Uint8Array.from([shouldQueue ? 1 : 0]),
  ])).slice(2), 'hex')
}
/** Anchor dispatches on `sha256("global:<name>")[0..8]`. */
export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8)
}
export function anchorAccountDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`account:${name}`)).subarray(0, 8)
}

/* ------------------------------------------------------------------ PumpSwap pool path */

export const PUMPSWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
export const MAINNET_USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

/**
 * The existing-mint pool path, derived but never opened. `create_pool` accepts a mint that already
 * exists, which is what keeps the EQUILIBRIUM spoke one asset rather than a fifth Pump coin; the
 * index is part of the address, so a second index is a second pool for the same pair and has to be
 * pinned before anything is submitted.
 *
 * `globalConfig` is checked against the observed mainnet account in the unit tests, which confirms
 * the seed scheme. The pool seeds themselves come from PumpSwap's published instruction reference
 * and are unconfirmed against a derived-from-observation address; treat the preview accordingly.
 */
export function pumpSwapPool(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey) {
  const pool = pda([seed('pool'), leBytes(BigInt(index), 2), creator.toBytes(), baseMint.toBytes(), quoteMint.toBytes()], PUMPSWAP_PROGRAM)
  return {
    pool,
    globalConfig: pda([seed('global_config')], PUMPSWAP_PROGRAM),
    lpMint: pda([seed('pool_lp_mint'), pool.toBytes()], PUMPSWAP_PROGRAM),
  }
}

/* ------------------------------------------------------------------ supply accounting */

export interface SpokeSupply {
  /** Fixed canonical issuance, in six-decimal atoms. */
  issuance: bigint
  /** Canonical tokens held outside bridge custody on the hub. */
  hubCirculating: bigint
  /** Canonical tokens the hub's locking manager holds as backing. */
  hubCustody: bigint
  /** Minted SPL supply on this spoke. */
  spokeSupply: bigint
  /** Debited on one side and not yet credited on the other. */
  pending: bigint
}
/**
 * The two invariants a burning spoke has to hold at every point of a transfer, including while a
 * message is in flight. A debit that has not been credited counts once, as pending; it is never
 * both burnt and outstanding, and never neither.
 */
export function reconcileSpoke(supply: SpokeSupply): { conserved: boolean; backed: boolean } {
  return {
    conserved: supply.hubCirculating + supply.spokeSupply + supply.pending === supply.issuance,
    backed: supply.hubCustody === supply.spokeSupply + supply.pending,
  }
}
