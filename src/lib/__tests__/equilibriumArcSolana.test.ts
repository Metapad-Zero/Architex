import { describe, expect, test } from 'bun:test'
import { PublicKey } from '@solana/web3.js'
import { encodeAbiParameters, type Hex } from 'viem'
import {
  LOG_MESSAGE_PUBLISHED_TOPIC, RENT_EXEMPT_EPOCH, decodePostedMessage, describeRoute,
  evmToWormholeFormat, guardianSetSlots, parseLogMessagePublished, parseSeedAccount, reconcileRoute,
  reviewReleaseBoundary, seedAccountJson, seedDifferences, wormholeFormatToEvm,
  type ObservedRoute, type SeedAccount,
} from '../equilibriumArcSolana'
import { SOLANA_NTT, bytes32, decodeTransceiverMessage, toHex } from '../equilibriumSolana'

const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'))

/**
 * The two payloads a run of `scripts/solana/integrate.ts` actually exchanged, copied out of
 * `output/equilibrium/arc-solana-integration.json`. They are here so the codec is checked against
 * bytes that crossed between the pinned contracts and the pinned programs rather than against
 * bytes this test file made up. The Arc-side addresses in them are the ones that run deployed;
 * only the Solana program id is a constant of the pin.
 */
const OBSERVED_ARC_TO_SOLANA = '0x9945ff100000000000000000000000002d4a9ebb2c5d8cd84627e79f0aa64bb8f15fc3d90bc1cf777a14dd216d8a3541cabb9459ba725a49b73348b5bd9c561ca8c7969300910000000000000000000000000000000000000000000000000000000000000000000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266004f994e54540600000000499602d2000000000000000000000000cd44e0e8b1af8e6f9e46169abba68a900f85c8247b3d080098ee918429aec94b30e305f8ee4dcd97289bbbc9a52df861d3d636f500010000'
const OBSERVED_SOLANA_TO_ARC = '0x9945ff100bc1cf777a14dd216d8a3541cabb9459ba725a49b73348b5bd9c561ca8c796930000000000000000000000002d4a9ebb2c5d8cd84627e79f0aa64bb8f15fc3d90091893f1ac143d9d8117980c7c2cd16a39cb339d994aebaa248bba1cf7f6386bdd27b3d080098ee918429aec94b30e305f8ee4dcd97289bbbc9a52df861d3d636f5004f994e54540600000000499602d2038e036ed5d9103e2ad1b12283c1d68fde95620b51fdafda8b266ea7d9674726000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb9226600470000'
const OBSERVED_AMOUNT = 1_234_567_890n

describe('Wormhole address format', () => {
  test('an EVM address round-trips through the 32-byte form', () => {
    const address = '0x2d4a9EBb2c5D8Cd84627E79F0Aa64bB8f15Fc3d9' as const
    const wide = evmToWormholeFormat(address)
    expect(wide.length).toBe(32)
    expect(wide.subarray(0, 12).every((byte) => byte === 0)).toBe(true)
    expect(wormholeFormatToEvm(wide)).toBe(address.toLowerCase() as Hex)
  })

  test('a Solana pubkey is refused rather than truncated to its last twenty bytes', () => {
    const solana = bytes32(new PublicKey(SOLANA_NTT.manager))
    expect(() => wormholeFormatToEvm(solana)).toThrow(/not left-padded/)
  })

  test('a short address is refused', () => {
    expect(() => wormholeFormatToEvm(new Uint8Array(20))).toThrow(/32 bytes/)
  })
})

