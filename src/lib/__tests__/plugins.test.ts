import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { listedPlugin } from '../../content/plugins/registry'
import type { LaunchSuite } from '../deployment'
import { destinationLabel, destinationName, feeDestination } from '../plugins/destination'
import { dividendStatus, hasDividends, hourlyRate, roughly } from '../plugins/holders'
import {
  bpsToPercentText,
  comboRival,
  emptyTarget,
  encodeSplitData,
  parsePercentBps,
  planFeePlugin,
  type ComboEntry,
  type DestinationFacts,
  type FeePlan,
  type PayeeRow,
  type PlanContext,
  type SimpleTarget,
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
  deepenPlugin: getAddress('0x00000000000000000000000000000000000000e5'),
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

  test('Distribute to holders is its singleton with empty data', () => {
    expect(planFeePlugin({ kind: 'holders' }, ctx).plan).toEqual({ plugin: suite.holderPlugin, pluginData: '0x' })
    const undeployed = planFeePlugin({ kind: 'holders' }, { ...ctx, suite: { ...suite, holderPlugin: zeroAddress } })
    expect(undeployed.plan).toBe(undefined)
    expect(undeployed.errors.holders).toBe('Distribute to holders is not deployed on this network yet.')
  })
})

describe('a paused plugin', () => {
  test('Buyback & burn is refused for a new launch: from the list, as a Combo entry, or by pasting its address', () => {
    const direct = planFeePlugin({ kind: 'buyback' }, ctx)
    expect(direct.plan).toBe(undefined)
    expect(direct.errors.buyback).toBe('Buyback & burn is paused for new launches.')
    const inCombo = planFeePlugin({ kind: 'combo', entries: [entry('b', { kind: 'buyback' }, '100')] }, ctx)
    expect(inCombo.plan).toBe(undefined)
    expect(inCombo.errors['entry:b:target']).toBe('Buyback & burn is paused for new launches.')
    const pasted = 'That is the Buyback & burn plugin, which is paused for new launches.'
    expect(planFeePlugin({ kind: 'custom', address: suite.buybackPlugin }, ctx).errors.custom).toBe(pasted)
    expect(planFeePlugin({ kind: 'combo', entries: [entry('c', { kind: 'custom', address: suite.buybackPlugin }, '100')] }, ctx).errors['entry:c:target']).toBe(pasted)
  })

  test('a token that already sends its fees to it still names it', () => {
    expect(destinationName(feeDestination({ plugin: suite.buybackPlugin, creator, pluginHooks: true }, suite))).toBe('Buyback & burn')
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
    const probed = { ...ctx, facts: facts({ plugins: [bob] }) }
    expect(planFeePlugin(split([payee('a', bob)]), probed).errors['payee:a:address']).toBe(
      'That address is a fee plugin. USDC a Split pays it is credited to no token and is lost.',
    )
  })
})

/** On-chain answers, as hooks/useDestinationProbe reports them. */
function facts(input: { plugins?: string[]; launchPairs?: string[]; launchTokens?: string[]; unchecked?: string[]; router?: Address; pairFactory?: Address }): DestinationFacts {
  const set = (list: string[] = []) => new Set(list.map((address) => address.toLowerCase()))
  return {
    plugins: set(input.plugins),
    launchPairs: set(input.launchPairs),
    launchTokens: set(input.launchTokens),
    unchecked: set(input.unchecked),
    router: input.router,
    pairFactory: input.pairFactory,
  }
}

