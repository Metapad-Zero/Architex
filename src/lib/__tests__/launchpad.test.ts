import { describe, expect, test } from 'bun:test'
import { decodeErrorResult, encodeErrorResult, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Hex } from 'viem'
import { buybackPluginAbi, launchRouterAbi, launchTokenAbi, launchpadAbi, launchpadWithPluginErrorsAbi, splitPluginAbi } from '../abi'
import type { LaunchSuite } from '../deployment'
import { explainRevert } from '../errors'
import { formatCurveSold, soldLabel, utf8ByteLength } from '../launch'
import { holderPluginAbi } from '../plugins/holders'
import { encodeComboData, encodeSplitData } from '../plugins/plan'
import { describeLaunchRouterCall, describeLaunchTokenCall, describeLaunchpadCall, describePluginCall } from '../signingIntent'
import type { Token } from '../tokens'

const account = getAddress('0x00000000000000000000000000000000000000a1')
const token = getAddress('0x00000000000000000000000000000000000000b1')
const usdc = getAddress('0x3600000000000000000000000000000000000000')
const alice = getAddress('0x1111111111111111111111111111111111111111')
const bob = getAddress('0x2222222222222222222222222222222222222222')

const suite: LaunchSuite = {
  launchpad: getAddress('0x00000000000000000000000000000000000000d1'),
  launchPairFactory: getAddress('0x00000000000000000000000000000000000000d2'),
  launchRouter: getAddress('0x00000000000000000000000000000000000000d3'),
  splitPlugin: getAddress('0x00000000000000000000000000000000000000e1'),
  buybackPlugin: getAddress('0x00000000000000000000000000000000000000e2'),
  holderPlugin: getAddress('0x00000000000000000000000000000000000000e3'),
  comboPlugin: getAddress('0x00000000000000000000000000000000000000e4'),
}

const tokens: Token[] = [
  { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, faucet: false },
  { address: token, symbol: 'DOGE', name: 'Doge on Arc', decimals: 18, faucet: false, isLaunch: true },
]

function createToken(creatorFeeBps: number, plugin: string, pluginData: Hex, initialBuyUsdc = 10_000_000n): Hex {
  return encodeFunctionData({
    abi: launchpadAbi,
    functionName: 'createToken',
    args: ['Doge on Arc', 'DOGE', 'ipfs://bafy', creatorFeeBps, getAddress(plugin), pluginData, initialBuyUsdc, 1n, 1_000_000n],
  })
}

describe('launchpad copy and validation', () => {
  test('explains launchpad custom errors in a sentence', () => {
    expect(explainRevert('SlippageExceeded')).toBe('The price moved past your slippage limit. Try again or raise slippage in settings.')
    expect(explainRevert('CurveGraduated')).toBe('This curve has graduated. It now trades in its launch pool; reload the page.')
    expect(explainRevert('InvalidName')).toBe('Name must be 1 to 32 bytes.')
    expect(explainRevert('UnknownToken')).toBe('That token is not on the launchpad.')
    expect(explainRevert('LaunchFeeAboveMax')).toBe('The launch fee went up after this form read it. Check the new fee, then create again.')
  })

  test('explains the plugins’ refusals too', () => {
    expect(explainRevert('DuplicatePayee')).toBe('The same address is in the Split twice.')
    expect(explainRevert('BpsSumNot10000')).toBe('The Combo shares must add up to exactly 100%.')
    expect(explainRevert('AlreadyRanThisBlock')).toBe('A buyback already ran in this block. Try again in a moment.')
    expect(explainRevert('NotConfigured')).toBe('That plugin does not serve this token.')
  })

  test('explains the review’s new refusals', () => {
    expect(explainRevert('Expired')).toBe('Took too long — the deadline passed before it confirmed. Try again.')
    expect(explainRevert('DataForNonPlugin')).toBe('That address isn’t a plugin, so it can’t take settings — clear them or pick a listed plugin.')
    expect(explainRevert('InvalidPlugin')).toContain('a launch token or a launch pool')
    expect(explainRevert('InvalidRecipient')).toContain('the launch router or pair factory')
  })

  test('decodes the launchpad’s DataForNonPlugin() and the Combo’s DataForNonPlugin(address) apart, both to one sentence', () => {
    for (const args of [[], [getAddress('0x1111111111111111111111111111111111111111')]] as const) {
      const data = encodeErrorResult({ abi: launchpadWithPluginErrorsAbi, errorName: 'DataForNonPlugin', args })
      expect(decodeErrorResult({ abi: launchpadWithPluginErrorsAbi, data }).errorName).toBe('DataForNonPlugin')
    }
    const expired = encodeErrorResult({ abi: launchpadAbi, errorName: 'Expired' })
    expect(decodeErrorResult({ abi: launchpadAbi, data: expired }).errorName).toBe('Expired')
  })

  test('counts UTF-8 bytes, not characters', () => {
    expect(utf8ByteLength('DOGE')).toBe(4)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('😀')).toBe(4)
  })

  test('formats sold as millions of the 800M curve', () => {
    expect(soldLabel(0n)).toBe('0 / 800M')
    expect(formatCurveSold(412_000_000n * 10n ** 18n)).toBe('412M')
  })
})

