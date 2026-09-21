import type { Address, Hash } from 'viem'
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

export const NAME_MAX_BYTES = 32
export const SYMBOL_MAX_BYTES = 10
export const METADATA_MAX_BYTES = 256
export const PAGE_SIZE = 50n
export const GRADUATES_AT_USD = '$100,000'

export interface LaunchRecord {
  token: Address
  creator: Address
  /** The token's launch pool (launch-pair factory); it holds liquidity only after graduation. */
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
  /** The launch pool's reserves; read only once a token has graduated. */
  pool?: PoolReserves
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
  /** The curve's virtual reserves right after a curve trade: enough to price the token at that moment. */
  virtualUsdc?: bigint
  virtualTokens?: bigint
  /** On the curve (the launchpad) or in the launch pool (the launch router). */
  venue: TradeVenue
}

export function curveStateOf(launch: Pick<LaunchRecord, 'virtualUsdc' | 'virtualTokens' | 'tokensSold'>): CurveState {
  return { virtualUsdc: launch.virtualUsdc, virtualTokens: launch.virtualTokens, tokensSold: launch.tokensSold }
}

/** What the seller of a trade received, or what the buyer paid, in USDC. */
export function tradeUsdc(trade: Pick<LaunchTrade, 'isBuy' | 'usdcAmount' | 'platformFee' | 'creatorFee'>): bigint {
  return trade.isBuy ? trade.usdcAmount : trade.usdcAmount - trade.platformFee - trade.creatorFee
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

/** The figures a launch is listed with. A graduated token is priced by its launch pool once the pool is read. */
export function launchFacts(launch: LaunchRecord) {
  const state = curveStateOf(launch)
  const pool = launch.graduated ? launch.pool : undefined
  return {
    price: formatSpotUsd(pool ? poolSpotPrice(pool) : spotPrice(state)),
    cap: formatUsd(wholeUsdc(pool ? poolMarketCap(pool) : marketCap(state))),
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
