import { zeroAddress, type Address, type Hash } from 'viem'
import type { LaunchVersion } from './deployment'
import {
  CURVE,
  marketCap,
  poolMarketCap,
  poolSpotPrice,
  priceMoveBps,
  progressBps,
  realUsdc,
  spotPrice,
  type CurveState,
  type PoolReserves,
} from './curve'
import { formatAmount, formatUsd } from './format'
import { v4MarketCap, v4SpotPrice, type V4PoolState } from './launchV14'

export const NAME_MAX_BYTES = 32
export const SYMBOL_MAX_BYTES = 10
export const METADATA_MAX_BYTES = 256
export const PAGE_SIZE = 50n
export const GRADUATES_AT_USD = '$100,000'

export interface LaunchRecord {
  /**
   * The launchpad the token was launched on: `'v14'` for launchpad v1.4 (it graduates into a Uniswap v4 pool); absent
   * for v1.3, where every earlier record comes from (it graduates into its own launch pool). Read it with launchVersion.
   */
  version?: LaunchVersion
  token: Address
  creator: Address
  /**
   * v1.3: the token's launch pool (launch-pair factory); it holds liquidity only after graduation. v1.4 tokens have none
   * (their pool lives inside Uniswap's PoolManager): the zero address.
   */
  pair: Address
  virtualUsdc: bigint
  virtualTokens: bigint
  tokensSold: bigint
  createdAt: bigint
  graduated: boolean
  /** Creator fee on every buy and sell, 0–1000 bps, locked at launch. */
  creatorFeeBps: number
  /** Whether the plugin declared IArchitexFeePlugin at launch: collections call its hooks, else a plain transfer. */
  pluginHooks: boolean
  /** Where creator fees are collected to, locked at launch. */
  plugin: Address
  metadataURI: string
  name: string
  symbol: string
  /** v1.3: the launch pool's reserves; read only once a token has graduated. */
  pool?: PoolReserves
  /** v1.4: the block the curve was created in; its anti-sniping window counts from here. */
  createdBlock?: bigint
  /** v1.4: whether anyone may add liquidity to its Uniswap pool (the creator's choice, fixed at launch). */
  openPool?: boolean
  /** v1.4: the Uniswap v4 pool, read only once a token has graduated. */
  v4?: V4PoolState
}

export function launchVersion(launch: Pick<LaunchRecord, 'version'>): LaunchVersion {
  return launch.version ?? 'v13'
}

/** Whether the figures a graduated token is priced by have been read: its launch pool's, or its Uniswap pool's. */
export function isPriced(launch: Pick<LaunchRecord, 'version' | 'graduated' | 'pool' | 'v4'>): boolean {
  if (!launch.graduated) return true
  return launchVersion(launch) === 'v14' ? Boolean(launch.v4) : Boolean(launch.pool)
}

export type TradeVenue = 'curve' | 'pool'

export interface LaunchTrade {
  trader: Address
  isBuy: boolean
  /** Gross USDC: what a buyer paid, or what left the curve or pool on a sell (the seller got it minus both fees). */
  usdcAmount: bigint
  tokenAmount: bigint
  platformFee: bigint
  creatorFee: bigint
  time: number
  txHash: Hash
  block: number
  /** Position in the block; tells apart two trades made by one transaction. */
  logIndex?: number
  /** v1.4's anti-sniping fee on a buy in a token's first blocks, on the curve or in the pool; absent on v1.3. */
  snipeFee?: bigint
  /**
   * A v1.4 pool trade: the hook's event names the contract that called Uniswap's PoolManager (a router), not the
   * trader, so `trader` holds that router.
   */
  viaRouter?: boolean
  /** The curve's virtual reserves right after a curve trade: enough to price the token at that moment. */
  virtualUsdc?: bigint
  virtualTokens?: bigint
  /** On the curve (the launchpad), or in the pool: v1.3's launch pool (the launch router), v1.4's Uniswap pool (the hook). */
  venue: TradeVenue
}

export function curveStateOf(launch: Pick<LaunchRecord, 'virtualUsdc' | 'virtualTokens' | 'tokensSold'>): CurveState {
  return { virtualUsdc: launch.virtualUsdc, virtualTokens: launch.virtualTokens, tokensSold: launch.tokensSold }
}