describe('guardian set substitution slots', () => {
  /**
   * `WormholeSimulator.overrideToDevnetGuardian` computes `keccak256(abi.encode(index, 2))` for the
   * set and `keccak256(thatSlot)` for its `keys` array. These two values are that derivation for
   * index 0, and they are pinned here because getting them wrong writes over unrelated storage and
   * the read-back check in `scripts/solana/arcFork.ts` would be the only thing that noticed.
   */
  test('index 0 derives the slots the Solidity helper writes', () => {
    const slots = guardianSetSlots(0)
    expect(slots.lengthSlot).toBe('0xac33ff75c19e70fe83507db0d683fd3465c996598dc972688b7ace676c89077b')
    expect(slots.keySlot(0)).toBe('0x7d2944a272ac5bae96b5bd2f67b6c13276d541dc09eb1cf414d96b19a09e1c2f')
  })

  test('later keys are consecutive words, and a different set index is a different mapping entry', () => {
    const slots = guardianSetSlots(0)
    expect(BigInt(slots.keySlot(3)) - BigInt(slots.keySlot(0))).toBe(3n)
    expect(guardianSetSlots(1).lengthSlot).not.toBe(slots.lengthSlot)
  })
})

describe('LogMessagePublished', () => {
  const log = (sequence: bigint, nonce: number, payload: Uint8Array, consistencyLevel: number) => ({
    topics: [LOG_MESSAGE_PUBLISHED_TOPIC, evmToWormholeFormatHex('0x75a0B19B8c36560D2A890FBd7aECA1df25180a54')] as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'uint32' }, { type: 'bytes' }, { type: 'uint8' }],
      [sequence, nonce, toHex(payload), consistencyLevel],
    ),
  })
  const evmToWormholeFormatHex = (address: Hex): Hex => toHex(evmToWormholeFormat(address))

  test('the payload is read from its ABI offset, not from a fixed one', () => {
    const payload = bytes(OBSERVED_ARC_TO_SOLANA)
    const parsed = parseLogMessagePublished(log(7n, 0, payload, 0))
    expect(parsed.emitter).toBe('0x75a0b19b8c36560d2a890fbd7aeca1df25180a54')
    expect(parsed.sequence).toBe(7n)
    expect(parsed.nonce).toBe(0)
    expect(parsed.consistencyLevel).toBe(0)
    expect(toHex(parsed.payload)).toBe(OBSERVED_ARC_TO_SOLANA)
  })

  test('a payload whose length is not a multiple of a word keeps its exact length', () => {
    const odd = Uint8Array.from({ length: 33 }, (_, index) => index + 1)
    expect(toHex(parseLogMessagePublished(log(1n, 9, odd, 15)).payload)).toBe(toHex(odd))
  })

  test('another contract event with the same shape is refused', () => {
    const wrong = log(1n, 0, new Uint8Array(4), 0)
    expect(() => parseLogMessagePublished({ ...wrong, topics: [`0x${'11'.repeat(32)}`, wrong.topics[1]] }))
      .toThrow(/Not a LogMessagePublished/)
  })
})

