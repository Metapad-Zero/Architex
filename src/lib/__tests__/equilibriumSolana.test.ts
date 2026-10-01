import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PublicKey } from '@solana/web3.js'
import {
  MAINNET_USDC_MINT, SOLANA_NTT, anchorDiscriminator, bytes32, decodeTransceiverMessage,
  encodeNativeTokenTransfer, encodeNttManagerMessage, encodeTransceiverMessage, encodeVaaBody,
  leBytes, managerMessageDigest, nttAddresses, pumpSwapPool, reconcileSpoke, removeDust, toHex,
  transferArgsHash, trimAmount, untrimAmount, vaaBodyHash,
} from '../equilibriumSolana'

const MANAGER = new PublicKey(SOLANA_NTT.manager)
const TRANSCEIVER = new PublicKey(SOLANA_NTT.transceiver)
const CORE = new PublicKey(SOLANA_NTT.coreBridge)
const at = nttAddresses(MANAGER, TRANSCEIVER, CORE)

const filled = (byte: number) => new Uint8Array(32).fill(byte)

describe('trimmed amounts', () => {
  test('six decimals cross the eight-decimal wire with no dust', () => {
    const trimmed = trimAmount(1_234_567_890n, 6, 6)
    expect(trimmed).toEqual({ amount: 1_234_567_890n, decimals: 6 })
    expect(untrimAmount(trimmed, 6)).toBe(1_234_567_890n)
    expect(removeDust(1_234_567_890n, 6, 6)).toBe(1_234_567_890n)
  })

  test('the wire caps at eight decimals, so an eighteen-decimal peer does not widen it', () => {
    expect(trimAmount(1_234_567_890n, 6, 18)).toEqual({ amount: 1_234_567_890n, decimals: 6 })
    const fromEighteen = trimAmount(10n ** 18n + 123_456_789_012n, 18, 6)
    expect(fromEighteen).toEqual({ amount: 1_000_000n, decimals: 6 })
    expect(untrimAmount(fromEighteen, 18)).toBe(10n ** 18n)
  })

  test('dust below the peer decimals is dropped on the way out, not silently on arrival', () => {
    // A nine-decimal peer still trims to six here, because the local mint has six.
    expect(removeDust(1_000_000_001n, 6, 9)).toBe(1_000_000_001n)
    // A peer with fewer decimals than the mint loses the remainder, and the sender loses it too.
    expect(trimAmount(1_234_567n, 6, 2)).toEqual({ amount: 123n, decimals: 2 })
    expect(removeDust(1_234_567n, 6, 2)).toBe(1_230_000n)
  })

  test('the pinned spoke decimals fit the wire', () => {
    expect(SOLANA_NTT.decimals <= SOLANA_NTT.wireDecimals).toBe(true)
    expect(SOLANA_NTT.mode).toBe('burning')
  })
})