describe('what the launchpad refuses, checked before signing (V13-SPEC §2.1, review)', () => {
  const pool = getAddress('0x00000000000000000000000000000000000000f1')
  const launchToken = getAddress('0x00000000000000000000000000000000000000f2')
  const liveRouter = getAddress('0x00000000000000000000000000000000000000f3')
  const liveFactory = getAddress('0x00000000000000000000000000000000000000f4')
  const known: PlanContext = { ...ctx, facts: facts({ launchPairs: [pool], launchTokens: [launchToken], router: liveRouter, pairFactory: liveFactory }) }
  const asEveryRole = (address: string) => [
    planFeePlugin({ kind: 'custom', address }, known).errors.custom,
    planFeePlugin({ kind: 'split', payees: [payee('a', address)] }, known).errors['payee:a:address'],
    planFeePlugin({ kind: 'combo', entries: [entry('e', { kind: 'custom', address }, '100')] }, known).errors['entry:e:target'],
  ]

  test('a launch pool, where anyone could skim what is sent', () => {
    for (const error of asEveryRole(pool)) expect(error).toBe('That is a launch pool. Anyone could take fees sent to it, so it cannot receive them.')
  })

  test('a launch token', () => {
    for (const error of asEveryRole(launchToken)) expect(error).toBe('That is a launch token. It cannot pass fees on, so they would be stuck.')
  })

  test('the router and pair factory the launchpad itself reports, and USDC', () => {
    for (const address of [liveRouter, liveFactory]) {
      for (const error of asEveryRole(address)) expect(error).toBe('That is an Architex contract. It cannot pass USDC on, so the fees would be stuck.')
    }
    for (const error of asEveryRole(usdc)) expect(error).toBe('That is the USDC contract. USDC sent to it is lost.')
  })

  test('waits for the launchpad’s answer rather than guess, and lets a checked wallet through', () => {
    const pending = { ...ctx, facts: facts({ unchecked: [bob] }) }
    expect(planFeePlugin({ kind: 'custom', address: bob }, pending).errors.custom).toBe('Checking this address on Arc…')
    expect(planFeePlugin({ kind: 'custom', address: bob }, pending).plan).toBe(undefined)
    expect(planFeePlugin({ kind: 'custom', address: bob }, known).plan).toEqual({ plugin: bob, pluginData: '0x' })
  })

  test('never sends settings to a plain address: a custom address or a wallet takes empty data', () => {
    expect(planFeePlugin({ kind: 'custom', address: bob }, known).plan?.pluginData).toBe('0x')
    expect(planFeePlugin({ kind: 'wallet', address: '' }, known).plan?.pluginData).toBe('0x')
  })
})