describe('posted core bridge message', () => {
  /** A `PostedMessageV1` account as the core bridge writes it, around a payload that really crossed. */
  function postedAccount(payload: Uint8Array, options: { magic?: string; declaredLength?: number } = {}): Uint8Array {
    const raw = new Uint8Array(95 + payload.length)
    raw.set(Buffer.from(options.magic ?? 'msg', 'ascii'), 0)
    const view = new DataView(raw.buffer)
    raw[3] = 1 // vaa_version
    raw[4] = 32 // consistency_level
    view.setUint32(5, 1_790_806_205, true) // vaa_time
    raw.set(bytes32(new PublicKey(SOLANA_NTT.manager)), 9) // vaa_signature_account
    view.setUint32(41, 1_790_806_206, true) // submission_time
    view.setUint32(45, 11, true) // nonce
    view.setBigUint64(49, 4n, true) // sequence
    view.setUint16(57, 1, true) // emitter_chain
    raw.set(bytes32(new PublicKey('CeMT6dcc6bebb9ohBAFaBJ2NcVm18HYLtjt5H9nizHx')), 59)
    view.setUint32(91, options.declaredLength ?? payload.length, true)
    raw.set(payload, 95)
    return raw
  }

  test('every field is read, not just the payload', () => {
    const payload = bytes(OBSERVED_SOLANA_TO_ARC)
    const decoded = decodePostedMessage(postedAccount(payload))
    expect(decoded.consistencyLevel).toBe(32)
    expect(decoded.vaaTime).toBe(1_790_806_205)
    expect(decoded.submissionTime).toBe(1_790_806_206)
    expect(decoded.nonce).toBe(11)
    expect(decoded.sequence).toBe(4n)
    expect(decoded.emitterChain).toBe(SOLANA_NTT.solanaWormholeId)
    expect(decoded.emitter.toBase58()).toBe('CeMT6dcc6bebb9ohBAFaBJ2NcVm18HYLtjt5H9nizHx')
    expect(toHex(decoded.payload)).toBe(OBSERVED_SOLANA_TO_ARC)
  })

  test('the header offsets are pinned: the payload starts at byte 95', () => {
    const payload = bytes(OBSERVED_SOLANA_TO_ARC)
    expect(postedAccount(payload).length).toBe(95 + payload.length)
    // The NTT transceiver prefix has to land exactly where the length prefix says it does.
    expect(toHex(decodePostedMessage(postedAccount(payload)).payload).slice(0, 10)).toBe('0x9945ff10')
  })

  test('the unreliable message variant is refused rather than decoded as a reliable one', () => {
    expect(() => decodePostedMessage(postedAccount(bytes(OBSERVED_SOLANA_TO_ARC), { magic: 'msu' })))
      .toThrow(/Not a posted core bridge message/)
  })

  test('a declared length that disagrees with the account is refused', () => {
    expect(() => decodePostedMessage(postedAccount(bytes(OBSERVED_SOLANA_TO_ARC), { declaredLength: 100 })))
      .toThrow(/payload bytes but the account holds/)
  })
})

describe('the messages that crossed', () => {
  test('Arc addressed the pinned Solana manager program and the Solana account', () => {
    const decoded = decodeTransceiverMessage(bytes(OBSERVED_ARC_TO_SOLANA))
    expect(toHex(decoded.recipientNttManager)).toBe(toHex(bytes32(new PublicKey(SOLANA_NTT.manager))))
    expect(wormholeFormatToEvm(decoded.sourceNttManager)).toBe('0x2d4a9ebb2c5d8cd84627e79f0aa64bb8f15fc3d9')
    expect(decoded.managerPayload.payload.toChain).toBe(SOLANA_NTT.solanaWormholeId)
    expect(decoded.managerPayload.payload.amount).toEqual({ amount: OBSERVED_AMOUNT, decimals: SOLANA_NTT.decimals })
  })

  test('Solana returned it to the same Arc manager, addressed to an Arc account', () => {
    const decoded = decodeTransceiverMessage(bytes(OBSERVED_SOLANA_TO_ARC))
    expect(toHex(decoded.sourceNttManager)).toBe(toHex(bytes32(new PublicKey(SOLANA_NTT.manager))))
    expect(wormholeFormatToEvm(decoded.recipientNttManager)).toBe('0x2d4a9ebb2c5d8cd84627e79f0aa64bb8f15fc3d9')
    expect(decoded.managerPayload.payload.toChain).toBe(SOLANA_NTT.arcWormholeId)
    // The return is addressed to an EVM account, so it must be left-padded; a 32-byte Solana
    // pubkey here would be a transfer nobody on Arc could claim.
    expect(wormholeFormatToEvm(decoded.managerPayload.payload.to)).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
    expect(decoded.managerPayload.payload.amount).toEqual({ amount: OBSERVED_AMOUNT, decimals: SOLANA_NTT.decimals })
  })

  test('the two directions carry the same amount, so the round trip conserves it', () => {
    const out = decodeTransceiverMessage(bytes(OBSERVED_ARC_TO_SOLANA)).managerPayload.payload.amount
    const back = decodeTransceiverMessage(bytes(OBSERVED_SOLANA_TO_ARC)).managerPayload.payload.amount
    expect(back).toEqual(out)
  })
})

