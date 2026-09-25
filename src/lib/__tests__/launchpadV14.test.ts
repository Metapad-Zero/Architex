import { describe, expect, test } from 'bun:test'
import { decodeErrorResult, encodeErrorResult, encodeFunctionData, getAddress, zeroAddress, type Hex } from 'viem'
import { isPluginOffered, listedPlugin, listedPluginAt } from '../../content/plugins/registry'
import { launchHookAbi, launchpadAbi, launchpadV14Abi, launchpadV14WithPluginErrorsAbi, v4RouterAbi } from '../abi'
import { UNISWAP_V4_ARC, pluginSuiteOf, type LaunchSuiteV14 } from '../deployment'
import { feeDestination } from '../plugins/destination'
import { encodeComboData, encodeSplitData, planFeePlugin, type PlanContext } from '../plugins/plan'
import { describeLaunchHookCall, describeLaunchpadCall, describeLaunchpadV14Call, describeV4RouterCall } from '../signingIntent'
import type { Token } from '../tokens'

const account = getAddress('0x00000000000000000000000000000000000000a1')
const token = getAddress('0x00000000000000000000000000000000000000b1')
const usdc = getAddress('0x3600000000000000000000000000000000000000')
const alice = getAddress('0x1111111111111111111111111111111111111111')
const bob = getAddress('0x2222222222222222222222222222222222222222')

const v14: LaunchSuiteV14 = {
  launchpad: getAddress('0x00000000000000000000000000000000000000f1'),
  hook: getAddress('0x00000000000000000000000000000000000000f2'),
  router: getAddress('0x00000000000000000000000000000000000000f3'),
  splitPlugin: getAddress('0x00000000000000000000000000000000000000f4'),
  holderPlugin: getAddress('0x00000000000000000000000000000000000000f5'),
  comboPlugin: getAddress('0x00000000000000000000000000000000000000f6'),
  poolManager: UNISWAP_V4_ARC.poolManager,
  stateView: UNISWAP_V4_ARC.stateView,
}
const suite = pluginSuiteOf(v14)

const tokens: Token[] = [
  { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, faucet: false },
  { address: token, symbol: 'DOGE', name: 'Doge on Arc', decimals: 18, faucet: false, isLaunch: true },
]

function createToken(openPool: boolean, plugin: string, pluginData: Hex, initialBuyUsdc = 10_000_000n): Hex {
  return encodeFunctionData({
    abi: launchpadV14Abi,
    functionName: 'createToken',
    args: ['Doge on Arc', 'DOGE', 'ipfs://bafy', 250, getAddress(plugin), pluginData, openPool, initialBuyUsdc, 1n, 1_000_000n],
  })
}

