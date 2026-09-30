import { encodePacked, keccak256, slice, hexToBigInt, hexToNumber, type Hex } from 'viem'

const TRANSCEIVER_PREFIX = '0x9945ff10'
const NTT_PREFIX = '0x994e5454'

/** A native token transfer as the Wormhole transceiver published it (NTT TransceiverStructs wire format). */
export interface NttTransfer {
  sourceManager: Hex
  recipientManager: Hex
  id: Hex
  sender: Hex
  decimals: number
  /** Trimmed amount at `decimals`. EQUILIBRIUM has six decimals, below NTT's eight, so it is never trimmed. */
  amount: bigint
  sourceToken: Hex
  to: Hex
  toChain: number
  /** The encoded NttManagerMessage, the input of the manager's replay digest. */
  managerMessage: Hex
}

/** Parse a WormholeTransceiver payload. Throws on anything that is not exactly one NTT token transfer. */
export function parseTransfer(payload: Hex): NttTransfer {
  const at = (offset: number, size: number) => slice(payload, offset, offset + size, { strict: true })
  if (at(0, 4).toLowerCase() !== TRANSCEIVER_PREFIX) throw new Error('Not a Wormhole transceiver message')
  const managerLength = hexToNumber(at(68, 2))
  const managerMessage = at(70, managerLength)
  const transceiverLength = hexToNumber(at(70 + managerLength, 2))
  if (70 + managerLength + 2 + transceiverLength !== (payload.length - 2) / 2) throw new Error('Transceiver message length mismatch')
  const m = (offset: number, size: number) => slice(managerMessage, offset, offset + size, { strict: true })
  const inner = hexToNumber(m(64, 2))
  if (66 + inner !== managerLength) throw new Error('Manager message length mismatch')
  if (m(66, 4).toLowerCase() !== NTT_PREFIX) throw new Error('Not a native token transfer')
  if (inner !== 4 + 1 + 8 + 32 + 32 + 2) throw new Error('Transfers with an additional payload are not accepted')
  return {
    sourceManager: at(4, 32), recipientManager: at(36, 32), id: m(0, 32), sender: m(32, 32),
    decimals: hexToNumber(m(70, 1)), amount: hexToBigInt(m(71, 8)), sourceToken: m(79, 32), to: m(111, 32), toChain: hexToNumber(m(143, 2)), managerMessage,
  }
}

/** The key NttManager marks executed for a message (TransceiverStructs._nttManagerMessageDigest). */
export function managerDigest(sourceChain: number, transfer: Pick<NttTransfer, 'managerMessage'>): Hex {
  return keccak256(encodePacked(['uint16', 'bytes'], [sourceChain, transfer.managerMessage]))
}

/** Wormhole universal address back to an EVM address; refuses non-EVM padding. */
export function evmAddress(universal: Hex): Hex {
  if (!/^0x0{24}[0-9a-fA-F]{40}$/.test(universal)) throw new Error('Not an EVM universal address')
  return `0x${universal.slice(26)}`
}
