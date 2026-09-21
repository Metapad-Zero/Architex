import { encodeAbiParameters, getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem'
import { listedPlugin, listedPluginAt, pluginAddress, type ListedPluginKind } from '../../content/plugins/registry'
// (pluginAddress and listedPluginAt are always given ctx.suite here, never the global suite, so plans are testable.)
import type { LaunchSuite } from '../deployment'
import { formatPct, shortAddress } from '../format'

/**
 * The token builder's choice of where creator fees go, checked the way the contracts check it and encoded the
 * way each plugin decodes it (`onLaunch`), so a launch the builder allows does not revert in the plugin.
 *
 * - Split: `abi.encode(address[] payees, uint256[] shares)`, 1–20 payees, distinct, none zero / the Split / the
 *   launchpad / USDC, every share above zero (SplitPlugin.onLaunch).
 * - Combo: `abi.encode(address[] targets, uint16[] bps, bytes[] datas)`, 1–5 entries, distinct, none zero / the
 *   Combo / the launchpad / USDC, every bps above zero, summing to 10,000; an entry that is not a plugin takes
 *   empty data (ComboPlugin.onLaunch).
 * - Buyback & burn, Distribute to holders: empty data.
 * - A wallet or a custom address: empty data (a plain address receives USDC by transfer).
 * Both plugins also check the canonical encoding, which viem's encodeAbiParameters produces.
 */

export const MAX_PAYEES = 20
export const MAX_COMBO_ENTRIES = 5
export const TOTAL_BPS = 10_000
export const MAX_CREATOR_FEE_BPS = 1_000
/** Split shares are weights; this keeps them to numbers a person means. */
export const MAX_SHARE = 1_000_000_000n

export interface PayeeRow {
  id: string
  address: string
  share: string
}

/** A destination with no allocation of its own: the whole plan, or one Combo entry. */
export type SimpleTarget =
  | { kind: 'wallet'; address: string }
  | { kind: 'split'; payees: PayeeRow[] }
  | { kind: 'buyback' }
  | { kind: 'holders' }
  | { kind: 'custom'; address: string }

export interface ComboEntry {
  id: string
  target: SimpleTarget
  /** Percentage of the fees, up to two decimals. */
  percent: string
}

export type FeePlan = SimpleTarget | { kind: 'combo'; entries: ComboEntry[] }
export type FeePlanKind = FeePlan['kind']

export interface PlanContext {
  /** The connected wallet: what an empty Creator wallet field means. */
  creator?: Address
  usdc: Address
  suite: LaunchSuite
  /** Other Architex contracts that would strand USDC sent to them (core factory, router, lens). */
  architexContracts?: readonly Address[]
  /** Addresses an on-chain ERC-165 probe found to declare IArchitexFeePlugin, lowercased. */
  pluginAddresses?: ReadonlySet<string>
}

export interface PluginPlan {
  plugin: Address
  pluginData: Hex
}

export interface PlanResult {
  plan?: PluginPlan
  /** Problems keyed by field id; any one blocks the launch. */
  errors: Record<string, string>
}

let nextId = 0
export function rowId(prefix: string): string {
  nextId += 1
  return `${prefix}${nextId}`
}

/** "2.5" → 250. Up to two decimals; `maxBps` inclusive. Empty text is `empty` (0 for the fee field). */
export function parsePercentBps(text: string, maxBps: number, empty: number | undefined = undefined): { bps: number; error?: undefined } | { bps?: undefined; error: string } {
  const value = text.trim()
  if (value === '') {
    return empty === undefined ? { error: 'Enter a percentage.' } : { bps: empty }
  }
  if (!/^\d*(?:\.\d{0,2})?$/.test(value) || value === '.') return { error: 'Use a number with up to two decimals, like 2.5.' }
  const [whole = '', fraction = ''] = value.split('.')
  const bps = Number(whole || '0') * 100 + Number((fraction + '00').slice(0, 2))
  if (!Number.isFinite(bps) || bps > maxBps) return { error: `At most ${formatPct(maxBps)}.` }
  return { bps }
}

/** 250 → "2.5", for putting a value back in a field. */
export function bpsToPercentText(bps: number): string {
  const whole = Math.floor(bps / 100)
  const fraction = String(bps % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

type Recipient = 'plugin' | 'payee' | 'entry'

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Why `address` cannot receive fees in this role, or undefined if it can. */
function refuse(address: Address, role: Recipient, ctx: PlanContext): string | undefined {
  if (address === zeroAddress) return 'The zero address cannot receive fees.'
  if (same(address, ctx.suite.launchpad)) return 'That is the launchpad. It cannot receive its own fees.'
  if (same(address, ctx.usdc)) return 'That is the USDC contract. USDC sent to it is lost.'
  const architex = [ctx.suite.launchRouter, ctx.suite.launchPairFactory, ...(ctx.architexContracts ?? [])]
  if (architex.some((contract) => contract !== zeroAddress && same(address, contract))) {
    return 'That is an Architex contract. It cannot pass USDC on, so the fees would be stuck.'
  }
  const listed = listedPluginAt(address, ctx.suite)
  if (listed) {
    if (role === 'payee') return `That is the ${listed.name} plugin. USDC a Split pays it is credited to no token and is lost.`
    if (role === 'entry') {
      return listed.kind === 'combo' ? 'A Combo cannot include itself.' : `That is the ${listed.name} plugin. Add it as its own destination so it is set up.`
    }
    return `That is the ${listed.name} plugin. Choose it from the list so it is set up.`
  }
  if (role === 'payee' && ctx.pluginAddresses?.has(address.toLowerCase())) {
    return 'That address is a fee plugin. USDC a Split pays it is credited to no token and is lost.'
  }
  return undefined
}

function readAddress(text: string, fallback: Address | undefined, emptyMessage: string): { address: Address; error?: undefined } | { address?: undefined; error: string } {
  const value = text.trim()
  if (value === '') return fallback ? { address: fallback } : { error: emptyMessage }
  if (!isAddress(value)) return { error: 'That is not a valid address.' }
  return { address: getAddress(value) }
}

function checkShare(text: string): { share: bigint; error?: undefined } | { share?: undefined; error: string } {
  const value = text.trim()
  if (!/^\d+$/.test(value)) return { error: 'Shares are whole numbers, 1 or more.' }
  const share = BigInt(value)
  if (share === 0n) return { error: 'A share must be 1 or more.' }
  if (share > MAX_SHARE) return { error: 'Use a smaller share; only the ratios matter.' }
  return { share }
}

/** A Split's payees, checked like SplitPlugin.onLaunch; errors keyed under `prefix`. */
function planSplit(payees: readonly PayeeRow[], prefix: string, ctx: PlanContext, errors: Record<string, string>): Hex | undefined {
  if (payees.length === 0) errors[`${prefix}payees`] = 'Add at least one payee.'
  if (payees.length > MAX_PAYEES) errors[`${prefix}payees`] = `A Split takes at most ${MAX_PAYEES} payees.`
  const addresses: Address[] = []
  const shares: bigint[] = []
  const seen = new Set<string>()
  let ok = payees.length > 0 && payees.length <= MAX_PAYEES
  for (const row of payees) {
    const read = readAddress(row.address, undefined, 'Enter the payee’s address.')
    if (read.error !== undefined) {
      errors[`${prefix}payee:${row.id}:address`] = read.error
      ok = false
    } else {
      // The Split itself is a listed plugin, so refuse() covers "a Split cannot pay itself" too.
      const refused = refuse(read.address, 'payee', ctx)
      if (refused) {
        errors[`${prefix}payee:${row.id}:address`] = refused
        ok = false
      } else if (seen.has(read.address.toLowerCase())) {
        errors[`${prefix}payee:${row.id}:address`] = `${shortAddress(read.address)} is already a payee.`
        ok = false
      } else {
        seen.add(read.address.toLowerCase())
        addresses.push(read.address)
      }
    }
    const share = checkShare(row.share)
    if (share.error !== undefined) {
      errors[`${prefix}payee:${row.id}:share`] = share.error
      ok = false
    } else {
      shares.push(share.share)
    }
  }
  if (!ok) return undefined
  return encodeSplitData(addresses, shares)
}

export function encodeSplitData(payees: readonly Address[], shares: readonly bigint[]): Hex {
  return encodeAbiParameters([{ type: 'address[]' }, { type: 'uint256[]' }], [payees, shares])
}

export function encodeComboData(targets: readonly Address[], bps: readonly number[], datas: readonly Hex[]): Hex {
  return encodeAbiParameters([{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }], [targets, bps, datas])
}

function listedAddress(kind: ListedPluginKind, key: string, ctx: PlanContext, errors: Record<string, string>): Address | undefined {
  const plugin = listedPlugin(kind)
  const address = pluginAddress(plugin, ctx.suite)
  if (address === zeroAddress) {
    errors[key] = `${plugin.name} is not deployed on this network yet.`
    return undefined
  }
  return address
}

/** One destination: its address and its onLaunch data. */
function planTarget(target: SimpleTarget, role: 'plugin' | 'entry', prefix: string, ctx: PlanContext, errors: Record<string, string>): PluginPlan | undefined {
  const fieldKey = role === 'plugin' ? target.kind : `${prefix}target`
  switch (target.kind) {
    case 'wallet':
    case 'custom': {
      const read = readAddress(
        target.address,
        target.kind === 'wallet' ? ctx.creator : undefined,
        target.kind === 'wallet' ? 'Connect a wallet, or enter the address to pay.' : 'Enter the address to pay.',
      )
      if (read.error !== undefined) {
        errors[fieldKey] = read.error
        return undefined
      }
      const refused = refuse(read.address, role, ctx)
      if (refused) {
        errors[fieldKey] = refused
        return undefined
      }
      return { plugin: read.address, pluginData: '0x' }
    }
    case 'split': {
      const address = listedAddress('split', fieldKey, ctx, errors)
      const data = planSplit(target.payees, prefix, ctx, errors)
      return address && data ? { plugin: address, pluginData: data } : undefined
    }
    case 'buyback':
    case 'holders': {
      const address = listedAddress(target.kind, fieldKey, ctx, errors)
      return address ? { plugin: address, pluginData: '0x' } : undefined
    }
  }
}

/** The whole plan: the plugin address and the onLaunch data createToken is given, or the problems in the way. */
export function planFeePlugin(plan: FeePlan, ctx: PlanContext): PlanResult {
  const errors: Record<string, string> = {}
  if (plan.kind !== 'combo') {
    const result = planTarget(plan, 'plugin', '', ctx, errors)
    return Object.keys(errors).length === 0 && result ? { plan: result, errors } : { errors }
  }

  const combo = listedAddress('combo', 'combo', ctx, errors)
  const entries = plan.entries
  if (entries.length === 0) errors.entries = 'Add at least one destination.'
  if (entries.length > MAX_COMBO_ENTRIES) errors.entries = `A Combo takes at most ${MAX_COMBO_ENTRIES} destinations.`
  const targets: Address[] = []
  const bps: number[] = []
  const datas: Hex[] = []
  const seen = new Set<string>()
  let sum = 0
  let allPercentsRead = true
  for (const entry of entries) {
    const prefix = `entry:${entry.id}:`
    const percent = parsePercentBps(entry.percent, TOTAL_BPS)
    if (percent.error !== undefined) {
      errors[`${prefix}percent`] = percent.error
      allPercentsRead = false
    } else if (percent.bps === 0) {
      errors[`${prefix}percent`] = 'Give each destination more than 0%.'
      allPercentsRead = false
    } else {
      sum += percent.bps
      bps.push(percent.bps)
    }
    const target = planTarget(entry.target, 'entry', prefix, ctx, errors)
    if (!target) continue
    if (seen.has(target.plugin.toLowerCase())) {
      errors[`${prefix}target`] = 'That destination is already in this Combo.'
      continue
    }
    seen.add(target.plugin.toLowerCase())
    targets.push(target.plugin)
    datas.push(target.pluginData)
  }
  if (!errors.entries && allPercentsRead && entries.length > 0 && sum !== TOTAL_BPS) {
    errors.entries = `The shares add up to ${formatPct(sum)}. They must add up to 100%.`
  }
  if (Object.keys(errors).length > 0 || !combo) return { errors }
  return { plan: { plugin: combo, pluginData: encodeComboData(targets, bps, datas) }, errors }
}

/** A fresh plan of each kind, as the builder shows it when that kind is picked. */
export function emptyTarget(kind: SimpleTarget['kind'], creator?: Address): SimpleTarget {
  switch (kind) {
    case 'wallet':
      return { kind: 'wallet', address: '' }
    case 'custom':
      return { kind: 'custom', address: '' }
    case 'split':
      return { kind: 'split', payees: [{ id: rowId('p'), address: creator ?? '', share: '1' }] }
    case 'buyback':
      return { kind: 'buyback' }
    case 'holders':
      return { kind: 'holders' }
  }
}