describe('Combo', () => {
  const combo = (entries: ComboEntry[]): FeePlan => ({ kind: 'combo', entries })

  test('reproduces the Solidity encoding of a Split, a plugin with no data and a wallet', () => {
    // The vector's plugin with no data sits at the address this suite gives Buyback & burn, which is paused for new
    // launches; Distribute to holders, moved to that address, takes its place (the encoding only sees the address).
    const vectorCtx = { ...ctx, suite: { ...suite, holderPlugin: suite.buybackPlugin, buybackPlugin: getAddress('0x0000000000000000000000000000000000006667') } }
    const result = planFeePlugin(
      combo([
        entry('s', { kind: 'split', payees: [payee('a', alice, '50'), payee('b', bob, '30'), payee('c', carol, '20')] }, '50'),
        entry('b', { kind: 'holders' }, '33.33'),
        entry('w', { kind: 'wallet', address: '0x00000000000000000000000000000000000000A1' }, '16.67'),
      ]),
      vectorCtx,
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
    expect(planFeePlugin(combo([entry('a', { kind: 'custom', address: bob }, '50'), entry('b', { kind: 'holders' }, '40')]), ctx).errors.entries).toBe(
      'The shares add up to 90.00%. They must add up to 100%.',
    )
    expect(planFeePlugin(combo([entry('a', { kind: 'custom', address: bob }, '100'), entry('b', { kind: 'holders' }, '0')]), ctx).errors['entry:b:percent']).toBe(
      'Give each destination more than 0%.',
    )
    const twice = planFeePlugin(combo([entry('a', { kind: 'custom', address: alice }, '50'), entry('b', { kind: 'wallet', address: alice.toLowerCase() }, '50')]), ctx)
    expect(twice.errors['entry:b:target']).toBe('That destination is already in this Combo.')
    expect(planFeePlugin(combo([entry('a', { kind: 'custom', address: suite.comboPlugin }, '100')]), ctx).errors['entry:a:target']).toBe(
      'A Combo cannot include itself.',
    )
    expect(planFeePlugin(combo([entry('a', { kind: 'custom', address: suite.splitPlugin }, '100')]), ctx).errors['entry:a:target']).toBe(
      'That is the Split plugin. Add it as its own destination so it is set up.',
    )
    const badPayee = planFeePlugin(combo([entry('s', { kind: 'split', payees: [payee('x', usdc)] }, '100')]), ctx)
    expect(badPayee.errors['entry:s:payee:x:address']).toBe('That is the USDC contract. USDC sent to it is lost.')
  })
})

describe('Deepen pool', () => {
  const deepen = (burnShare: string): SimpleTarget => ({ kind: 'deepen', burnShare })
  /** abi.encode(uint16 burnBps): one 32-byte word, the only encoding DeepenPoolPlugin.onLaunch accepts. */
  const burnShare = (bps: number): Hex => `0x${bps.toString(16).padStart(64, '0')}`

  test('starts at 50% and encodes the burn share as one canonical uint16, as DeepenPoolPlugin.onLaunch decodes it', () => {
    expect(emptyTarget('deepen')).toEqual({ kind: 'deepen', burnShare: '50' })
    expect(planFeePlugin(emptyTarget('deepen'), ctx).plan).toEqual({ plugin: suite.deepenPlugin, pluginData: burnShare(5_000) })
    expect(planFeePlugin(deepen('0'), ctx).plan?.pluginData).toBe(burnShare(0))
    expect(planFeePlugin(deepen('100'), ctx).plan?.pluginData).toBe(burnShare(10_000))
    expect(planFeePlugin(deepen('33.33'), ctx).plan?.pluginData).toBe(burnShare(3_333))
    expect(planFeePlugin(deepen('.5'), ctx).plan?.pluginData).toBe(burnShare(50))
    expect(decodeAbiParameters([{ type: 'uint16' }], planFeePlugin(deepen('75'), ctx).plan!.pluginData)).toEqual([7_500])
  })

  test('refuses what DeepenPoolPlugin.onLaunch refuses, and anything that is not a percentage', () => {
    expect(planFeePlugin(deepen('100.01'), ctx).errors.burnShare).toBe('At most 100.00%.')
    expect(planFeePlugin(deepen('150'), ctx).plan).toBe(undefined)
    expect(planFeePlugin(deepen(''), ctx).errors.burnShare).toBe('Enter a percentage.')
    expect(planFeePlugin(deepen('12.345'), ctx).errors.burnShare).toBe('Use a number with up to two decimals, like 2.5.')
    const undeployed = planFeePlugin(deepen('50'), { ...ctx, suite: { ...suite, deepenPlugin: zeroAddress } })
    expect(undeployed.plan).toBe(undefined)
    expect(undeployed.errors.deepen).toBe('Deepen pool is not deployed on this network yet.')
  })

  test('its address is refused when pasted, and as a Split payee', () => {
    expect(planFeePlugin({ kind: 'custom', address: suite.deepenPlugin }, ctx).errors.custom).toBe(
      'That is the Deepen pool plugin. Choose it from the list so it is set up.',
    )
    expect(planFeePlugin({ kind: 'split', payees: [payee('a', suite.deepenPlugin)] }, ctx).errors['payee:a:address']).toBe(
      'That is the Deepen pool plugin. USDC a Split pays it is credited to no token and is lost.',
    )
  })

  test('a token that sends its fees to it is named for it', () => {
    expect(destinationName(feeDestination({ plugin: suite.deepenPlugin, creator, pluginHooks: true }, suite))).toBe('Deepen pool')
  })

  describe('in a Combo', () => {
    const combo = (entries: ComboEntry[]): FeePlan => ({ kind: 'combo', entries })
    const paired =
      'Deepen pool and Buyback & burn cannot share a Combo: each paces its own spending, so together they spend twice as fast, which weakens the protection against traders buying ahead of the runs. Use Deepen pool’s burn share instead.'

    test('the Combo forwards its burn share', () => {
      const result = planFeePlugin(combo([entry('h', { kind: 'holders' }, '60'), entry('d', deepen('75'), '40')]), ctx)
      expect(result.errors).toEqual({})
      expect(result.plan?.plugin).toBe(suite.comboPlugin)
      const [targets, bps, datas] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }], result.plan!.pluginData)
      expect(targets).toEqual([suite.holderPlugin, suite.deepenPlugin])
      expect(bps).toEqual([6_000, 4_000])
      expect(datas).toEqual(['0x', burnShare(7_500)])
      expect(planFeePlugin(combo([entry('d', deepen('101'), '100')]), ctx).errors['entry:d:burnShare']).toBe('At most 100.00%.')
      expect(planFeePlugin(combo([entry('a', { kind: 'custom', address: suite.deepenPlugin }, '100')]), ctx).errors['entry:a:target']).toBe(
        'That is the Deepen pool plugin. Add it as its own destination so it is set up.',
      )
    })

    test('never beside Buyback & burn, in either order', () => {
      expect([comboRival('deepen'), comboRival('buyback'), comboRival('holders'), comboRival('split')]).toEqual(['buyback', 'deepen', undefined, undefined])
      const after = planFeePlugin(combo([entry('d', deepen('50'), '50'), entry('b', { kind: 'buyback' }, '50')]), ctx)
      expect(after.plan).toBe(undefined)
      expect(after.errors['entry:b:target']).toBe(paired)
      const before = planFeePlugin(combo([entry('b', { kind: 'buyback' }, '50'), entry('d', deepen('50'), '50')]), ctx)
      expect(before.plan).toBe(undefined)
      expect(before.errors['entry:d:target']).toBe(paired)
    })

    test('and still not once Buyback & burn is offered again', () => {
      const buyback = listedPlugin('buyback')
      const paused = buyback.paused
      buyback.paused = undefined
      try {
        expect(planFeePlugin(combo([entry('b', { kind: 'buyback' }, '50'), entry('h', { kind: 'holders' }, '50')]), ctx).errors).toEqual({})
        const both = planFeePlugin(combo([entry('b', { kind: 'buyback' }, '50'), entry('d', deepen('50'), '50')]), ctx)
        expect(both.plan).toBe(undefined)
        expect(both.errors).toEqual({ 'entry:d:target': paired })
      } finally {
        buyback.paused = paused
      }
      expect(listedPlugin('buyback').paused).toBe('Paused for new launches. Deepen pool at a 100% burn share does the same job.')
    })
  })
})