describe('two-sided reconciliation', () => {
  const issuance = 1_000_000_000_000n
  const settled: ObservedRoute = {
    issuance, hubCirculating: issuance, hubCustody: 0n,
    spokeSupply: 0n, spokeCustody: 0n, pendingToSpoke: 0n, pendingToHub: 0n,
  }

  test('an untouched route reconciles', () => {
    expect(reconcileRoute(settled).ok).toBe(true)
  })

  test('a credited representation is conserved and backed', () => {
    expect(reconcileRoute({
      ...settled, hubCirculating: issuance - 1_234_567_890n, hubCustody: 1_234_567_890n, spokeSupply: 1_234_567_890n,
    }).ok).toBe(true)
  })

  test('an in-flight transfer counts once, in whichever direction it is flying', () => {
    const outbound = { ...settled, hubCirculating: issuance - 500n, hubCustody: 500n, pendingToSpoke: 500n }
    const returning = { ...settled, hubCirculating: issuance - 500n, hubCustody: 500n, pendingToHub: 500n }
    expect(reconcileRoute(outbound).ok).toBe(true)
    expect(reconcileRoute(returning).ok).toBe(true)
    // Counted on both sides at once, it is not.
    expect(reconcileRoute({ ...outbound, spokeSupply: 500n }).conserved).toBe(false)
  })

  test('the observed end state of a run reconciles with a rate-limited claim outstanding', () => {
    const observed: ObservedRoute = {
      issuance, hubCirculating: 999_944_444_445n, hubCustody: 55_555_555n,
      spokeSupply: 0n, spokeCustody: 0n, pendingToSpoke: 55_555_555n, pendingToHub: 0n,
    }
    expect(reconcileRoute(observed)).toEqual({ conserved: true, backed: true, custodyClean: true, ok: true })
  })

  test('a spoke that minted without the hub locking anything fails conservation and backing', () => {
    const inflated = { ...settled, spokeSupply: 1_000n }
    expect(reconcileRoute(inflated)).toEqual({ conserved: false, backed: false, custodyClean: true, ok: false })
  })

  test('hub custody that does not cover the representation fails backing alone', () => {
    const short = { ...settled, hubCirculating: issuance - 1_000n, hubCustody: 400n, spokeSupply: 1_000n }
    expect(reconcileRoute(short)).toEqual({ conserved: true, backed: false, custodyClean: true, ok: false })
  })

  test('a burning spoke holding custody is a defect even when the sums add up', () => {
    const dirty = { ...settled, spokeCustody: 1n }
    expect(reconcileRoute(dirty)).toEqual({ conserved: true, backed: true, custodyClean: false, ok: false })
  })

  test('the description names both sides, so a failure says which one moved', () => {
    expect(describeRoute(settled)).toContain('hub custody 0')
    expect(describeRoute(settled)).toContain('spoke supply 0')
  })
})