describe('NTT wire codec', () => {
  const transfer = {
    amount: { amount: 1_234_567n, decimals: 7 },
    sourceToken: filled(0xbe),
    to: filled(0xfe),
    toChain: 17,
  }

  test('a native token transfer writes decimals before amount, and the recipient before its chain', () => {
    const wire = encodeNativeTokenTransfer(transfer)
    expect(wire.length).toBe(79)
    expect(toHex(wire.subarray(0, 4))).toBe('0x994e5454')
    expect(wire[4]).toBe(7)
    expect(toHex(wire.subarray(5, 13))).toBe('0x000000000012d687')
    expect(toHex(wire.subarray(13, 45))).toBe(toHex(filled(0xbe)))
    expect(toHex(wire.subarray(45, 77))).toBe(toHex(filled(0xfe)))
    expect(toHex(wire.subarray(77, 79))).toBe('0x0011')
  })

  test('the manager message length-prefixes its payload', () => {
    const wire = encodeNttManagerMessage({ id: filled(0x12), sender: filled(0x46), payload: transfer })
    expect(wire.length).toBe(32 + 32 + 2 + 79)
    expect(toHex(wire.subarray(64, 66))).toBe('0x004f')
  })

  test('a transceiver message round-trips through its decoder', () => {
    const message = {
      sourceNttManager: filled(0xa1),
      recipientNttManager: filled(0xb2),
      managerPayload: { id: filled(0x12), sender: filled(0x46), payload: transfer },
      transceiverPayload: new Uint8Array(),
    }
    const wire = encodeTransceiverMessage(message)
    expect(toHex(wire.subarray(0, 4))).toBe('0x9945ff10')
    expect(wire.length).toBe(4 + 32 + 32 + 2 + 145 + 2)
    const back = decodeTransceiverMessage(wire)
    expect(toHex(back.sourceNttManager)).toBe(toHex(message.sourceNttManager))
    expect(toHex(back.recipientNttManager)).toBe(toHex(message.recipientNttManager))
    expect(toHex(back.managerPayload.id)).toBe(toHex(message.managerPayload.id))
    expect(back.managerPayload.payload.amount).toEqual(transfer.amount)
    expect(back.managerPayload.payload.toChain).toBe(17)
    expect(toHex(back.managerPayload.payload.to)).toBe(toHex(filled(0xfe)))
  })

  test('bytes that are not an NTT transceiver message are refused rather than misread', () => {
    const wire = encodeTransceiverMessage({
      sourceNttManager: filled(0xa1), recipientNttManager: filled(0xb2),
      managerPayload: { id: filled(0x12), sender: filled(0x46), payload: transfer },
      transceiverPayload: new Uint8Array(),
    })
    const wrongPrefix = Uint8Array.from(wire)
    wrongPrefix[0] = 0x00
    expect(() => decodeTransceiverMessage(wrongPrefix)).toThrow('Not a Wormhole NTT transceiver message.')
    const wrongInner = Uint8Array.from(wire)
    wrongInner[70 + 64 + 2] = 0x00
    expect(() => decodeTransceiverMessage(wrongInner)).toThrow('Not a NativeTokenTransfer payload.')
  })

  test('the message digest binds the source chain, so the same payload from another chain is another claim', () => {
    const message = { id: filled(0x12), sender: filled(0x46), payload: transfer }
    const fromArc = managerMessageDigest(71, message)
    const fromBase = managerMessageDigest(30, message)
    expect(fromArc.length).toBe(32)
    expect(toHex(fromArc)).not.toBe(toHex(fromBase))
    // The inbox item is addressed by that digest, which is what makes a replay a no-op.
    expect(at.inboxItem(fromArc).toBase58()).not.toBe(at.inboxItem(fromBase).toBase58())
  })
})

describe('VAA body', () => {
  const body = {
    timestamp: 1_759_000_000, nonce: 0, emitterChain: 71, emitterAddress: filled(0xaa),
    sequence: 7n, consistencyLevel: 0, payload: Uint8Array.from([1, 2, 3]),
  }

  test('the body is big-endian and fixed width up to its payload', () => {
    const wire = encodeVaaBody(body)
    expect(wire.length).toBe(4 + 4 + 2 + 32 + 8 + 1 + 3)
    expect(toHex(wire.subarray(8, 10))).toBe('0x0047')
    expect(toHex(wire.subarray(42, 50))).toBe('0x0000000000000007')
  })

  test('changing any field changes the hash the core bridge keys the posted VAA by', () => {
    const base = toHex(vaaBodyHash(body))
    expect(base).not.toBe(toHex(vaaBodyHash({ ...body, sequence: 8n })))
    expect(base).not.toBe(toHex(vaaBodyHash({ ...body, emitterChain: 30 })))
    expect(base).not.toBe(toHex(vaaBodyHash({ ...body, payload: Uint8Array.from([1, 2, 4]) })))
    expect(at.postedVaa(vaaBodyHash(body)).toBase58()).not.toBe(at.postedVaa(vaaBodyHash({ ...body, sequence: 8n })).toBase58())
  })
})