describe('where a token’s fees go', () => {
  test('names a listed plugin, the creator’s own wallet, or a custom address', () => {
    const listed = feeDestination({ plugin: suite.buybackPlugin, creator, pluginHooks: true }, suite)
    expect(destinationName(listed)).toBe('Buyback & burn')
    expect(destinationLabel(listed)).toBe('Buyback & burn')
    const own = feeDestination({ plugin: creator, creator, pluginHooks: false }, suite)
    expect(destinationLabel(own)).toBe('Creator wallet · 0x0000…00C1')
    const custom = feeDestination({ plugin: bob, creator, pluginHooks: false }, suite)
    expect(destinationLabel(custom)).toBe('Custom address · 0x2222…2222')
  })

  test('decides from the registered plugin and the stored hooks flag only', () => {
    // A listed plugin's address the launchpad pays by plain transfer credits no token: it is not that plugin.
    const noHooks = feeDestination({ plugin: suite.splitPlugin, creator, pluginHooks: false }, suite)
    expect(noHooks.kind).toBe('custom')
    expect(destinationLabel(noHooks)).toBe('Custom address · 0x5555…5555')
  })
})

describe('holder dividends, streamed inside the token', () => {
  // A stream paying 3,272.5 units a second with 86,000 seconds left: the token's streamRate() rounds it down to 3,272.
  const running = {
    undistributed: 281_435_000n,
    streamRate: 3_272n,
    streamEnd: 1_790_100_000n,
    eligibleSupply: 620_000_000n * 10n ** 18n,
    readAt: 1_790_100_000n - 86_000n,
  }

  test('a running stream: what it still owes, when it ends, and how much an hour it pays all holders', () => {
    expect(dividendStatus(running)).toEqual({ kind: 'streaming', left: 281_435_000n, endsAt: 1_790_100_000n, perHour: 11_781_000n })
  })

  test('a small stream is never shown as paying 0 an hour, although streamRate() rounds it down to 0', () => {
    // RCOMBO on the rehearsal: 0.041 USDC over a day.
    const small = { ...running, undistributed: 41_000n, streamRate: 0n, readAt: running.streamEnd - 86_400n }
    expect(hourlyRate(small)).toBe(1_708n)
    expect(roughly(hourlyRate(small))).toBe(1_710n) // ≈ 0.00171 USDC an hour
  })

  test('a device clock that is off cannot move the rate outside what streamRate() guarantees', () => {
    // Ten seconds left by this clock, a day by the chain's: held under streamRate + 1 units a second.
    expect(hourlyRate({ ...running, readAt: running.streamEnd - 10n })).toBe(3_272n * 3_600n + 3_599n)
    // A clock past the end.
    expect(hourlyRate({ ...running, readAt: running.streamEnd + 5n })).toBe(3_272n * 3_600n + 3_599n)
    // A clock far behind: never under streamRate.
    expect(hourlyRate({ ...running, readAt: running.streamEnd - 10_000_000n })).toBe(3_272n * 3_600n)
  })

  test('rates are shown to three significant figures', () => {
    expect(roughly(11_781_000n)).toBe(11_800_000n)
    expect(roughly(13_431_600n)).toBe(13_400_000n)
    expect(roughly(1_705n)).toBe(1_710n)
    expect(roughly(999n)).toBe(999n)
    expect(roughly(0n)).toBe(0n)
  })

  test('paused while under one whole token is eligible, with what it still owes', () => {
    expect(dividendStatus({ ...running, eligibleSupply: 0n })).toEqual({ kind: 'paused', left: 281_435_000n })
  })

  test('nothing streaming once the stream owes nothing, even where the token keeps its last rate (before c7ea280)', () => {
    expect(dividendStatus({ ...running, undistributed: 0n })).toEqual({ kind: 'none' })
    expect(dividendStatus({ ...running, undistributed: 0n, eligibleSupply: 0n })).toEqual({ kind: 'none' })
  })

  test('the page shows dividends for any token that has had some, or where the wallet has some to claim', () => {
    expect(hasDividends({ totalDistributed: 0n })).toBe(false)
    expect(hasDividends({ totalDistributed: 1n })).toBe(true)
    expect(hasDividends({ totalDistributed: 0n, you: { balance: 1n, claimable: 1n } })).toBe(true)
  })
})

// Keep encodeSplitData honest on its own too: it is what planSplit calls.
test('encodeSplitData is the canonical (address[], uint256[]) encoding', () => {
  const vector = (vectors as { k: string; hex?: string; payees?: Address[]; shares?: string[] }[]).find((v) => v.k === 'split' && v.payees?.length === 1)!
  expect(encodeSplitData(vector.payees!, vector.shares!.map(BigInt))).toBe(vector.hex as Hex)
})
