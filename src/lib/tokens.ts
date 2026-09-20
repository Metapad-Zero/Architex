import { zeroAddress, type Address } from 'viem'
import { deployment } from './deployment'
import type { AmmPair } from './amm'

export interface Token {
  address: Address
  symbol: string
  name: string
  decimals: number
  faucet: boolean
  /** Launchpad tokens are not unique by symbol; always show the address next to them. */
  isLaunch?: boolean
}

const remembered = new Map<string, Token>()

export function rememberToken(token: Token): void {
  remembered.set(token.address.toLowerCase(), token)
}

export function rememberedToken(address: string): Token | undefined {
  return remembered.get(address.toLowerCase())
}

export function isCanonicalToken(address: string): boolean {
  return deployment.tokens.some((token) => token.address.toLowerCase() === address.toLowerCase())
}

export interface TokenMetaResult {
  token: Address
  symbol: string
  name: string
  decimals: number
}

export function tokenMonogram(token: Pick<Token, 'symbol'>): string {
  return token.symbol.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'T'
}

/** How many spot colours token marks are stamped in (`.stamp-0` … in index.css). */
export const STAMP_COUNT = 8

// The tokens everyone knows keep a fixed stamp close to their own colour; every other token takes
// one from its address, so the same token wears the same colour in every list and on every visit.
const KNOWN_STAMPS: Record<string, number> = { USDC: 0, WETH: 1, WBTC: 3, ARC: 4, EURC: 5 }

export function tokenStamp(token: Pick<Token, 'address' | 'symbol'>, canonical = isCanonicalToken(token.address)): number {
  const known = canonical ? KNOWN_STAMPS[token.symbol.toUpperCase()] : undefined
  if (known !== undefined) return known
  let hash = 0
  for (const char of token.address.toLowerCase().slice(2)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % STAMP_COUNT
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