/** What the seller of a trade received, or what the buyer paid, in USDC. */
export function tradeUsdc(trade: Pick<LaunchTrade, 'isBuy' | 'usdcAmount' | 'platformFee' | 'creatorFee' | 'snipeFee'>): bigint {
  return trade.isBuy ? trade.usdcAmount : trade.usdcAmount - trade.platformFee - trade.creatorFee - (trade.snipeFee ?? 0n)
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

export function formatCurveSold(tokensSold: bigint): string {
  const whole = tokensSold / (10n ** 18n)
  const millions = whole / 1_000_000n
  const tenths = (whole % 1_000_000n) / 100_000n
  if (millions >= 10n) return `${millions.toString()}M`
  if (millions >= 1n) return tenths > 0n ? `${millions.toString()}.${tenths.toString()}M` : `${millions.toString()}M`
  if (whole >= 1_000n) return `${(whole / 1_000n).toString()}K`
  if (whole === 0n) return '0'
  return formatAmount(tokensSold, 18)
}

export function soldLabel(tokensSold: bigint): string {
  return `${formatCurveSold(tokensSold)} / 800M`
}

export function formatSpotUsd(spot: bigint): string {
  return formatUsd(spot, 24)
}

function wholeUsdc(value: bigint): bigint {
  return ((value + 500_000n) / 1_000_000n) * 1_000_000n
}

/**
 * The figures a launch is listed with. A graduated token is priced by its pool once the pool is read: its v1.3 launch
 * pool's reserves, or its v1.4 Uniswap pool's price.
 */
export function launchFacts(launch: LaunchRecord) {
  const state = curveStateOf(launch)
  const pool = launch.graduated ? launch.pool : undefined
  const v4 = launch.graduated && launchVersion(launch) === 'v14' ? launch.v4 : undefined
  return {
    price: formatSpotUsd(v4 ? v4SpotPrice(v4) : pool ? poolSpotPrice(pool) : spotPrice(state)),
    cap: formatUsd(wholeUsdc(v4 ? v4MarketCap(v4) : pool ? poolMarketCap(pool) : marketCap(state))),
    sold: soldLabel(launch.tokensSold),
    raised: formatUsd(wholeUsdc(realUsdc(state))),
    progressBps: launch.graduated ? 10_000n : progressBps(state),
    remaining: CURVE.CURVE_SUPPLY - launch.tokensSold,
    pooled: pool
      ? `${formatAmount(pool.reserveUsdc, 6)} USDC · ${formatCurveSold(pool.reserveToken)} ${launch.symbol}`
      : undefined,
  }
}

export function curvePriceImpactBps(state: CurveState, next: CurveState): bigint {
  return priceMoveBps(spotPrice(state), spotPrice(next))
}

export function poolPriceImpactBps(reserves: PoolReserves, next: PoolReserves): bigint {
  return priceMoveBps(poolSpotPrice(reserves), poolSpotPrice(next))
}

type RawCurve = {
  token: Address
  creator: Address
  pair: Address
  virtualUsdc: bigint
  virtualTokens: bigint
  tokensSold: bigint
  createdAt: bigint | number
  graduated: boolean
  creatorFeeBps: number | bigint
  pluginHooks: boolean
  plugin: Address
  metadataURI: string
}

/** A v1.3 `Curve` struct as viem returns it (named object) or as a positional tuple. */
export function asLaunchCurve(raw: unknown): Omit<LaunchRecord, 'name' | 'symbol'> {
  const row: RawCurve = Array.isArray(raw)
    ? (() => {
        const [token, creator, pair, virtualUsdc, virtualTokens, tokensSold, createdAt, graduated, creatorFeeBps, pluginHooks, plugin, metadataURI] =
          raw as unknown[]
        return {
          token: token as Address,
          creator: creator as Address,
          pair: pair as Address,
          virtualUsdc: virtualUsdc as bigint,
          virtualTokens: virtualTokens as bigint,
          tokensSold: tokensSold as bigint,
          createdAt: createdAt as bigint,
          graduated: Boolean(graduated),
          creatorFeeBps: creatorFeeBps as number,
          pluginHooks: Boolean(pluginHooks),
          plugin: plugin as Address,
          metadataURI: typeof metadataURI === 'string' ? metadataURI : '',
        }
      })()
    : (raw as RawCurve)
  return {
    token: row.token,
    creator: row.creator,
    pair: row.pair,
    virtualUsdc: BigInt(row.virtualUsdc),
    virtualTokens: BigInt(row.virtualTokens),
    tokensSold: BigInt(row.tokensSold),
    createdAt: BigInt(row.createdAt),
    graduated: Boolean(row.graduated),
    creatorFeeBps: Number(row.creatorFeeBps),
    pluginHooks: Boolean(row.pluginHooks),
    plugin: row.plugin,
    metadataURI: String(row.metadataURI ?? ''),
  }
}

type RawCurveV14 = Omit<RawCurve, 'pair'> & { createdBlock: bigint | number; openPool: boolean }

/** A v1.4 `Curve` struct as viem returns it (named object) or as a positional tuple. */
export function asLaunchCurveV14(raw: unknown): Omit<LaunchRecord, 'name' | 'symbol'> {
  const row: RawCurveV14 = Array.isArray(raw)
    ? (() => {
        const [token, creator, virtualUsdc, virtualTokens, tokensSold, createdAt, createdBlock, graduated, openPool, creatorFeeBps, pluginHooks, plugin, metadataURI] =
          raw as unknown[]
        return {
          token: token as Address,
          creator: creator as Address,
          virtualUsdc: virtualUsdc as bigint,
          virtualTokens: virtualTokens as bigint,
          tokensSold: tokensSold as bigint,
          createdAt: createdAt as bigint,
          createdBlock: createdBlock as bigint,
          graduated: Boolean(graduated),
          openPool: Boolean(openPool),
          creatorFeeBps: creatorFeeBps as number,
          pluginHooks: Boolean(pluginHooks),
          plugin: plugin as Address,
          metadataURI: typeof metadataURI === 'string' ? metadataURI : '',
        }
      })()
    : (raw as RawCurveV14)
  return {
    version: 'v14',
    token: row.token,
    creator: row.creator,
    pair: zeroAddress,
    virtualUsdc: BigInt(row.virtualUsdc),
    virtualTokens: BigInt(row.virtualTokens),
    tokensSold: BigInt(row.tokensSold),
    createdAt: BigInt(row.createdAt),
    createdBlock: BigInt(row.createdBlock),
    graduated: Boolean(row.graduated),
    openPool: Boolean(row.openPool),
    creatorFeeBps: Number(row.creatorFeeBps),
    pluginHooks: Boolean(row.pluginHooks),
    plugin: row.plugin,
    metadataURI: String(row.metadataURI ?? ''),
  }
}
