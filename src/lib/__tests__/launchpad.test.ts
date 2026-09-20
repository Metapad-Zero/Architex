import { describe, expect, test } from 'bun:test'
import { encodeFunctionData, getAddress, type Hex } from 'viem'
import { launchpadAbi } from '../abi'
import { explainRevert } from '../errors'
import { formatCurveSold, soldLabel, utf8ByteLength } from '../launch'
import { describeLaunchpadCall } from '../signingIntent'
import type { Token } from '../tokens'

const account = getAddress('0x00000000000000000000000000000000000000a1')
const token = getAddress('0x00000000000000000000000000000000000000b1')
const usdc = getAddress('0x3600000000000000000000000000000000000000')

const tokens: Token[] = [
  { address: usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, faucet: false },
  { address: token, symbol: 'DOGE', name: 'Doge on Arc', decimals: 18, faucet: false, isLaunch: true },
]

function data(functionName: 'createToken' | 'buy' | 'sell', args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: launchpadAbi, functionName, args: args as never })
}

describe('launchpad copy and validation', () => {
  test('explains launchpad custom errors in a sentence', () => {
    expect(explainRevert('SlippageExceeded')).toBe('The price moved past your slippage limit. Try again or raise slippage in settings.')
    expect(explainRevert('CurveGraduated')).toBe('This curve has graduated. Trade it on Swap.')
    expect(explainRevert('InvalidName')).toBe('Name must be 1 to 32 bytes.')
    expect(explainRevert('UnknownToken')).toBe('That token is not on the launchpad.')
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
  test('decodes createToken into a receipt', () => {
    const intent = describeLaunchpadCall(
      data('createToken', ['Doge on Arc', 'DOGE', 'https://example.com/doge.png', 10_000_000n, 1n]),
      account,
      tokens,
    )
    expect(intent?.title).toBe('Create token')
    expect(intent?.lines.map((line) => line.label)).toEqual(['Name', 'Symbol', 'First buy', 'Launch fee'])
    expect(intent?.lines[0]?.value).toBe('Doge on Arc')
    expect(intent?.lines[1]?.value).toBe('DOGE')
  })

  test('decodes buy and sell into titles and bounds', () => {
    const buy = describeLaunchpadCall(
      data('buy', [token, 100_000_000n, 1n, account]),
      account,
      tokens,
    )
    expect(buy?.title).toBe('Buy DOGE')
    expect(buy?.lines[0]?.label).toBe('You pay')
    expect(buy?.lines[1]?.label).toBe('You receive at least')

    const recipient = getAddress('0x00000000000000000000000000000000000000c1')
    const sell = describeLaunchpadCall(
      data('sell', [token, 10n ** 18n, 1n, recipient]),
      account,
      tokens,
    )
    expect(sell?.title).toBe('Sell DOGE')
    expect(sell?.lines[0]?.label).toBe('You sell')
    expect(sell?.lines[2]?.label).toBe('Sent to')
  })
})
