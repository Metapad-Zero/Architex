import { describe, expect, test } from 'bun:test'
import { formatBridgeUrl, parseBridgeUrl } from '../bridgeUrl'
import { totalUsdcFees } from '../bridgeKit'
import { BRIDGE_CHAINS, destChain, domainLabel, irisMessagesUrl, isMessenger, sourceChain } from '../cctp'

describe('bridge URL', () => {
  test('defaults to Ethereum into Arc', () => {
    expect(parseBridgeUrl('#bridge')).toEqual({ side: 'in', foreign: 'ethereum', amount: undefined })
  })

  test('reads inbound Solana and outbound Ethereum', () => {
    expect(parseBridgeUrl('#bridge?from=solana&amount=12.5')).toEqual({ side: 'in', foreign: 'solana', amount: '12.5' })
    expect(parseBridgeUrl('#bridge?from=arc&to=ethereum&amount=3')).toEqual({ side: 'out', foreign: 'ethereum', amount: '3' })
  })

  test('round-trips', () => {
    const state = { side: 'out' as const, foreign: 'solana' as const, amount: '10' }
    expect(parseBridgeUrl(formatBridgeUrl(state))).toEqual(state)
  })
})

describe('CCTP catalog', () => {
  test('Arc is always one end of the route', () => {
    expect(sourceChain('in', 'ethereum').id).toBe('ethereum')
    expect(destChain('in', 'ethereum').id).toBe('arc')
    expect(sourceChain('out', 'solana').id).toBe('arc')
    expect(destChain('out', 'solana').id).toBe('solana')
  })

  test('domains match Circle', () => {
    expect(BRIDGE_CHAINS.arc.domain).toBe(26)
    expect(BRIDGE_CHAINS.ethereum.domain).toBe(0)
    expect(BRIDGE_CHAINS.solana.domain).toBe(5)
    expect(domainLabel(26)).toBe(BRIDGE_CHAINS.arc.label)
  })

  test('iris URL is the v2 messages lookup', () => {
    const url = irisMessagesUrl(0, '0xabc')
    expect(url).toContain('/v2/messages/0?transactionHash=0xabc')
    expect(url.startsWith('https://iris-api')).toBe(true)
  })

  test('recognises the TokenMessenger on Arc', () => {
    expect(isMessenger(BRIDGE_CHAINS.arc.tokenMessenger)).toBe(true)
    expect(isMessenger('0x0000000000000000000000000000000000000001')).toBe(false)
  })
})

describe('bridge fees', () => {
  test('sums USDC protocol fees in six decimals', () => {
    expect(totalUsdcFees({
      amount: '100',
      fees: [
        { type: 'provider', token: 'USDC', amount: '0.032500' },
        { type: 'forwarder', token: 'USDC', amount: '0.01' },
        { type: 'kit', token: 'ETH', amount: '0.001' },
      ],
      gasFees: [],
    })).toBe(42_500n)
  })
})
