import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, getAddress, zeroAddress, type Address, type Hex } from 'viem'
import type { LaunchSuite } from '../deployment'
import { destinationLabel, destinationName, feeDestination } from '../plugins/destination'
import { claimableAfterDrip } from '../plugins/holders'
import {
  bpsToPercentText,
  encodeSplitData,
  parsePercentBps,
  planFeePlugin,
  type ComboEntry,
  type FeePlan,
  type PayeeRow,
  type PlanContext,
} from '../plugins/plan'
import vectors from './fixtures/v13-vectors.json'

const suite: LaunchSuite = {
  launchpad: getAddress('0x00000000000000000000000000000000000000d1'),
  launchPairFactory: getAddress('0x00000000000000000000000000000000000000d2'),
  launchRouter: getAddress('0x00000000000000000000000000000000000000d3'),
  // The Solidity combo vector names these two as its Split and Buyback & burn entries.
  splitPlugin: getAddress('0x5555555555555555555555555555555555555555'),
  buybackPlugin: getAddress('0x6666666666666666666666666666666666666666'),
  holderPlugin: getAddress('0x00000000000000000000000000000000000000e3'),
  comboPlugin: getAddress('0x00000000000000000000000000000000000000e4'),
}
const usdc = getAddress('0x3600000000000000000000000000000000000000')
const creator = getAddress('0x00000000000000000000000000000000000000c1')
const alice = getAddress('0x1111111111111111111111111111111111111111')
const bob = getAddress('0x2222222222222222222222222222222222222222')
const carol = getAddress('0xabcdef0123456789abcdef0123456789abcdef01')
const ctx: PlanContext = { creator, usdc, suite }

const payee = (id: string, address: string, share = '1'): PayeeRow => ({ id, address, share })
const entry = (id: string, target: ComboEntry['target'], percent: string): ComboEntry => ({ id, target, percent })

describe('fee percentages', () => {
  test('reads up to two decimals as basis points', () => {
    expect(parsePercentBps('2.5', 1_000)).toEqual({ bps: 250 })
    expect(parsePercentBps('10', 1_000)).toEqual({ bps: 1_000 })
    expect(parsePercentBps('0.01', 1_000)).toEqual({ bps: 1 })
    expect(parsePercentBps('.5', 1_000)).toEqual({ bps: 50 })
    expect(parsePercentBps('0', 1_000)).toEqual({ bps: 0 })
    expect(parsePercentBps('', 1_000, 0)).toEqual({ bps: 0 })
  })

  test('refuses more precision than a basis point, text, and anything over the cap', () => {
    expect(parsePercentBps('1.234', 1_000).error).toBeDefined()
    expect(parsePercentBps('abc', 1_000).error).toBeDefined()
    expect(parsePercentBps('.', 1_000).error).toBeDefined()
    expect(parsePercentBps('10.01', 1_000).error).toBe('At most 10.00%.')
    expect(parsePercentBps('', 10_000).error).toBe('Enter a percentage.')
  })

  test('writes basis points back as the shortest percentage', () => {
    expect(bpsToPercentText(250)).toBe('2.5')
    expect(bpsToPercentText(1_000)).toBe('10')
    expect(bpsToPercentText(1)).toBe('0.01')
    expect(bpsToPercentText(0)).toBe('0')
  })
})

describe('where creator fees go: a single destination', () => {
  test('the creator wallet defaults to the connected wallet and takes no data', () => {
    expect(planFeePlugin({ kind: 'wallet', address: '' }, ctx).plan).toEqual({ plugin: creator, pluginData: '0x' })
    expect(planFeePlugin({ kind: 'wallet', address: alice.toLowerCase() }, ctx).plan).toEqual({ plugin: alice, pluginData: '0x' })
    expect(planFeePlugin({ kind: 'wallet', address: '' }, { ...ctx, creator: undefined }).errors.wallet).toBe(
      'Connect a wallet, or enter the address to pay.',
    )
  })

  test('refuses addresses that would lose the fees or that the launchpad refuses', () => {
    const refused = (address: string) => planFeePlugin({ kind: 'custom', address }, ctx).errors.custom
    expect(refused('')).toBe('Enter the address to pay.')
    expect(refused('0x123')).toBe('That is not a valid address.')
    expect(refused(zeroAddress)).toBe('The zero address cannot receive fees.')
    expect(refused(suite.launchpad)).toBe('That is the launchpad. It cannot receive its own fees.')
    expect(refused(usdc)).toBe('That is the USDC contract. USDC sent to it is lost.')
    expect(refused(suite.launchRouter)).toContain('Architex contract')
    expect(refused(suite.splitPlugin)).toBe('That is the Split plugin. Choose it from the list so it is set up.')
    expect(planFeePlugin({ kind: 'custom', address: bob }, ctx).plan).toEqual({ plugin: bob, pluginData: '0x' })
  })

  test('Buyback & burn and Distribute to holders are their singletons with empty data', () => {
    expect(planFeePlugin({ kind: 'buyback' }, ctx).plan).toEqual({ plugin: suite.buybackPlugin, pluginData: '0x' })
    expect(planFeePlugin({ kind: 'holders' }, ctx).plan).toEqual({ plugin: suite.holderPlugin, pluginData: '0x' })
    const undeployed = planFeePlugin({ kind: 'holders' }, { ...ctx, suite: { ...suite, holderPlugin: zeroAddress } })
    expect(undeployed.plan).toBe(undefined)
    expect(undeployed.errors.holders).toBe('Distribute to holders is not deployed on this network yet.')
  })
})