describe('program addresses', () => {
  test('core bridge addresses match the accounts observed on mainnet', () => {
    expect(at.coreBridgeConfig.toBase58()).toBe('2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn')
    expect(at.feeCollector.toBase58()).toBe('9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy')
    expect(at.guardianSet(0).toBase58()).toBe('DS7qfSAgYsonPpKoAjcGhX9VFjXdGkiHjEDkTidf8H2P')
  })

  test('the PumpSwap global config matches the account observed on mainnet', () => {
    const pool = pumpSwapPool(0, new PublicKey(SOLANA_NTT.manager), new PublicKey(SOLANA_NTT.manager), MAINNET_USDC_MINT)
    expect(pool.globalConfig.toBase58()).toBe('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
  })

  test('the pool index is part of the address, so a second index is a second pool', () => {
    const creator = new PublicKey(SOLANA_NTT.manager)
    const base = new PublicKey(SOLANA_NTT.transceiver)
    expect(pumpSwapPool(0, creator, base, MAINNET_USDC_MINT).pool.toBase58())
      .not.toBe(pumpSwapPool(1, creator, base, MAINNET_USDC_MINT).pool.toBase58())
  })

  test('the outbox item signer belongs to the transceiver program, not the manager', () => {
    const seed = new TextEncoder().encode('outbox_item_signer')
    expect(at.outboxItemSigner.toBase58()).toBe(PublicKey.findProgramAddressSync([seed], TRANSCEIVER)[0].toBase58())
    expect(at.outboxItemSigner.toBase58()).not.toBe(PublicKey.findProgramAddressSync([seed], MANAGER)[0].toBase58())
  })

  test('per-chain accounts are seeded by the big-endian chain id', () => {
    expect(at.peer(71).toBase58()).not.toBe(at.peer(30).toBase58())
    expect(at.inboxRateLimit(71).toBase58()).not.toBe(at.inboxRateLimit(30).toBase58())
    expect(at.transceiverPeer(71).toBase58()).not.toBe(at.transceiverPeer(30).toBase58())
    const seeded = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('peer'), Uint8Array.from([0x00, 0x47])], MANAGER,
    )[0]
    expect(at.peer(71).toBase58()).toBe(seeded.toBase58())
  })

  test('the session authority binds every transfer argument', () => {
    const owner = new PublicKey(SOLANA_NTT.manager)
    const recipient = filled(0xcd)
    const base = transferArgsHash(1_000n, 71, recipient, false)
    expect(toHex(base)).not.toBe(toHex(transferArgsHash(1_001n, 71, recipient, false)))
    expect(toHex(base)).not.toBe(toHex(transferArgsHash(1_000n, 30, recipient, false)))
    expect(toHex(base)).not.toBe(toHex(transferArgsHash(1_000n, 71, filled(0xce), false)))
    expect(toHex(base)).not.toBe(toHex(transferArgsHash(1_000n, 71, recipient, true)))
    expect(at.sessionAuthority(owner, base).toBase58())
      .not.toBe(at.sessionAuthority(owner, transferArgsHash(1_001n, 71, recipient, false)).toBase58())
  })

  test('anchor dispatches on the first eight bytes of sha256 of the namespaced name', () => {
    expect(anchorDiscriminator('initialize').length).toBe(8)
    expect(toHex(anchorDiscriminator('initialize'))).toBe('0xafaf6d1f0d989bed')
    expect(toHex(anchorDiscriminator('transfer_burn'))).not.toBe(toHex(anchorDiscriminator('transfer_lock')))
  })

  test('instruction integers are little-endian, the opposite of the wire', () => {
    expect(toHex(leBytes(71n, 2))).toBe('0x4700')
    expect(toHex(leBytes(1_234_567_890n, 8))).toBe('0xd202964900000000')
  })

  test('a public key converts to its 32 wire bytes', () => {
    expect(bytes32(MANAGER).length).toBe(32)
  })
})