describe('v1.4 signing intents', () => {
  test('createToken: the v1.3 lines and the pool choice, locked with the rest', () => {
    const closed = describeLaunchpadV14Call(createToken(false, suite.holderPlugin, '0x'), account, tokens, suite)
    expect(closed?.title).toBe('Create token')
    expect(closed?.lines).toEqual([
      { label: 'Name', value: 'Doge on Arc' },
      { label: 'Symbol', value: 'DOGE' },
      { label: 'Creator fee', value: '2.50% of every trade' },
      { label: 'Fees go to', value: 'Distribute to holders' },
      { label: 'Pool', value: 'Closed: only the locked liquidity' },
      { label: 'First buy', value: '10 USDC' },
      { label: 'Launch fee', value: 'Up to 1 USDC' },
    ])
    expect(closed?.note).toBe('The creator fee, where it goes and the pool choice are locked for good once the token exists.')
    const open = describeLaunchpadV14Call(createToken(true, account, '0x', 0n), account, tokens, suite)
    expect(open?.lines.find((line) => line.label === 'Pool')?.value).toBe('Open: anyone can add liquidity')
    expect(open?.lines.find((line) => line.label === 'Fees go to')?.value).toBe('Your wallet')
    expect(open?.lines.find((line) => line.label === 'First buy')?.value).toBe('None')
  })

  test('createToken spells out the v1.4 Split and Combo, by their v1.4 addresses', () => {
    const split = describeLaunchpadV14Call(createToken(false, suite.splitPlugin, encodeSplitData([alice, bob], [3n, 1n])), account, tokens, suite)
    expect(split?.lines.slice(3, 6)).toEqual([
      { label: 'Fees go to', value: 'Split' },
      { label: 'Payee 0x1111…1111', value: '75.00%' },
      { label: 'Payee 0x2222…2222', value: '25.00%' },
    ])
    const combo = describeLaunchpadV14Call(
      createToken(false, suite.comboPlugin, encodeComboData([suite.holderPlugin, alice], [6_000, 4_000], ['0x', '0x'])),
      account,
      tokens,
      suite,
    )
    expect(combo?.lines.slice(3, 6)).toEqual([
      { label: 'Fees go to', value: 'Combo' },
      { label: 'Distribute to holders', value: '60.00%' },
      { label: 'Wallet 0x1111…1111', value: '40.00%' },
    ])
  })

  test('the v1.3 decoder leaves a v1.4 createToken alone: its selector is not v1.3’s', () => {
    expect(describeLaunchpadCall(createToken(false, account, '0x'), account, tokens, suite)).toBe(undefined)
  })

  test('curve buys and sells on the v1.4 launchpad read as v1.3’s', () => {
    const buy = describeLaunchpadV14Call(
      encodeFunctionData({ abi: launchpadV14Abi, functionName: 'buy', args: [token, 100_000_000n, 1n, account, 32_503_680_000n] }),
      account,
      tokens,
      suite,
    )
    expect(buy?.title).toBe('Buy DOGE')
    expect(buy?.lines).toEqual([
      { label: 'You pay at most', value: '100 USDC' },
      { label: 'You receive at least', value: '<0.000001 DOGE' },
      { label: 'Valid until', value: 'No deadline' },
    ])
    const sell = describeLaunchpadV14Call(
      encodeFunctionData({ abi: launchpadV14Abi, functionName: 'sell', args: [token, 10n ** 18n, 1n, bob, 1_700_000_000n] }),
      account,
      tokens,
      suite,
    )
    expect(sell?.title).toBe('Sell DOGE')
    expect(sell?.lines.map((line) => line.label)).toEqual(['You sell', 'You receive at least', 'Sent to', 'Valid until'])
    const collect = describeLaunchpadV14Call(encodeFunctionData({ abi: launchpadV14Abi, functionName: 'collectCreatorFees', args: [token] }), account, tokens, suite)
    expect(collect?.title).toBe('Collect creator fees')
  })

  test('router trades in the Uniswap pool: what is paid or sold, the least received, the pool and the deadline', () => {
    const buy = describeV4RouterCall(
      encodeFunctionData({ abi: v4RouterAbi, functionName: 'buy', args: [token, 5_000_000n, 1n, account, 32_503_680_000n] }),
      account,
      tokens,
    )
    expect(buy?.title).toBe('Buy DOGE')
    expect(buy?.lines).toEqual([
      { label: 'You pay', value: '5 USDC' },
      { label: 'You receive at least', value: '<0.000001 DOGE' },
      { label: 'Pool', value: 'Uniswap v4' },
      { label: 'Valid until', value: 'No deadline' },
    ])
    const sell = describeV4RouterCall(
      encodeFunctionData({ abi: v4RouterAbi, functionName: 'sell', args: [token, 10n ** 18n, 2_000_000n, bob, 1_700_000_000n] }),
      account,
      tokens,
    )
    expect(sell?.title).toBe('Sell DOGE')
    expect(sell?.lines.map((line) => line.label)).toEqual(['You sell', 'You receive at least', 'Pool', 'Sent to', 'Valid until'])
    expect(sell?.lines[1]).toEqual({ label: 'You receive at least', value: '2 USDC' })
    // A quote is no transaction anyone signs.
    expect(describeV4RouterCall(encodeFunctionData({ abi: v4RouterAbi, functionName: 'quoteBuy', args: [token, 1n] }), account, tokens)).toBe(undefined)
  })

  test('the hook’s lock', () => {
    const lock = describeLaunchHookCall(encodeFunctionData({ abi: launchHookAbi, functionName: 'lock', args: [token] }), tokens)
    expect(lock?.title).toBe('Lock DOGE anti-sniping fees')
    expect(lock?.lines).toEqual([{ label: 'Token', value: 'DOGE' }])
    expect(lock?.note).toContain('nobody can withdraw')
    expect(describeLaunchHookCall(encodeFunctionData({ abi: launchHookAbi, functionName: 'lockHeld', args: [token] }), tokens)).toBe(undefined)
  })
})

