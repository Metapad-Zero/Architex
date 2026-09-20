import type { Address, Hash } from 'viem'
import { CURVE, marketCap, progressBps, realUsdc, spotPrice, type CurveState } from './curve'
import { formatAmount, formatUsd } from './format'

export const NAME_MAX_BYTES = 32
export const SYMBOL_MAX_BYTES = 10
export const METADATA_MAX_BYTES = 256
export const PAGE_SIZE = 50n
export const GRADUATES_AT_USD = '$35,000'

export interface LaunchRecord {
  token: Address
  creator: Address
  pair: Address
  virtualUsdc: bigint
  virtualTokens: bigint
  tokensSold: bigint
  createdAt: bigint
  graduated: boolean
  metadataURI: string
  name: string
  symbol: string
}

export interface LaunchTrade {
  trader: Address
  isBuy: boolean
  usdcAmount: bigint
  tokenAmount: bigint
  fee: bigint
  time: number
  txHash: Hash
  block: number
  /** Position in the block; tells apart two trades made by one transaction. */
  logIndex?: number
  /** The curve's virtual reserves right after this trade: enough to price the token at that moment. */
  virtualUsdc?: bigint
  virtualTokens?: bigint
}

export function curveStateOf(launch: Pick<LaunchRecord, 'virtualUsdc' | 'virtualTokens' | 'tokensSold'>): CurveState {
  return { virtualUsdc: launch.virtualUsdc, virtualTokens: launch.virtualTokens, tokensSold: launch.tokensSold }
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

export function launchFacts(launch: LaunchRecord) {
  const state = curveStateOf(launch)
  return {
    price: formatSpotUsd(spotPrice(state)),
    cap: formatUsd(wholeUsdc(marketCap(state))),
    sold: soldLabel(launch.tokensSold),
    raised: formatUsd(wholeUsdc(realUsdc(state))),
    progressBps: launch.graduated ? 10_000n : progressBps(state),
    remaining: CURVE.CURVE_SUPPLY - launch.tokensSold,
  }
}

export function curvePriceImpactBps(state: CurveState, next: CurveState): bigint {
  const before = spotPrice(state)
  const after = spotPrice(next)
  if (before === 0n) return 0n
  const delta = after > before ? after - before : before - after
  return (delta * 10_000n) / before
}

export function asLaunchCurve(raw: unknown): Omit<LaunchRecord, 'name' | 'symbol'> {
  if (Array.isArray(raw)) {
    const [token, creator, pair, virtualUsdc, virtualTokens, tokensSold, createdAt, graduated, metadataURI] = raw as [
      Address,
      Address,
      Address,
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
      string,
    ]
    return {
      token,
      creator,
      pair,
      virtualUsdc: BigInt(virtualUsdc),
      virtualTokens: BigInt(virtualTokens),
      tokensSold: BigInt(tokensSold),
      createdAt: BigInt(createdAt),
      graduated: Boolean(graduated),
      metadataURI: String(metadataURI ?? ''),
    }
  }
  const row = raw as {
    token: Address
    creator: Address
    pair: Address
    virtualUsdc: bigint
    virtualTokens: bigint
    tokensSold: bigint
    createdAt: bigint | number
    graduated: boolean
    metadataURI: string
  }
  return {
    token: row.token,
    creator: row.creator,
    pair: row.pair,
    virtualUsdc: BigInt(row.virtualUsdc),
    virtualTokens: BigInt(row.virtualTokens),
    tokensSold: BigInt(row.tokensSold),
    createdAt: BigInt(row.createdAt),
    graduated: row.graduated,
    metadataURI: row.metadataURI,
  }
}