describe('seed accounts for a rebuilt spoke ledger', () => {
  const account: SeedAccount = {
    pubkey: '11111111111111111111111111111112',
    lamports: 1_057_920,
    owner: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
    data: Uint8Array.from([0, 1, 2, 253, 254, 255]),
  }

  test('a seed file round-trips the bytes and the owner it was written from', () => {
    expect(parseSeedAccount(seedAccountJson(account))).toEqual(account)
  })

  test('an empty account round-trips, because the Wormhole fee collector is one', () => {
    const feeCollector: SeedAccount = { ...account, data: new Uint8Array(0), owner: '11111111111111111111111111111111' }
    expect(parseSeedAccount(seedAccountJson(feeCollector))).toEqual(feeCollector)
  })

  test('rentEpoch is written as u64::MAX in full, which a JavaScript number cannot carry', () => {
    const text = seedAccountJson(account)
    expect(text).toContain(`"rentEpoch": ${RENT_EXEMPT_EPOCH}`)
    // The value solana-test-validator would reject, and the reason the field is spliced in as text.
    expect(String(Number(RENT_EXEMPT_EPOCH))).not.toBe(RENT_EXEMPT_EPOCH)
  })

  test('space is the length of the data, so a truncated file is refused rather than loaded short', () => {
    const shortened = seedAccountJson(account).replace('"space": 6', '"space": 7')
    expect(() => parseSeedAccount(shortened)).toThrow(/declares 7 bytes but carries 6/)
  })

  test('an encoding other than base64 is refused instead of silently decoded', () => {
    const other = seedAccountJson(account).replace('"base64"\n', '"base58"\n')
    expect(() => parseSeedAccount(other)).toThrow(/base58, not base64/)
  })

  test('an identical rebuild has no differences', () => {
    expect(seedDifferences([account], [{ ...account, data: Uint8Array.from(account.data) }])).toEqual([])
  })

  test('a claim missing from the rebuilt ledger is named, not counted', () => {
    expect(seedDifferences([account], [])).toEqual([`${account.pubkey}: absent from the rebuilt ledger`])
  })

  test('a single changed byte is reported with its offset, so a rewritten boundary cannot pass', () => {
    const tampered = { ...account, data: Uint8Array.from([0, 1, 2, 253, 254, 0]) }
    expect(seedDifferences([account], [tampered])).toEqual([`${account.pubkey}: data differs from byte 5`])
  })

  test('a re-owned account is a difference even when its bytes match', () => {
    const reowned = { ...account, owner: '11111111111111111111111111111111' }
    expect(seedDifferences([account], [reowned])[0]).toContain('owner worm2ZoG')
  })

  test('lamports are carried but do not decide sameness: a fee collector pays for the publish', () => {
    expect(seedDifferences([account], [{ ...account, lamports: 1 }])).toEqual([])
  })
})

describe('the queued claim release boundary', () => {
  const queueClock = 1_790_000_000n
  const duration = 86_400
  const slack = 60
  const at = (releaseAfter: bigint, observedClock: bigint) =>
    reviewReleaseBoundary({ queueClock, releaseAfter, observedClock, duration, slack })

  test('the delay reported is measured between two readings, not assumed from the duration', () => {
    const review = at(queueClock + 86_400n, queueClock + 86_400n)
    expect(review.programDelay).toBe(86_400n)
    expect(review.matchesDuration).toBe(true)
    expect(review.advancedBy).toBe(86_400n)
    expect(review.releasable).toBe(true)
  })

  test('a boundary a couple of slots under the duration still matches, because the readings differ', () => {
    expect(at(queueClock + 86_398n, queueClock + 86_400n).matchesDuration).toBe(true)
  })

  test('a boundary further ahead than the declared duration does not match', () => {
    const review = at(queueClock + 86_401n, queueClock + 90_000n)
    expect(review.programDelay).toBe(86_401n)
    expect(review.matchesDuration).toBe(false)
  })

  test('a materially shortened duration fails the match instead of reading back as 86400', () => {
    // The defect the measured figure exists to catch: a program whose queue delay is an hour would
    // have reported the full duration had the delay been computed as releaseAfter minus duration.
    const review = at(queueClock + 3_600n, queueClock + 3_601n)
    expect(review.programDelay).toBe(3_600n)
    expect(review.matchesDuration).toBe(false)
    expect(review.releasable).toBe(true)
  })

  test('a boundary exactly at the slack edge is refused, so the window is narrow on purpose', () => {
    expect(at(queueClock + BigInt(duration - slack), queueClock).matchesDuration).toBe(false)
    expect(at(queueClock + BigInt(duration - slack + 1), queueClock).matchesDuration).toBe(true)
  })

  test('a clock one second short of the boundary is not releasable', () => {
    const review = at(queueClock + 86_400n, queueClock + 86_399n)
    expect(review.releasable).toBe(false)
    expect(review.advancedBy).toBe(86_399n)
  })

  test('an unadvanced clock reports the advance it did not make, rather than reading as ready', () => {
    const review = at(queueClock + 86_400n, queueClock + 5n)
    expect(review.advancedBy).toBe(5n)
    expect(review.releasable).toBe(false)
  })
})
