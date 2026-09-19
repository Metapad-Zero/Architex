import { zeroAddress, type Address } from 'viem'
import { deployment } from './deployment'
import type { AmmPair } from './amm'

export interface Token {
  address: Address
  symbol: string
  name: string
  decimals: number
  faucet: boolean
}

export interface TokenMetaResult {
  token: Address
  symbol: string
  name: string
  decimals: number
}

export function tokenMonogram(token: Token): string {
  return token.symbol.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'T'
}

export function buildTokenRegistry(pairs: readonly AmmPair[], meta: readonly TokenMetaResult[] = []): Token[] {
  const registry = new Map<string, Token>()
  for (const token of deployment.tokens) {
    if (token.address === zeroAddress) continue
    registry.set(token.address.toLowerCase(), token)
  }

  const discovered = new Set<Address>()
  for (const pair of pairs) {
    discovered.add(pair.token0)
    discovered.add(pair.token1)
  }
  for (const address of discovered) {
    if (!registry.has(address.toLowerCase())) {
      registry.set(address.toLowerCase(), {
        address,
        symbol: '',
        name: '',
        decimals: 18,
        faucet: false,
      })
    }
  }

  for (const item of meta) {
    const existing = registry.get(item.token.toLowerCase())
    if (!existing) continue
    registry.set(item.token.toLowerCase(), {
      ...existing,
      symbol: item.symbol || existing.symbol || 'TOKEN',
      name: item.name || existing.name || 'Unknown token',
      decimals: item.decimals,
    })
  }

  const usdc = deployment.tokens[0]?.address.toLowerCase()
  return [...registry.values()].sort((a, b) => {
    if (a.address.toLowerCase() === usdc) return -1
    if (b.address.toLowerCase() === usdc) return 1
    return a.symbol.localeCompare(b.symbol)
  })
}

export function getToken(tokens: readonly Token[], address: Address): Token | undefined {
  return tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())
}