describe('launchpad signing intent', () => {
  test('decodes createToken: the fee, where it goes, the first buy and the most launch fee', () => {
    const intent = describeLaunchpadCall(createToken(250, suite.buybackPlugin, '0x'), account, tokens, suite)
    expect(intent?.title).toBe('Create token')
    expect(intent?.lines.map((line) => line.label)).toEqual(['Name', 'Symbol', 'Creator fee', 'Fees go to', 'First buy', 'Launch fee'])
    expect(intent?.lines.map((line) => line.value)).toEqual(['Doge on Arc', 'DOGE', '2.50% of every trade', 'Buyback & burn', '10 USDC', 'Up to 1 USDC'])
  })

  test('names a wallet destination as yours only when it is the signer', () => {
    expect(describeLaunchpadCall(createToken(0, account, '0x', 0n), account, tokens, suite)?.lines[3]?.value).toBe('Your wallet')
    expect(describeLaunchpadCall(createToken(0, bob, '0x', 0n), account, tokens, suite)?.lines[3]?.value).toBe('Custom address 0x2222…2222')
    expect(describeLaunchpadCall(createToken(0, bob, '0x', 0n), account, tokens, suite)?.lines[4]?.value).toBe('None')
  })

  test('spells out a Split’s payees and a Combo’s destinations', () => {
    const split = describeLaunchpadCall(createToken(100, suite.splitPlugin, encodeSplitData([alice, bob], [3n, 1n])), account, tokens, suite)
    expect(split?.lines.slice(3, 6)).toEqual([
      { label: 'Fees go to', value: 'Split' },
      { label: 'Payee 0x1111…1111', value: '75.00%' },
      { label: 'Payee 0x2222…2222', value: '25.00%' },
    ])
    const combo = describeLaunchpadCall(
      createToken(100, suite.comboPlugin, encodeComboData([suite.splitPlugin, suite.holderPlugin, alice], [5_000, 3_000, 2_000], [encodeSplitData([alice, bob], [1n, 1n]), '0x', '0x'])),
      account,
      tokens,
      suite,
    )
    expect(combo?.lines.slice(3, 7)).toEqual([
      { label: 'Fees go to', value: 'Combo' },
      { label: 'Split · 2 payees', value: '50.00%' },
      { label: 'Distribute to holders', value: '30.00%' },
      { label: 'Wallet 0x1111…1111', value: '20.00%' },
    ])
  })

  test('decodes curve buys and sells into titles, bounds and their deadline', () => {
    const buy = describeLaunchpadCall(
      encodeFunctionData({ abi: launchpadAbi, functionName: 'buy', args: [token, 100_000_000n, 1n, account, 32_503_680_000n] }),
      account,
      tokens,
      suite,
    )
    expect(buy?.title).toBe('Buy DOGE')
    expect(buy?.lines[0]).toEqual({ label: 'You pay at most', value: '100 USDC' })
    expect(buy?.lines.map((line) => line.label)).toEqual(['You pay at most', 'You receive at least', 'Valid until'])
    expect(buy?.lines[2]?.value).toBe('No deadline')

    const recipient = getAddress('0x00000000000000000000000000000000000000c1')
    const sell = describeLaunchpadCall(
      encodeFunctionData({ abi: launchpadAbi, functionName: 'sell', args: [token, 10n ** 18n, 1n, recipient, 1_700_000_000n] }),
      account,
      tokens,
      suite,
    )
    expect(sell?.title).toBe('Sell DOGE')
    expect(sell?.lines.map((line) => line.label)).toEqual(['You sell', 'You receive at least', 'Sent to', 'Valid until'])
    expect(sell?.lines[3]?.value).not.toBe('No deadline')
  })

  test('the pre-v1.3 curve buy (no deadline) is no longer decoded as a launchpad buy', () => {
    // v1.3's review changed the curve ABI: a four-argument buy is a different selector, so it falls through.
    const legacy = encodeFunctionData({
      abi: parseAbi(['function buy(address token, uint256 usdcIn, uint256 minTokensOut, address to)']),
      functionName: 'buy',
      args: [token, 1n, 1n, account],
    })
    expect(describeLaunchpadCall(legacy, account, tokens, suite)).toBe(undefined)
  })

  test('decodes a creator-fee collection', () => {
    const intent = describeLaunchpadCall(encodeFunctionData({ abi: launchpadAbi, functionName: 'collectCreatorFees', args: [token] }), account, tokens, suite)
    expect(intent?.title).toBe('Collect creator fees')
    expect(intent?.lines).toEqual([{ label: 'Token', value: 'DOGE' }])
  })

  test('decodes launch-pool trades through the launch router, with their deadline', () => {
    const buy = describeLaunchRouterCall(
      encodeFunctionData({ abi: launchRouterAbi, functionName: 'buy', args: [token, 5_000_000n, 1n, account, 32_503_680_000n] }),
      account,
      tokens,
    )
    expect(buy?.title).toBe('Buy DOGE')
    expect(buy?.lines.map((line) => line.label)).toEqual(['You pay', 'You receive at least', 'Valid until'])
    expect(buy?.lines[2]?.value).toBe('No deadline')
    const sell = describeLaunchRouterCall(
      encodeFunctionData({ abi: launchRouterAbi, functionName: 'sell', args: [token, 10n ** 18n, 1n, bob, 1_700_000_000n] }),
      account,
      tokens,
    )
    expect(sell?.title).toBe('Sell DOGE')
    expect(sell?.lines.map((line) => line.label)).toEqual(['You sell', 'You receive at least', 'Sent to', 'Valid until'])
  })

  test('decodes the plugins’ public actions', () => {
    const release = describePluginCall(suite.splitPlugin, encodeFunctionData({ abi: splitPluginAbi, functionName: 'release', args: [token, account] }), account, tokens, suite)
    expect(release?.title).toBe('Release creator fees')
    expect(release?.lines[1]).toEqual({ label: 'Paid to', value: 'You' })
    const run = describePluginCall(suite.buybackPlugin, encodeFunctionData({ abi: buybackPluginAbi, functionName: 'run', args: [token] }), account, tokens, suite)
    expect(run?.title).toBe('Run DOGE buyback')
    // Distribute to holders only forwards fees to the token: it has no action of its own to describe.
    expect(describePluginCall(suite.holderPlugin, encodeFunctionData({ abi: holderPluginAbi, functionName: 'totalDistributed', args: [token] }), account, tokens, suite)).toBe(undefined)
    // The same calldata sent to an address that is not the listed plugin is not described as that plugin's action.
    expect(describePluginCall(bob, encodeFunctionData({ abi: buybackPluginAbi, functionName: 'run', args: [token] }), account, tokens, suite)).toBe(undefined)
    expect(describePluginCall(suite.splitPlugin, '0x', account, tokens, { ...suite, splitPlugin: zeroAddress })).toBe(undefined)
  })

  test('decodes a holder’s claim, and a direct payment to holders, on the token itself', () => {
    const claim = describeLaunchTokenCall(token, encodeFunctionData({ abi: launchTokenAbi, functionName: 'claim' }), tokens)
    expect(claim?.title).toBe('Claim DOGE dividends')
    expect(claim?.lines).toEqual([{ label: 'Paid to', value: 'You' }])
    const forBob = describeLaunchTokenCall(token, encodeFunctionData({ abi: launchTokenAbi, functionName: 'claimFor', args: [bob] }), tokens)
    expect(forBob?.lines).toEqual([{ label: 'Paid to', value: '0x2222…2222' }])
    const pay = describeLaunchTokenCall(token, encodeFunctionData({ abi: launchTokenAbi, functionName: 'distribute', args: [25_000_000n] }), tokens)
    expect(pay?.title).toBe('Pay DOGE holders')
    expect(pay?.lines).toEqual([{ label: 'You pay', value: '25 USDC' }])
  })
})
