import { decodeFunctionResult, encodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from 'viem'
import { launchPairAbi, launchpadAbi, lensAbi } from '../../src/lib/abi.js'
import { aggregate, readBlock, type CallRequest, type CallResult } from './multicall.js'
import type { ListingNetwork } from './network.js'
import type { Rpc } from './rpc.js'

/**
 * Every market Architex has, read from the chain at one block.
 *
 * Three kinds, all quoted the same way (base_target, by contract address):
 *   core   a pair from the core factory (Uniswap V2 semantics, 0.30% fee kept in the pool)
 *   pool   a graduated launch token's launch pool against USDC (no pool fee; the launch router takes the
 *          platform and creator fees from the USDC side)
 *   curve  a launch token still on its bonding curve, traded through the launchpad (same fees as its pool)
 * A token is on its curve or in its pool, never both, so the two share one ticker_id: TOKEN_USDC.
 * Core pairs that hold a launch token are left out, as the site leaves them out of Swap and Pools [D12].
 */
export type MarketKind = 'core' | 'pool' | 'curve'

export interface TokenInfo {
  address: Address
  symbol: string
  name: string
  decimals: number
}

export interface Market {
  kind: MarketKind
  /** `${base}_${target}`, checksummed addresses. */
  tickerId: string
  /** The ticker_id lowercased, for lookups. */
  key: string
  /** core: the pair; pool: the launch pair; curve: the token itself, which is its curve's key in the launchpad. */
  poolId: Address
  base: TokenInfo
  target: TokenInfo
  /** The reserves that set the price, raw units. A curve's are its virtual reserves. */
  baseReserve: bigint
  targetReserve: bigint
  /** Every fee on a trade, in basis points. */
  feeBps: number
  /** 'input': taken from whatever is paid in and kept by the pool (core). 'usdc': taken from the USDC side (launch). */
  feeOn: 'input' | 'usdc'
  /** core: whether base is the pair's token0. */
  baseIsToken0?: boolean
  /** launch markets: the launch token's pool, whether or not it holds liquidity yet. */
  launchPair?: Address
  creatorFeeBps?: number
  /** curve: tokens it can still sell, tokens it can buy back, and the USDC it really holds. */
  curve?: { tokensLeft: bigint; tokensSold: bigint; usdcHeld: bigint }
}

export interface LaunchInfo {
  token: Address
  pair: Address
  creatorFeeBps: number
  graduated: boolean
  metadataURI: string
  createdAt: number
}

export interface Snapshot {
  network: ListingNetwork
  block: bigint
  /** Unix seconds of `block`. */
  time: number
  markets: Market[]
  launches: LaunchInfo[]
  /** Lowercased address to what the chain says about the token. */
  tokens: Map<string, TokenInfo>
  /** Parts that could not be read; the data is partial when this is not empty. */
  problems: string[]
}

/** Blocks behind the head to read at, so every endpoint behind a load balancer has the block. */
const HEAD_LAG = 2n
const LENS_PAGE = 200n
const CURVE_PAGE = 100n
const META_CHUNK = 100

const lower = (address: string) => address.toLowerCase()

function decoded<T>(result: CallResult | undefined, decode: (data: Hex) => T): T | undefined {
  if (!result?.success) return undefined
  try {
    return decode(result.returnData)
  } catch {
    return undefined
  }
}

/** Base and target for a core pair: quoted in the first of `quotes` it holds, else token0 in token1. */
export function orientCore(token0: Address, token1: Address, quotes: readonly Address[]): { base: Address; target: Address; baseIsToken0: boolean } {
  for (const quote of quotes) {
    if (lower(token1) === lower(quote)) return { base: token0, target: token1, baseIsToken0: true }
    if (lower(token0) === lower(quote)) return { base: token1, target: token0, baseIsToken0: false }
  }
  return { base: token0, target: token1, baseIsToken0: true }
}

export function tickerOf(base: Address, target: Address): string {
  return `${getAddress(base)}_${getAddress(target)}`
}

interface CorePairRow {
  pair: Address
  token0: Address
  token1: Address
  reserve0: bigint
  reserve1: bigint
}

interface CurveRow {
  token: Address
  pair: Address
  virtualUsdc: bigint
  virtualTokens: bigint
  tokensSold: bigint
  createdAt: bigint
  graduated: boolean
  creatorFeeBps: number
  metadataURI: string
}

export async function readSnapshot(rpc: Rpc, network: ListingNetwork): Promise<Snapshot> {
  const problems: string[] = []
  const head = await readBlock(rpc, 'latest')
  const header = await readBlock(rpc, head.number > HEAD_LAG ? head.number - HEAD_LAG : head.number)
  const block = header.number
  const hasLaunchpad = network.launchpad !== zeroAddress && network.launchRouter !== zeroAddress

  // ── One call for the sizes, the first pages and the curve constants ───────
  const first: CallRequest[] = [
    { target: network.lens, callData: encodeFunctionData({ abi: lensAbi, functionName: 'pairsLength' }) },
    { target: network.lens, callData: encodeFunctionData({ abi: lensAbi, functionName: 'pairs', args: [0n, LENS_PAGE] }) },
  ]
  if (hasLaunchpad) {
    first.push(
      { target: network.launchpad, callData: encodeFunctionData({ abi: launchpadAbi, functionName: 'tokensLength' }) },
      { target: network.launchpad, callData: encodeFunctionData({ abi: launchpadAbi, functionName: 'curvesPage', args: [0n, CURVE_PAGE] }) },
      { target: network.launchpad, callData: encodeFunctionData({ abi: launchpadAbi, functionName: 'FEE_BPS' }) },
      { target: network.launchpad, callData: encodeFunctionData({ abi: launchpadAbi, functionName: 'CURVE_SUPPLY' }) },
      { target: network.launchpad, callData: encodeFunctionData({ abi: launchpadAbi, functionName: 'VIRTUAL_USDC_0' }) },
    )
  }
  const firstResults = await aggregate(rpc, first, block)
  const pairsLength = decoded(firstResults[0], (data) => decodeFunctionResult({ abi: lensAbi, functionName: 'pairsLength', data }))
  const firstPairs = decoded(firstResults[1], (data) => decodeFunctionResult({ abi: lensAbi, functionName: 'pairs', data }))
  if (pairsLength === undefined || firstPairs === undefined) problems.push('core pairs')

  const pairRows: CorePairRow[] = [...(firstPairs ?? [])]
  if (pairsLength !== undefined && pairsLength > LENS_PAGE) {
    // A 200-row lens page costs about 3.9M gas, so four go in one call (src/lib/pairList.ts).
    const starts: bigint[] = []
    for (let start = LENS_PAGE; start < pairsLength; start += LENS_PAGE) starts.push(start)
    for (let index = 0; index < starts.length; index += 4) {
      const group = starts.slice(index, index + 4)
      const results = await aggregate(
        rpc,
        group.map((start) => ({ target: network.lens, callData: encodeFunctionData({ abi: lensAbi, functionName: 'pairs', args: [start, LENS_PAGE] }) })),
        block,
      )
      for (const result of results) {
        const page = decoded(result, (data) => decodeFunctionResult({ abi: lensAbi, functionName: 'pairs', data }))
        if (page) pairRows.push(...page)
        else problems.push('core pairs')
      }
    }
  }

  let curveRows: CurveRow[] = []
  let feeBps = 50
  let curveSupply = 800_000_000n * 10n ** 18n
  let virtualUsdc0 = 8_333_333_333n
  if (hasLaunchpad) {
    const tokensLength = decoded(firstResults[2], (data) => decodeFunctionResult({ abi: launchpadAbi, functionName: 'tokensLength', data }))
    const firstCurves = decoded(firstResults[3], (data) => decodeFunctionResult({ abi: launchpadAbi, functionName: 'curvesPage', data }))
    const fee = decoded(firstResults[4], (data) => decodeFunctionResult({ abi: launchpadAbi, functionName: 'FEE_BPS', data }))
    const supply = decoded(firstResults[5], (data) => decodeFunctionResult({ abi: launchpadAbi, functionName: 'CURVE_SUPPLY', data }))
    const usdc0 = decoded(firstResults[6], (data) => decodeFunctionResult({ abi: launchpadAbi, functionName: 'VIRTUAL_USDC_0', data }))
    if (fee !== undefined) feeBps = Number(fee)
    if (supply !== undefined) curveSupply = supply
    if (usdc0 !== undefined) virtualUsdc0 = usdc0
    if (tokensLength === undefined || firstCurves === undefined) problems.push('launches')
    curveRows = [...(firstCurves ?? [])]
    if (tokensLength !== undefined && tokensLength > CURVE_PAGE) {
      const starts: bigint[] = []
      for (let start = CURVE_PAGE; start < tokensLength; start += CURVE_PAGE) starts.push(start)
      for (let index = 0; index < starts.length; index += 4) {
        const group = starts.slice(index, index + 4)
        const results = await aggregate(
          rpc,
          group.map((start) => ({ target: network.launchpad, callData: encodeFunctionData({ abi: launchpadAbi, functionName: 'curvesPage', args: [start, CURVE_PAGE] }) })),
          block,
        )
        for (const result of results) {
          const page = decoded(result, (data) => decodeFunctionResult({ abi: launchpadAbi, functionName: 'curvesPage', data }))
          if (page) curveRows.push(...page)
          else problems.push('launches')
        }
      }
    }
  }

  const launches: LaunchInfo[] = curveRows.map((row) => ({
    token: getAddress(row.token),
    pair: getAddress(row.pair),
    creatorFeeBps: Number(row.creatorFeeBps),
    graduated: row.graduated,
    metadataURI: row.metadataURI,
    createdAt: Number(row.createdAt),
  }))
  const launched = new Set(launches.map((launch) => lower(launch.token)))

  // ── Names, symbols and decimals, and the launch pools' reserves, in one more call ──
  const tokenAddresses = new Map<string, Address>()
  for (const token of network.tokens) tokenAddresses.set(lower(token.address), token.address)
  for (const row of pairRows) {
    tokenAddresses.set(lower(row.token0), row.token0)
    tokenAddresses.set(lower(row.token1), row.token1)
  }
  for (const launch of launches) tokenAddresses.set(lower(launch.token), launch.token)
  const addresses = [...tokenAddresses.values()]
  const graduated = launches.filter((launch) => launch.graduated)

  const metaCalls: CallRequest[] = []
  for (let index = 0; index < addresses.length; index += META_CHUNK) {
    metaCalls.push({ target: network.lens, callData: encodeFunctionData({ abi: lensAbi, functionName: 'tokenMeta', args: [addresses.slice(index, index + META_CHUNK)] }) })
  }
  const reserveCalls: CallRequest[] = graduated.map((launch) => ({ target: launch.pair, callData: encodeFunctionData({ abi: launchPairAbi, functionName: 'getReserves' }) }))
  // A 100-token tokenMeta costs a few million gas, so a call carries at most four of them (Arc caps an eth_call at
  // about 30M); reserve reads are cheap and go 400 at a time.
  const second: CallResult[] = []
  for (let index = 0; index < metaCalls.length; index += 4) second.push(...(await aggregate(rpc, metaCalls.slice(index, index + 4), block)))
  for (let index = 0; index < reserveCalls.length; index += 400) second.push(...(await aggregate(rpc, reserveCalls.slice(index, index + 400), block)))

  const tokens = new Map<string, TokenInfo>()
  for (const token of network.tokens) tokens.set(lower(token.address), { address: getAddress(token.address), symbol: token.symbol, name: token.name, decimals: token.decimals })
  second.slice(0, metaCalls.length).forEach((result) => {
    const metas = decoded(result, (data) => decodeFunctionResult({ abi: lensAbi, functionName: 'tokenMeta', data }))
    if (!metas) {
      problems.push('token details')
      return
    }
    for (const meta of metas) {
      // The chain is the source of truth; the deployment file only fills in what a token does not answer.
      const known = tokens.get(lower(meta.token))
      tokens.set(lower(meta.token), {
        address: getAddress(meta.token),
        symbol: meta.symbol || known?.symbol || '',
        name: meta.name || known?.name || '',
        decimals: meta.decimals,
      })
    }
  })
  const poolReserves = new Map<string, { token: bigint; usdc: bigint }>()
  second.slice(metaCalls.length).forEach((result, index) => {
    const reserves = decoded(result, (data) => decodeFunctionResult({ abi: launchPairAbi, functionName: 'getReserves', data }))
    if (reserves) poolReserves.set(lower(graduated[index].pair), { token: reserves[0], usdc: reserves[1] })
    else problems.push('launch pool reserves')
  })

  // ── Markets ──────────────────────────────────────────────────────────────
  const markets: Market[] = []
  const usdc = tokens.get(lower(network.usdc))
  for (const row of pairRows) {
    if (launched.has(lower(row.token0)) || launched.has(lower(row.token1))) continue
    const { base, target, baseIsToken0 } = orientCore(row.token0, row.token1, network.quotes)
    const baseInfo = tokens.get(lower(base))
    const targetInfo = tokens.get(lower(target))
    if (!baseInfo || !targetInfo) continue
    const tickerId = tickerOf(base, target)
    markets.push({
      kind: 'core',
      tickerId,
      key: tickerId.toLowerCase(),
      poolId: getAddress(row.pair),
      base: baseInfo,
      target: targetInfo,
      baseReserve: baseIsToken0 ? row.reserve0 : row.reserve1,
      targetReserve: baseIsToken0 ? row.reserve1 : row.reserve0,
      feeBps: 30,
      feeOn: 'input',
      baseIsToken0,
    })
  }
  if (usdc) {
    const byToken = new Map(curveRows.map((row) => [lower(row.token), row]))
    for (const launch of launches) {
      // Every launch token has 18 decimals; its name and symbol are not needed to quote it by address.
      const info = tokens.get(lower(launch.token)) ?? { address: launch.token, symbol: '', name: '', decimals: 18 }
      const row = byToken.get(lower(launch.token))
      if (!row) continue
      const tickerId = tickerOf(launch.token, usdc.address)
      const common = { tickerId, key: tickerId.toLowerCase(), base: info, target: usdc, feeBps: feeBps + launch.creatorFeeBps, feeOn: 'usdc' as const, launchPair: launch.pair, creatorFeeBps: launch.creatorFeeBps }
      if (launch.graduated) {
        const reserves = poolReserves.get(lower(launch.pair))
        if (!reserves) continue
        markets.push({ ...common, kind: 'pool', poolId: launch.pair, baseReserve: reserves.token, targetReserve: reserves.usdc })
      } else {
        markets.push({
          ...common,
          kind: 'curve',
          poolId: launch.token,
          baseReserve: row.virtualTokens,
          targetReserve: row.virtualUsdc,
          curve: {
            tokensLeft: curveSupply > row.tokensSold ? curveSupply - row.tokensSold : 0n,
            tokensSold: row.tokensSold,
            usdcHeld: row.virtualUsdc > virtualUsdc0 ? row.virtualUsdc - virtualUsdc0 : 0n,
          },
        })
      }
    }
  }

  return { network, block, time: header.timestamp, markets, launches, tokens, problems: [...new Set(problems)] }
}
