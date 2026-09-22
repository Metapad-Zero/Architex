import { getAddress, isAddress } from 'viem'
import { bytesMatchCid } from '../../src/lib/cid.js'
import { isHiddenDetails } from '../../src/lib/hiddenDetails.js'
import { cidOfIpfsUri, parseMetadataJson } from '../../src/lib/tokenMetadata.js'
import type { Snapshot } from './chain.js'
import { eachLimited } from './rpc.js'

/**
 * The token list wallets and aggregators read names, decimals and logos from, in the Uniswap Token Lists format
 * (https://uniswap.org/tokenlist.schema.json): the deployment's own tokens (USDC and EURC on mainnet), then every
 * launch token, tagged `launch` plus `curve` or `graduated`.
 *
 * A consumer rejects a whole list when one entry breaks the schema, so a launch token is left out when its on-chain
 * name or symbol uses characters even the older, stricter schema versions refuse, or when it takes the name or
 * symbol of one of the deployment's tokens (a launch called "USDC" is not USDC). A launch token's logo is its image,
 * served verified from our own /api/ipfs/<cid>, and only when its details file names one.
 */
export interface TokenListToken {
  chainId: number
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
  tags?: string[]
  extensions?: Record<string, string | number | boolean>
}

export interface TokenList {
  name: string
  timestamp: string
  version: { major: number; minor: number; patch: number }
  keywords: string[]
  tags: Record<string, { name: string; description: string }>
  logoURI: string
  tokens: TokenListToken[]
}

/** The image a launch's details file names, undefined when it names none or cannot be shown. */
export type ImageLookup = (metadataURI: string) => Promise<string | undefined>

