import { encodeAbiParameters, getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem'
import { listedPlugin, listedPluginAt, pluginAddress, type ListedPluginKind } from '../../content/plugins/registry'
// (pluginAddress and listedPluginAt are always given ctx.suite here, never the global suite, so plans are testable.)
import type { LaunchSuite } from '../deployment'
import { formatPct, shortAddress } from '../format'
import { DEEPEN_DEFAULT_BURN_BPS } from './state'

/**
 * The token builder's choice of where creator fees go, checked the way the contracts check it and encoded the
 * way each plugin decodes it (`onLaunch`), so a launch the builder allows does not revert in the plugin.
 *
 * - Split: `abi.encode(address[] payees, uint256[] shares)`, 1–20 payees, distinct, none zero / the Split / the
 *   launchpad / USDC, every share above zero (SplitPlugin.onLaunch).
 * - Combo: `abi.encode(address[] targets, uint16[] bps, bytes[] datas)`, 1–5 entries, distinct, none zero / the
 *   Combo / the launchpad / USDC, every bps above zero, summing to 10,000; an entry that is not a plugin takes
 *   empty data (ComboPlugin.onLaunch). The builder also refuses Deepen pool beside Buyback & burn (comboRival).
 * - Deepen pool: `abi.encode(uint16 burnBps)`, 0 to 10,000 (DeepenPoolPlugin.onLaunch). Empty data would mean
 *   5,000; the builder always sends the creator's choice.
 * - Buyback & burn, Distribute to holders: empty data.
 * - A wallet or a custom address: empty data (a plain address receives USDC by transfer).
 * The plugins also check the canonical encoding, which viem's encodeAbiParameters produces.
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
  /** `burnShare`: the percentage of each pool run that buys the token and burns it, up to two decimals. */
  | { kind: 'deepen'; burnShare: string }
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

/**
 * What the chain says about the addresses typed into the builder (hooks/useDestinationProbe). Every set holds
 * lowercased addresses.
 */
export interface DestinationFacts {
  /** Declare IArchitexFeePlugin (ERC-165). */
  plugins: ReadonlySet<string>
  /** The launchpad's isLaunchPair: USDC sent to one by plain transfer can be skimmed by anyone. */
  launchPairs: ReadonlySet<string>
  /** Launch tokens (the launchpad's pluginOf is not zero): they cannot pass USDC on. */
  launchTokens: ReadonlySet<string>
  /** Typed but not answered for yet: a plan naming one waits, rather than risk a refused launch. */
  unchecked: ReadonlySet<string>
  /** The launchpad's own router() and pairFactory(), as the launchpad reports them. */
  router?: Address
  pairFactory?: Address
}

export interface PlanContext {
  /** The connected wallet: what an empty Creator wallet field means. */
  creator?: Address
  usdc: Address
  suite: LaunchSuite
  /** Other Architex contracts that would strand USDC sent to them (core factory, router, lens). */
  architexContracts?: readonly Address[]
  /** Uniswap's PoolManager, where v1.4 pools live: USDC sent to it by plain transfer is anyone's to take. */
  poolManager?: Address
  /** On-chain facts about the typed addresses; without them only the static checks run. */
  facts?: DestinationFacts
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

/**
 * Why `address` cannot receive fees in this role, or undefined if it can. The launchpad refuses a plugin, and the
 * Split and Combo refuse a payee or entry, that is zero, the launchpad, USDC, the launch router or pair factory,
 * any launch pair or any launch token (V13-SPEC §2.1, §2.2); a listed plugin as a payee, or anything declaring the
 * plugin interface, is refused here too, because USDC paid straight to a plugin is credited to no token.
 */
function refuse(address: Address, role: Recipient, ctx: PlanContext): string | undefined {
  if (address === zeroAddress) return 'The zero address cannot receive fees.'
  if (same(address, ctx.suite.launchpad)) return 'That is the launchpad. It cannot receive its own fees.'
  if (same(address, ctx.usdc)) return 'That is the USDC contract. USDC sent to it is lost.'
  if (ctx.poolManager && ctx.poolManager !== zeroAddress && same(address, ctx.poolManager)) {
    return 'That is Uniswap’s PoolManager. Anyone could take fees sent to it, so it cannot receive them.'
  }
  const facts = ctx.facts
  const id = address.toLowerCase()
  if (facts?.launchPairs.has(id)) return 'That is a launch pool. Anyone could take fees sent to it, so it cannot receive them.'
  if (facts?.launchTokens.has(id)) return 'That is a launch token. It cannot pass fees on, so they would be stuck.'
  const architex = [
    ctx.suite.launchRouter,
    ctx.suite.launchPairFactory,
    ...(facts?.router ? [facts.router] : []),
    ...(facts?.pairFactory ? [facts.pairFactory] : []),
    ...(ctx.architexContracts ?? []),
  ]
  if (architex.some((contract) => contract !== zeroAddress && same(address, contract))) {
    return 'That is an Architex contract. It cannot pass USDC on, so the fees would be stuck.'
  }
  const listed = listedPluginAt(address, ctx.suite)
  if (listed) {
    if (listed.paused && role !== 'payee') return `That is the ${listed.name} plugin, which is paused for new launches.`
    if (role === 'payee') return `That is the ${listed.name} plugin. USDC a Split pays it is credited to no token and is lost.`
    if (role === 'entry') {
      return listed.kind === 'combo' ? 'A Combo cannot include itself.' : `That is the ${listed.name} plugin. Add it as its own destination so it is set up.`
    }
    return `That is the ${listed.name} plugin. Choose it from the list so it is set up.`
  }
  if (role === 'payee' && facts?.plugins.has(id)) {
    return 'That address is a fee plugin. USDC a Split pays it is credited to no token and is lost.'
  }
  // Last, so a known answer above always wins over "still checking".
  if (facts?.unchecked.has(id)) return 'Checking this address on Arc…'
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

export function encodeBurnShareData(burnBps: number): Hex {
  return encodeAbiParameters([{ type: 'uint16' }], [burnBps])
}

/** Deepen pool's burn share, checked like DeepenPoolPlugin.onLaunch (0 to 10,000 bps); the error keyed under `prefix`. */
function planBurnShare(text: string, prefix: string, errors: Record<string, string>): Hex | undefined {
  const share = parsePercentBps(text, TOTAL_BPS)
  if (share.error !== undefined) {
    errors[`${prefix}burnShare`] = share.error
    return undefined
  }
  return encodeBurnShareData(share.bps)
}

/**
 * The listed plugin a Combo may not hold beside `kind`, if any. Deepen pool and Buyback & burn each pace their own
 * spending, so together they spend twice as fast and a trader buying ahead of the runs is paid sooner; with Buyback &
 * burn v1, whose pot can be drained in one transaction, a Deepen pool run rides that drain too (V13-SPEC §2.3, §9).
 * Deepen pool's burn share does Buyback & burn's job under one budget, so the builder never pairs them.
 */
export function comboRival(kind: SimpleTarget['kind']): SimpleTarget['kind'] | undefined {
  if (kind === 'deepen') return 'buyback'
  if (kind === 'buyback') return 'deepen'
  return undefined
}

function listedAddress(kind: ListedPluginKind, key: string, ctx: PlanContext, errors: Record<string, string>): Address | undefined {
  const plugin = listedPlugin(kind)
  const address = pluginAddress(plugin, ctx.suite)
  if (address === zeroAddress) {
    errors[key] = `${plugin.name} is not deployed on this network yet.`
    return undefined
  }
  if (plugin.paused) {
    errors[key] = `${plugin.name} is paused for new launches.`
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
    case 'deepen': {
      const address = listedAddress('deepen', fieldKey, ctx, errors)
      const data = planBurnShare(target.burnShare, prefix, errors)
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
  const kinds = new Set<SimpleTarget['kind']>()
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
    // Checked on the kinds alone, so it holds whether or not Buyback & burn is paused.
    const rival = comboRival(entry.target.kind)
    if (rival && kinds.has(rival)) {
      errors[`${prefix}target`] =
        'Deepen pool and Buyback & burn cannot share a Combo: each paces its own spending, so together they spend twice as fast, which weakens the protection against traders buying ahead of the runs. Use Deepen pool’s burn share instead.'
      continue
    }
    kinds.add(entry.target.kind)
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
    case 'deepen':
      return { kind: 'deepen', burnShare: bpsToPercentText(DEEPEN_DEFAULT_BURN_BPS) }
    case 'holders':
      return { kind: 'holders' }
  }
}