describe('Split', () => {
  const split = (payees: PayeeRow[]): FeePlan => ({ kind: 'split', payees })

  test('encodes payees and shares the way SplitPlugin decodes them', () => {
    const result = planFeePlugin(split([payee('a', alice, '50'), payee('b', bob.toLowerCase(), '30'), payee('c', carol, '20')]), ctx)
    expect(result.plan?.plugin).toBe(suite.splitPlugin)
    const solidity = (vectors as { k: string; hex?: string; payees?: string[] }[]).find((v) => v.k === 'split' && v.payees?.length === 3)
    expect(result.plan?.pluginData).toBe(solidity?.hex as Hex)
    const [payees, shares] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], result.plan!.pluginData)
    expect(payees).toEqual([alice, bob, carol])
    expect(shares).toEqual([50n, 30n, 20n])
  })

  test('checks what SplitPlugin.onLaunch checks', () => {
    expect(planFeePlugin(split([]), ctx).errors.payees).toBe('Add at least one payee.')
    const many = Array.from({ length: 21 }, (_, i) => payee(`p${i}`, getAddress(`0x${(0x1000 + i).toString(16).padStart(40, '0')}`)))
    expect(planFeePlugin(split(many), ctx).errors.payees).toBe('A Split takes at most 20 payees.')
    expect(planFeePlugin(split(many.slice(0, 20)), ctx).plan).toBeDefined()

    const duplicate = planFeePlugin(split([payee('a', alice), payee('b', alice.toLowerCase())]), ctx)
    expect(duplicate.errors['payee:b:address']).toBe('0x1111…1111 is already a payee.')
    expect(planFeePlugin(split([payee('a', alice, '0')]), ctx).errors['payee:a:share']).toBe('A share must be 1 or more.')
    expect(planFeePlugin(split([payee('a', alice, '1.5')]), ctx).errors['payee:a:share']).toBe('Shares are whole numbers, 1 or more.')
    expect(planFeePlugin(split([payee('a', zeroAddress)]), ctx).errors['payee:a:address']).toBe('The zero address cannot receive fees.')
    expect(planFeePlugin(split([payee('a', usdc)]), ctx).errors['payee:a:address']).toBe('That is the USDC contract. USDC sent to it is lost.')
    expect(planFeePlugin(split([payee('a', suite.launchpad)]), ctx).errors['payee:a:address']).toContain('launchpad')
    expect(planFeePlugin(split([payee('a', suite.splitPlugin)]), ctx).errors['payee:a:address']).toContain('Split plugin')
  })

  test('refuses a plugin as a payee: USDC paid straight to a plugin is credited to no token', () => {
    expect(planFeePlugin(split([payee('a', suite.holderPlugin)]), ctx).errors['payee:a:address']).toBe(
      'That is the Distribute to holders plugin. USDC a Split pays it is credited to no token and is lost.',
    )
    const probed = { ...ctx, pluginAddresses: new Set([bob.toLowerCase()]) }
    expect(planFeePlugin(split([payee('a', bob)]), probed).errors['payee:a:address']).toBe(
      'That address is a fee plugin. USDC a Split pays it is credited to no token and is lost.',
    )
  })
})