// The strictest patterns any published version of the schema has used, so the list validates everywhere.
const SYMBOL_PATTERN = /^[a-zA-Z0-9+\-%/$.]{1,20}$/
const NAME_PATTERN = /^[ \w.'+\-%/À-ÖØ-öø-ÿ:&[\]()]{1,40}$/

export function listableName(name: string): boolean {
  return NAME_PATTERN.test(name) && name.trim() === name
}

export function listableSymbol(symbol: string): boolean {
  return SYMBOL_PATTERN.test(symbol)
}

const TAGS = {
  launch: { name: 'Launch token', description: 'Launched on the Architex launchpad: 18 decimals, 1,000,000,000 supply, fixed at launch' },
  curve: { name: 'On its curve', description: 'Trades on its bonding curve through the Architex launchpad, against USDC' },
  graduated: { name: 'Graduated', description: 'Trades against USDC in its launch pool, through the Architex launch router only' },
}

export async function buildTokenList(snapshot: Snapshot, origin: string, imageOf: ImageLookup): Promise<{ list: TokenList; complete: boolean }> {
  const { network } = snapshot
  const tokens: TokenListToken[] = []
  const reservedSymbols = new Set<string>()
  const reservedNames = new Set<string>()
  for (const token of network.tokens) {
    const onChain = snapshot.tokens.get(token.address.toLowerCase())
    const name = onChain?.name && listableName(onChain.name) ? onChain.name : token.name
    const symbol = onChain?.symbol && listableSymbol(onChain.symbol) ? onChain.symbol : token.symbol
    reservedSymbols.add(symbol.toLowerCase()).add(token.symbol.toLowerCase())
    reservedNames.add(name.toLowerCase()).add(token.name.toLowerCase())
    tokens.push({ chainId: network.chainId, address: getAddress(token.address), name, symbol, decimals: onChain?.decimals ?? token.decimals })
  }

  let complete = true
  let logos = 0
  const launches = [...snapshot.launches]
    .sort((a, b) => a.createdAt - b.createdAt)
    .flatMap((launch) => {
      const info = snapshot.tokens.get(launch.token.toLowerCase())
      if (!info || info.decimals !== 18) return []
      if (!listableName(info.name) || !listableSymbol(info.symbol)) return []
      if (reservedSymbols.has(info.symbol.toLowerCase()) || reservedNames.has(info.name.toLowerCase())) return []
      return [{ launch, info }]
    })
  // Eight lookups at a time: a cold instance may have every launch to look up.
  const images: (string | undefined)[] = []
  await eachLimited([...launches.keys()], 8, async (index) => {
    try {
      images[index] = await imageOf(launches[index].launch.metadataURI)
    } catch {
      complete = false
    }
  })
  launches.forEach(({ launch, info }, index) => {
    const image = images[index]
    const entry: TokenListToken = {
      chainId: network.chainId,
      address: getAddress(launch.token),
      name: info.name,
      symbol: info.symbol,
      decimals: 18,
      ...(image ? { logoURI: `${origin}/api/ipfs/${image}` } : {}),
      tags: ['launch', launch.graduated ? 'graduated' : 'curve'],
      extensions: { launchpad: getAddress(network.launchpad), pool: getAddress(launch.pair), creatorFeeBps: launch.creatorFeeBps, graduated: launch.graduated },
    }
    if (image) logos += 1
    tokens.push(entry)
  })

  const list: TokenList = {
    name: network.name === 'mainnet' ? 'Architex' : 'Architex Testnet',
    timestamp: new Date(snapshot.time * 1000).toISOString(),
    // Tokens are only ever added (launches are permanent), so minor counts them and patch counts logos found.
    version: { major: 1, minor: launches.length, patch: logos },
    keywords: ['architex', 'arc', 'launchpad'],
    tags: TAGS,
    logoURI: `${origin}/icon-512.png`,
    tokens,
  }
  return { list, complete }
}

/**
 * Finds a launch's image the way the site does: the details file is read from our own /api/ipfs/<cid> (which serves
 * only files pinned through our uploader, never a hidden one), its bytes are checked against the address, and its
 * image address is kept only when it is one we can verify and have not hidden. Results are kept for good, because an
 * address always names the same bytes; a file that could not be fetched is asked for again next time.
 */
export function createImageLookup(options: { origin: string; fetcher?: typeof fetch; timeoutMs?: number }): ImageLookup {
  const fetcher = options.fetcher ?? fetch
  const known = new Map<string, string | null>()
  return async (metadataURI) => {
    const cid = cidOfIpfsUri(metadataURI)
    if (!cid || isHiddenDetails(cid)) return undefined
    const cached = known.get(cid)
    if (cached !== undefined) return cached ?? undefined
    const response = await fetcher(`${options.origin}/api/ipfs/${cid}`, { signal: AbortSignal.timeout(options.timeoutMs ?? 8_000) })
    if (response.status === 404 || response.status === 400 || response.status === 415) {
      known.set(cid, null)
      return undefined
    }
    if (!response.ok) throw new Error(`details file: HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!(await bytesMatchCid(bytes, cid))) throw new Error('details file: the bytes do not match the address')
    const image = parseMetadataJson(bytes)?.image
    const imageCid = image ? cidOfIpfsUri(image) : undefined
    const usable = imageCid && !isHiddenDetails(imageCid) ? imageCid : null
    known.set(cid, usable)
    return usable ?? undefined
  }
}

function isUri(value: string): boolean {
  try {
    return new URL(value).protocol.length > 0
  } catch {
    return false
  }
}

/** Where a token list breaks the schema's rules; empty when it is valid. Mirrors tokenlist.schema.json. */
export function tokenListProblems(list: TokenList): string[] {
  const problems: string[] = []
  const word = /^[\w ]+$/
  if (!word.test(list.name) || list.name.length > 30) problems.push('name')
  if (Number.isNaN(Date.parse(list.timestamp))) problems.push('timestamp')
  for (const part of [list.version.major, list.version.minor, list.version.patch]) if (!Number.isInteger(part) || part < 0) problems.push('version')
  if (list.keywords.length > 20 || new Set(list.keywords).size !== list.keywords.length) problems.push('keywords')
  for (const keyword of list.keywords) if (!word.test(keyword) || keyword.length > 20) problems.push(`keyword ${keyword}`)
  const tagIds = Object.keys(list.tags)
  if (tagIds.length > 20) problems.push('tags')
  for (const [id, tag] of Object.entries(list.tags)) {
    if (!/^\w{1,10}$/.test(id)) problems.push(`tag id ${id}`)
    if (!/^[ \w]{1,20}$/.test(tag.name)) problems.push(`tag name ${id}`)
    if (!/^[ \w.,:]{1,200}$/.test(tag.description)) problems.push(`tag description ${id}`)
  }
  if (!isUri(list.logoURI)) problems.push('logoURI')
  if (list.tokens.length < 1 || list.tokens.length > 10_000) problems.push('tokens')
  const seen = new Set<string>()
  for (const token of list.tokens) {
    const where = `token ${token.address}`
    if (!Number.isInteger(token.chainId) || token.chainId < 1) problems.push(`${where} chainId`)
    if (!isAddress(token.address) || getAddress(token.address) !== token.address) problems.push(`${where} address`)
    if (seen.has(`${token.chainId}:${token.address.toLowerCase()}`)) problems.push(`${where} duplicate`)
    seen.add(`${token.chainId}:${token.address.toLowerCase()}`)
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255) problems.push(`${where} decimals`)
    if (!listableName(token.name)) problems.push(`${where} name`)
    if (!listableSymbol(token.symbol)) problems.push(`${where} symbol`)
    if (token.logoURI !== undefined && !isUri(token.logoURI)) problems.push(`${where} logoURI`)
    if (token.tags && (token.tags.length > 10 || token.tags.some((tag) => !tagIds.includes(tag)))) problems.push(`${where} tags`)
    if (token.extensions) {
      const entries = Object.entries(token.extensions)
      if (entries.length > 10) problems.push(`${where} extensions`)
      for (const [key, value] of entries) {
        if (!/^\w{1,40}$/.test(key)) problems.push(`${where} extension ${key}`)
        if (typeof value === 'string' && (value.length < 1 || value.length > 42)) problems.push(`${where} extension ${key}`)
      }
    }
    const allowed = new Set(['chainId', 'address', 'name', 'symbol', 'decimals', 'logoURI', 'tags', 'extensions'])
    for (const key of Object.keys(token)) if (!allowed.has(key)) problems.push(`${where} ${key}`)
  }
  return problems
}
