import { describe, expect, test } from 'bun:test'
import { formatBridgeUrl, parseBridgeUrl } from '../bridgeUrl'
import { totalUsdcFees } from '../bridgeKit'
import { activeChain } from '../../chain'
import { BRIDGE_CHAINS, destChain, domainLabel, irisMessagesUrl, isMessenger, sourceChain, switchEvmChain } from '../cctp'

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

describe('adding Arc to a wallet during a claim', () => {
  function walletError(code: number): Error {
    return Object.assign(new Error(`wallet error ${code}`), { code })
  }

  function recorder(switchError: Error | undefined) {
    const calls: { method: string; params: unknown }[] = []
    let first = true
    const provider = {
      request: ({ method, params }: { method: string; params: unknown }): Promise<null> => {
        calls.push({ method, params })
        if (method === 'wallet_switchEthereumChain' && first && switchError) {
          first = false
          return Promise.reject(switchError)
        }
        return Promise.resolve(null)
      },
    }
    return { calls, provider: provider as never }
  }

  test("adds Arc with the app's own RPC, never a hard-coded one", async () => {
    const { calls, provider } = recorder(walletError(4902))
    await switchEvmChain(provider, BRIDGE_CHAINS.arc)
    const add = calls.find((call) => call.method === 'wallet_addEthereumChain')
    const [params] = add?.params as [{ chainId: string; rpcUrls: string[] }]
    expect(params.chainId).toBe(`0x${BRIDGE_CHAINS.arc.chainId?.toString(16)}`)
    expect(params.rpcUrls).toEqual([activeChain.rpc])
  })

  test('a rejected switch is not answered by asking to add the chain', async () => {
    const { calls, provider } = recorder(walletError(4001))
    await expect(switchEvmChain(provider, BRIDGE_CHAINS.arc)).rejects.toThrow('wallet error 4001')
    expect(calls.some((call) => call.method === 'wallet_addEthereumChain')).toBe(false)
  })
})
