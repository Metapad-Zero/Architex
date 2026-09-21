import { describe, expect, test } from 'bun:test'
import { getAddress, zeroAddress, type Address } from 'viem'
import type { AmmPair } from '../amm'
import { deployment } from '../deployment'
import { buildTokenRegistry, isCanonicalToken, type TokenMetaResult } from '../tokens'

const usdc = deployment.tokens[0].address
const canonicalCount = deployment.tokens.filter((token) => token.address !== zeroAddress).length
const pooled = [0xb1, 0xb2, 0xb3, 0xb4].map((n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`))

function usdcPair(token: Address, index: number): AmmPair {
  return {
    pair: getAddress(`0x${(0xc0 + index).toString(16).padStart(40, '0')}`),
    token0: token,
    token1: usdc,
    reserve0: 1n,
    reserve1: 1n,
    totalSupply: 1n,
  }
}

// Symbols a token creator could pick to sort ahead of EURC.
const meta: TokenMetaResult[] = [' EURC', '0', 'AAA', 'eurc'].map((symbol, index) => ({
  token: pooled[index],
  symbol,
  name: symbol,
  decimals: 18,
}))

describe('token registry order', () => {
  const pairs = pooled.map(usdcPair)

  test('USDC first, then every deployment token, then tokens found in pools', () => {
    const registry = buildTokenRegistry(pairs, meta)
    expect(registry[0].address).toBe(usdc)
    expect(registry.slice(0, canonicalCount).every((token) => isCanonicalToken(token.address))).toBe(true)
    expect(registry.slice(canonicalCount).map((token) => token.address).sort()).toEqual([...pooled].sort())
  })

  test('the default receive token is a deployment token whatever pooled tokens are called', () => {
    const registry = buildTokenRegistry(pairs, meta)
    const defaultOut = registry.find((token) => token.address !== registry[0].address)!
    expect(isCanonicalToken(defaultOut.address)).toBe(true)
  })

  test('holds before pooled token symbols have loaded', () => {
    const registry = buildTokenRegistry(pairs)
    expect(registry.slice(0, canonicalCount).every((token) => isCanonicalToken(token.address))).toBe(true)
  })

  test('pooled tokens are sorted by symbol among themselves', () => {
    const symbols = buildTokenRegistry(pairs, meta).slice(canonicalCount).map((token) => token.symbol)
    expect(symbols).toEqual([...symbols].sort((a, b) => a.localeCompare(b)))
  })
})
