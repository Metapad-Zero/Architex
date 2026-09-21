import { describe, expect, test } from 'bun:test'
import { getAddress } from 'viem'
import { deployment } from '../deployment'
import { findTokenByRef, formatSwapUrl, parseSwapUrl, tokenRef } from '../swapUrl'
import type { Token } from '../tokens'

const usdc = deployment.tokens[0]
const eurc = deployment.tokens.find((token) => token.symbol === 'EURC')!
const launch: Token = { address: getAddress('0x00000000000000000000000000000000000000b1'), symbol: 'DOGE', name: 'Doge on Arc', decimals: 18, faucet: false }
const lookalike: Token = { address: getAddress('0x00000000000000000000000000000000000000b2'), symbol: 'EURC', name: 'EURC', decimals: 6, faucet: false }
const tokens: Token[] = [usdc, lookalike, eurc, launch]

describe('tokens in a swap link', () => {
  test('deployment tokens are written by symbol, every other token by address', () => {
    expect(tokenRef(usdc)).toBe('USDC')
    expect(tokenRef(eurc)).toBe('EURC')
    expect(tokenRef(launch)).toBe(launch.address)
    expect(tokenRef(lookalike)).toBe(lookalike.address)
  })

  test('a link to a launch token still opens that token after a reload', () => {
    const url = formatSwapUrl({ in: tokenRef(usdc), out: tokenRef(launch), amount: '5' })
    const state = parseSwapUrl(url)
    expect(findTokenByRef(tokens, state.in)).toBe(usdc)
    expect(findTokenByRef(tokens, state.out)).toBe(launch)
    expect(state.amount).toBe('5')
  })

  test('an address matches whatever its case', () => {
    expect(findTokenByRef(tokens, launch.address.toLowerCase())).toBe(launch)
    expect(findTokenByRef(tokens, launch.address.toUpperCase().replace('0X', '0x'))).toBe(launch)
  })

  test('a symbol only ever finds a deployment token', () => {
    expect(findTokenByRef(tokens, 'doge')).toBe(undefined)
    expect(findTokenByRef(tokens, 'eurc')).toBe(eurc)
    expect(findTokenByRef(tokens, 'EURC')).toBe(eurc)
  })

  test('nothing to look up finds nothing', () => {
    expect(findTokenByRef(tokens, undefined)).toBe(undefined)
    expect(findTokenByRef(tokens, '')).toBe(undefined)
    expect(findTokenByRef(tokens, '0x0000000000000000000000000000000000000bad')).toBe(undefined)
  })
})