describe('spoke supply accounting', () => {
  const issuance = 1_000_000_000_000n

  test('a settled spoke reconciles on both invariants', () => {
    expect(reconcileSpoke({ issuance, hubCirculating: 999_000_000_000n, hubCustody: 1_000_000_000n, spokeSupply: 1_000_000_000n, pending: 0n }))
      .toEqual({ conserved: true, backed: true })
  })

  test('a transfer in flight counts once, as pending', () => {
    expect(reconcileSpoke({ issuance, hubCirculating: 999_000_000_000n, hubCustody: 1_000_000_000n, spokeSupply: 0n, pending: 1_000_000_000n }))
      .toEqual({ conserved: true, backed: true })
  })

  test('a credit that both burnt and stayed outstanding fails conservation', () => {
    expect(reconcileSpoke({ issuance, hubCirculating: 999_000_000_000n, hubCustody: 1_000_000_000n, spokeSupply: 1_000_000_000n, pending: 1_000_000_000n }))
      .toEqual({ conserved: false, backed: false })
  })

  test('remote supply without matching hub custody fails backing', () => {
    expect(reconcileSpoke({ issuance, hubCirculating: 999_000_000_000n, hubCustody: 0n, spokeSupply: 1_000_000_000n, pending: 0n }))
      .toEqual({ conserved: true, backed: false })
  })
})

/**
 * Cross-pin compatibility. The SVM pin (v3.0.0+solana) and the EVM pin (v2.0.0+evm) each ship the
 * same payload fixture for their own wire tests, and a transfer only survives the hop if both
 * sides read the same bytes. Decoding each pin's fixture with this codec and re-encoding it to the
 * identical hex is what makes the two pins compatible rather than merely contemporaneous.
 *
 * Both files come from the checked-out submodules; run `git submodule update --init --recursive`
 * if this fails to find them.
 */
describe('EVM and SVM pin wire compatibility', () => {
  const PINS = [
    { name: 'EVM pin c636cc15 (v2.0.0+evm)', path: 'lib/ntt/evm/test/payloads/transceiver_message_1.txt', toChain: 2 },
    { name: 'SVM pin 1a2a92ef (v3.0.0+solana)', path: 'lib/ntt-svm/evm/test/payloads/transceiver_message_1.txt', toChain: 17 },
  ]

  for (const pin of PINS) {
    test(`decodes and re-encodes the fixture shipped with the ${pin.name}`, () => {
      const file = join(fileURLToPath(new URL('../../../', import.meta.url)), pin.path)
      if (!existsSync(file)) throw new Error(`Missing ${pin.path}. Run: git submodule update --init --recursive`)
      const hex = readFileSync(file, 'utf8').trim()
      const wire = Uint8Array.from(Buffer.from(hex, 'hex'))
      const decoded = decodeTransceiverMessage(wire)
      expect(decoded.managerPayload.payload.amount).toEqual({ amount: 1_234_567n, decimals: 7 })
      expect(decoded.managerPayload.payload.toChain).toBe(pin.toChain)
      expect(toHex(decoded.managerPayload.payload.sourceToken).slice(0, 10)).toBe('0xbeefface')
      expect(toHex(decoded.managerPayload.payload.to).slice(0, 10)).toBe('0xfeebcafe')
      expect(toHex(encodeTransceiverMessage(decoded))).toBe(`0x${hex}`)
    })
  }

  test('the two pins differ only in the chain the fixture addresses, not in the encoding', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const [evm, svm] = PINS.map((pin) => readFileSync(join(root, pin.path), 'utf8').trim())
    expect(evm.length).toBe(svm.length)
    const differing = [...evm].flatMap((character, index) => (character === svm[index] ? [] : [index]))
    // Only the two bytes holding `to_chain`, which the SVM fixture sets to 17 and the EVM one to 2.
    expect(differing.every((index) => index >= evm.length - 8 && index < evm.length - 4)).toBe(true)
  })
})