describe('Combo', () => {
  const combo = (entries: ComboEntry[]): FeePlan => ({ kind: 'combo', entries })

  test('reproduces the Solidity encoding of a Split, a plugin with no data and a wallet', () => {
    const result = planFeePlugin(
      combo([
        entry('s', { kind: 'split', payees: [payee('a', alice, '50'), payee('b', bob, '30'), payee('c', carol, '20')] }, '50'),
        entry('b', { kind: 'buyback' }, '33.33'),
        entry('w', { kind: 'wallet', address: '0x00000000000000000000000000000000000000A1' }, '16.67'),
      ]),
      ctx,
    )
    expect(result.errors).toEqual({})
    expect(result.plan?.plugin).toBe(suite.comboPlugin)
    const solidity = (vectors as { k: string; hex?: string; bps?: number[] }[]).find((v) => v.k === 'combo' && v.bps?.[1] === 3_333)
    expect(result.plan?.pluginData).toBe(solidity?.hex as Hex)
  })

  test('a wallet entry left empty is the connected wallet', () => {
    const result = planFeePlugin(combo([entry('w', { kind: 'wallet', address: '' }, '60'), entry('h', { kind: 'holders' }, '40')]), ctx)
    const [targets, bps, datas] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }], result.plan!.pluginData)
    expect(targets).toEqual([creator, suite.holderPlugin])
    expect(bps).toEqual([6_000, 4_000])
    expect(datas).toEqual(['0x', '0x'])
  })

  test('checks what ComboPlugin.onLaunch checks', () => {
    expect(planFeePlugin(combo([]), ctx).errors.entries).toBe('Add at least one destination.')
    const six = Array.from({ length: 6 }, (_, i) => entry(`e${i}`, { kind: 'custom', address: getAddress(`0x${(0x2000 + i).toString(16).padStart(40, '0')}`) }, '10'))
    expect(planFeePlugin(combo(six), ctx).errors.entries).toBe('A Combo takes at most 5 destinations.')
    expect(planFeePlugin(combo([entry('a', { kind: 'buyback' }, '50'), entry('b', { kind: 'holders' }, '40')]), ctx).errors.entries).toBe(
      'The shares add up to 90.00%. They must add up to 100%.',
    )
    expect(planFeePlugin(combo([entry('a', { kind: 'buyback' }, '100'), entry('b', { kind: 'holders' }, '0')]), ctx).errors['entry:b:percent']).toBe(
      'Give each destination more than 0%.',
    )
    const twice = planFeePlugin(combo([entry('a', { kind: 'custom', address: alice }, '50'), entry('b', { kind: 'wallet', address: alice.toLowerCase() }, '50')]), ctx)
    expect(twice.errors['entry:b:target']).toBe('That destination is already in this Combo.')
    expect(planFeePlugin(combo([entry('a', { kind: 'custom', address: suite.comboPlugin }, '100')]), ctx).errors['entry:a:target']).toBe(
      'A Combo cannot include itself.',
    )
    expect(planFeePlugin(combo([entry('a', { kind: 'custom', address: suite.buybackPlugin }, '100')]), ctx).errors['entry:a:target']).toBe(
      'That is the Buyback & burn plugin. Add it as its own destination so it is set up.',
    )
    const badPayee = planFeePlugin(combo([entry('s', { kind: 'split', payees: [payee('x', usdc)] }, '100')]), ctx)
    expect(badPayee.errors['entry:s:payee:x:address']).toBe('That is the USDC contract. USDC sent to it is lost.')
  })
})

describe('where a token’s fees go', () => {
  test('names a listed plugin, the creator’s own wallet, or a custom address', () => {
    const listed = feeDestination({ plugin: suite.buybackPlugin, creator }, suite)
    expect(destinationName(listed)).toBe('Buyback & burn')
    expect(destinationLabel(listed)).toBe('Buyback & burn')
    const own = feeDestination({ plugin: creator, creator }, suite)
    expect(destinationLabel(own)).toBe('Creator wallet · 0x0000…00C1')
    const custom = feeDestination({ plugin: bob, creator }, suite)
    expect(destinationLabel(custom)).toBe('Custom address · 0x2222…2222')
  })
})

describe('Distribute to holders', () => {
  test('what dripAndClaim pays is the claimable balance plus a pro-rata share of the drip, floored', () => {
    expect(claimableAfterDrip({ claimable: 5n, releasable: 1_000n, balance: 1n, eligibleSupply: 3n })).toBe(5n + 333n)
    expect(claimableAfterDrip({ claimable: 5n, releasable: 1_000n, balance: 0n, eligibleSupply: 3n })).toBe(5n)
    expect(claimableAfterDrip({ claimable: 0n, releasable: 1_000n, balance: 7n, eligibleSupply: 0n })).toBe(0n)
  })
})

// Keep encodeSplitData honest on its own too: it is what planSplit calls.
test('encodeSplitData is the canonical (address[], uint256[]) encoding', () => {
  const vector = (vectors as { k: string; hex?: string; payees?: Address[]; shares?: string[] }[]).find((v) => v.k === 'split' && v.payees?.length === 1)!
  expect(encodeSplitData(vector.payees!, vector.shares!.map(BigInt))).toBe(vector.hex as Hex)
})