describe('the builder for a v1.4 launch', () => {
  const ctx: PlanContext = { creator: account, usdc, suite, poolManager: v14.poolManager }

  test('offers Split, Distribute to holders and Combo at their v1.4 addresses, not Buyback & burn or Deepen pool', () => {
    expect(['split', 'holders', 'combo'].map((kind) => isPluginOffered(listedPlugin(kind as 'split'), suite))).toEqual([true, true, true])
    expect(['buyback', 'deepen'].map((kind) => isPluginOffered(listedPlugin(kind as 'buyback'), suite))).toEqual([false, false])
    expect(listedPlugin('buyback').notOnV14).toBe('Not offered for v1.4 launches.')
    expect(listedPlugin('deepen').notOnV14).toBe('Not available for v1.4 launches yet.')
    expect(planFeePlugin({ kind: 'holders' }, ctx).plan).toEqual({ plugin: v14.holderPlugin, pluginData: '0x' })
    expect(planFeePlugin({ kind: 'deepen', burnShare: '50' }, ctx).errors.deepen).toBe('Deepen pool is not deployed on this network yet.')
    expect(listedPluginAt(v14.splitPlugin, suite)?.kind).toBe('split')
  })

  test('refuses the hook, the v4 router and Uniswap’s PoolManager as destinations', () => {
    expect(planFeePlugin({ kind: 'custom', address: v14.poolManager }, ctx).errors.custom).toBe(
      'That is Uniswap’s PoolManager. Anyone could take fees sent to it, so it cannot receive them.',
    )
    for (const address of [v14.hook, v14.router]) {
      expect(planFeePlugin({ kind: 'custom', address }, ctx).errors.custom).toBe('That is an Architex contract. It cannot pass USDC on, so the fees would be stuck.')
    }
    const payees = { kind: 'split' as const, payees: [{ id: 'p1', address: v14.poolManager, share: '1' }] }
    expect(planFeePlugin(payees, ctx).errors['payee:p1:address']).toContain('PoolManager')
    // Without a PoolManager (v1.3, or v1.4 not deployed) nothing extra is refused.
    expect(planFeePlugin({ kind: 'custom', address: v14.poolManager }, { ...ctx, poolManager: zeroAddress }).plan?.plugin).toBe(v14.poolManager)
  })

  test('a v1.4 token’s fees go to the plugins of its own launchpad', () => {
    const launch = { plugin: v14.splitPlugin, creator: account, pluginHooks: true }
    const listed = feeDestination(launch, suite)
    expect([listed.kind, listed.address]).toEqual(['listed', v14.splitPlugin])
    expect(feeDestination(launch, { ...suite, splitPlugin: zeroAddress }).kind).toBe('custom')
  })

  test('createToken’s refusals decode, the plugins’ included', () => {
    for (const errorName of ['InvalidPlugin', 'LaunchFeeAboveMax', 'DataForNonPlugin'] as const) {
      const data = encodeErrorResult({ abi: launchpadV14WithPluginErrorsAbi, errorName })
      expect(decodeErrorResult({ abi: launchpadV14WithPluginErrorsAbi, data }).errorName).toBe(errorName)
    }
    const duplicate = encodeErrorResult({ abi: launchpadV14WithPluginErrorsAbi, errorName: 'DuplicatePayee', args: [alice] })
    expect(decodeErrorResult({ abi: launchpadV14WithPluginErrorsAbi, data: duplicate }).errorName).toBe('DuplicatePayee')
    // The same launch through v1.3's ABI is another function altogether: nine arguments, not ten.
    const v13Create = launchpadAbi.find((item) => item.type === 'function' && item.name === 'createToken')
    expect(v13Create?.type === 'function' ? v13Create.inputs.length : 0).toBe(9)
  })
})
