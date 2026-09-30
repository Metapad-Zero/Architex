/** Local model only: no RPC, signing, payment or bridge-verification capability. */
import { getAmountIn, getAmountOut } from './amm'

export const CHAINS = ['arc', 'base', 'solana', 'robinhood'] as const
export type DemoChain = (typeof CHAINS)[number]
export const CHAIN_NAMES: Record<DemoChain, string> = { arc: 'Arc', base: 'Base', solana: 'Solana', robinhood: 'Robinhood Chain' }
export const UNIT = 1_000_000n
export const ISSUANCE = 1_000_000n * UNIT
export const LIMITS = { maxTokens: 80n * UNIT, dailySpend: 1_000n * UNIT, dailyLoss: 10n * UNIT, buffer: UNIT, minEdge: UNIT / 4n, recoveryCost: UNIT } as const

export interface Market {
  chain: DemoChain
  tokens: bigint
  quote: bigint
  keeperTokens: bigint
  keeperQuote: bigint
  publicTokens: bigint
  health: 'healthy' | 'stale' | 'offline'
}
export interface Transfer {
  id: string
  from: DemoChain
  to: DemoChain
  amount: bigint
  status: 'pending' | 'complete'
}
export interface Candidate {
  buy: DemoChain
  sell: DemoChain
  amount: bigint
  buyCost: bigint
  sellProceeds: bigint
  cost: bigint
  edge: bigint
}
export interface Receipt {
  id: number
  kind: 'demand' | 'balance' | 'skip' | 'bridge' | 'failure' | 'recovery' | 'control'
  summary: string
  gapBefore: number
  gapAfter: number
  net: bigint
}
export interface DemoState {
  version: 1
  sequence: number
  markets: Market[]
  locked: bigint
  transfers: Transfer[]
  receipts: Receipt[]
  cost: bigint
  spent: bigint
  loss: bigint
  net: bigint
  halted: boolean
  recovery: Candidate | null
}
export type DemoAction =
  | { type: 'demand'; chain: DemoChain; quote: bigint }
  | { type: 'balance'; failSell?: boolean }
  | { type: 'recover' }
  | { type: 'health'; chain: DemoChain; health: Market['health'] }
  | { type: 'cost'; amount: bigint }
  | { type: 'bridge'; from: DemoChain; to: DemoChain; amount: bigint }
  | { type: 'complete'; id: string }

export function createDemo(): DemoState {
  return {
    version: 1, sequence: 0, locked: 750_000n * UNIT,
    markets: CHAINS.map((chain) => ({ chain, tokens: 2_500n * UNIT, quote: 2_500n * UNIT,
      keeperTokens: 250n * UNIT, keeperQuote: 1_000n * UNIT, publicTokens: 247_250n * UNIT, health: 'healthy' })),
    transfers: [], receipts: [], cost: 3n * UNIT, spent: 0n, loss: 0n, net: 0n, halted: false, recovery: null,
  }
}

function market(state: DemoState, chain: DemoChain): Market {
  const result = state.markets.find((item) => item.chain === chain)
  if (!result) throw new Error('Unknown chain.')
  return result
}
function holdings(item: Market): bigint { return item.tokens + item.keeperTokens + item.publicTokens }
export function spot(item: Market): number { return Number(item.quote) / Number(item.tokens) }
export function gap(state: DemoState): number {
  const prices = state.markets.map(spot)
  return (Math.max(...prices) / Math.min(...prices) - 1) * 100
}
export function supply(state: DemoState) {
  const arc = holdings(market(state, 'arc'))
  const remote = state.markets.filter((item) => item.chain !== 'arc').reduce((sum, item) => sum + holdings(item), 0n)
  const pending = state.transfers.filter((item) => item.status === 'pending').reduce((sum, item) => sum + item.amount, 0n)
  return { arc, remote, pending, economic: arc + remote + pending, backing: state.locked, reconciled: arc + remote + pending === ISSUANCE && state.locked === remote + pending }
}
export function treasury(state: DemoState) {
  const quote = state.markets.reduce((sum, item) => sum + item.quote + item.keeperQuote, 0n)
  const tokens = state.markets.reduce((sum, item) => sum + item.tokens + item.keeperTokens, 0n)
  return { quote, tokens, referenceValue: quote + tokens }
}

export function quoteCycle(state: DemoState): { candidate: Candidate | null; reason: string } {
  if (state.halted) return { candidate: null, reason: 'Keeper paused. Recover the failed trade before continuing.' }
  if (state.loss >= LIMITS.dailyLoss) return { candidate: null, reason: 'Loss limit reached. Reset the simulation to start a new session.' }
  const healthy = state.markets.filter((item) => item.health === 'healthy')
  if (healthy.length < 2) return { candidate: null, reason: 'Fewer than two fresh, available markets.' }
  let best: Candidate | null = null
  let positiveEdge = false
  let inventoryBlocked = false
  let budgetBlocked = false
  // Same-token exact-output buy and exact-input sale; AMM fee is already in both quotes.
  for (const buy of healthy) for (const sell of healthy) {
    if (buy.chain === sell.chain) continue
    for (let whole = 1n; whole <= LIMITS.maxTokens / UNIT; whole++) {
      const amount = whole * UNIT
      if (amount >= buy.tokens) continue
      const buyCost = getAmountIn(amount, buy.quote, buy.tokens)
      const sellProceeds = getAmountOut(amount, sell.tokens, sell.quote)
      const edge = sellProceeds - buyCost - state.cost - LIMITS.buffer
      if (edge < LIMITS.minEdge) continue
      positiveEdge = true
      if (buy.keeperQuote < buyCost + state.cost + LIMITS.recoveryCost || sell.keeperTokens < amount) { inventoryBlocked = true; continue }
      if (state.spent + buyCost + state.cost + LIMITS.recoveryCost > LIMITS.dailySpend) { budgetBlocked = true; continue }
      if (!best || edge > best.edge) best = { buy: buy.chain, sell: sell.chain, amount, buyCost, sellProceeds, cost: state.cost, edge }
    }
  }
  return { candidate: best, reason: best ? 'Executable edge covers costs and the risk buffer.'
    : !positiveEdge ? 'Price gap does not cover fees, operating costs and the risk buffer.'
      : inventoryBlocked ? 'Keeper inventory is too low on the required route.'
        : budgetBlocked ? 'Session spending limit reached.' : 'No executable route.' }
}

function record(state: DemoState, kind: Receipt['kind'], summary: string, before: number, net = 0n): void {
  state.sequence++
  state.receipts.push({ id: state.sequence, kind, summary, gapBefore: before, gapAfter: gap(state), net })
}
export function applyDemo(previous: DemoState, action: DemoAction): DemoState {
  assertDemo(previous)
  const state = structuredClone(previous)
  const before = gap(state)
  if (action.type === 'demand') {
    if (action.quote <= 0n || action.quote > 10_000n * UNIT) throw new Error('Use a demand shock between 0 and 10,000 simulated USDC.')
    const target = market(state, action.chain)
    if (target.health !== 'healthy') throw new Error('Refresh this market before adding demand.')
    const received = getAmountOut(action.quote, target.quote, target.tokens)
    target.quote += action.quote; target.tokens -= received; target.publicTokens += received
    record(state, 'demand', `${CHAIN_NAMES[action.chain]}: customer buys with ${displayUnits(action.quote)} simulated USDC.`, before)
  } else if (action.type === 'balance') {
    const decision = quoteCycle(state)
    if (!decision.candidate) { record(state, 'skip', decision.reason, before); assertDemo(state); return state }
    const c = decision.candidate
    const buy = market(state, c.buy)
    buy.quote += c.buyCost; buy.tokens -= c.amount
    buy.keeperTokens += c.amount; buy.keeperQuote -= c.buyCost + c.cost
    state.spent += c.buyCost + c.cost
    if (action.failSell) {
      state.halted = true; state.recovery = c
      record(state, 'failure', `Bought ${displayUnits(c.amount)} on ${CHAIN_NAMES[c.buy]}; sale on ${CHAIN_NAMES[c.sell]} failed. Keeper paused with an open exposure.`, before, -c.cost)
    } else {
      const sell = market(state, c.sell)
      sell.tokens += c.amount; sell.quote -= c.sellProceeds
      sell.keeperTokens -= c.amount; sell.keeperQuote += c.sellProceeds
      const net = c.sellProceeds - c.buyCost - c.cost
      state.net += net
      record(state, 'balance', `Bought ${displayUnits(c.amount)} on ${CHAIN_NAMES[c.buy]}, sold on ${CHAIN_NAMES[c.sell]}. Costs ${displayUnits(c.cost)} simulated USDC.`, before, net)
    }
  } else if (action.type === 'recover') {
    const c = state.recovery
    if (!c) throw new Error('There is no failed trade to recover.')
    const buy = market(state, c.buy)
    if (buy.health !== 'healthy') throw new Error('The purchase market must be fresh and available for recovery.')
    const proceeds = getAmountOut(c.amount, buy.tokens, buy.quote)
    const loss = c.buyCost + c.cost + LIMITS.recoveryCost - proceeds
    if (loss > LIMITS.dailyLoss - state.loss || buy.keeperQuote < LIMITS.recoveryCost || state.spent + LIMITS.recoveryCost > LIMITS.dailySpend) {
      throw new Error('Recovery exceeds the remaining loss, cash or spending limit. Keeper stays paused; reset to start a new simulation.')
    }
    buy.tokens += c.amount; buy.quote -= proceeds
    buy.keeperTokens -= c.amount; buy.keeperQuote += proceeds - LIMITS.recoveryCost
    state.loss += loss > 0n ? loss : 0n
    state.net -= loss; state.spent += LIMITS.recoveryCost
    state.recovery = null; state.halted = false
    record(state, 'recovery', `Unwound the purchase on ${CHAIN_NAMES[c.buy]}. Exposure closed within the loss limit; keeper resumed.`, before, -loss)
  } else if (action.type === 'health') {
    market(state, action.chain).health = action.health
    record(state, 'control', `${CHAIN_NAMES[action.chain]} quotes ${action.health === 'healthy' ? 'refreshed' : action.health}.`, before)
  } else if (action.type === 'cost') {
    if (action.amount < 0n || action.amount > 1_000n * UNIT) throw new Error('Operating cost must be between 0 and 1,000 simulated USDC.')
    state.cost = action.amount
    record(state, 'control', `Operating cost set to ${displayUnits(action.amount)} simulated USDC per cycle.`, before)
  } else if (action.type === 'bridge') {
    if (state.halted) throw new Error('Recover the failed trade before moving inventory.')
    if (action.from === action.to || (action.from !== 'arc' && action.to !== 'arc')) throw new Error('This model supports Arc-to-spoke and spoke-to-Arc transfers.')
    const source = market(state, action.from)
    if (source.health !== 'healthy') throw new Error('Source chain is unavailable or stale.')
    if (action.amount <= 0n || action.amount > source.keeperTokens) throw new Error('Transfer amount exceeds available keeper tokens.')
    source.keeperTokens -= action.amount
    if (action.from === 'arc') state.locked += action.amount
    const id = `transfer-${state.sequence + 1}`
    state.transfers.push({ id, from: action.from, to: action.to, amount: action.amount, status: 'pending' })
    record(state, 'bridge', `${id}: ${displayUnits(action.amount)} tokens debited on ${CHAIN_NAMES[action.from]}; awaiting ${CHAIN_NAMES[action.to]} credit.`, before)
  } else {
    const transfer = state.transfers.find((item) => item.id === action.id)
    if (!transfer) throw new Error('Unknown transfer. No destination credit was made.')
    if (transfer.status === 'complete') return previous // Duplicate delivery is an idempotent no-op.
    const target = market(state, transfer.to)
    if (target.health !== 'healthy') throw new Error('Destination chain is unavailable or stale. Transfer remains pending.')
    target.keeperTokens += transfer.amount
    if (transfer.to === 'arc') state.locked -= transfer.amount
    transfer.status = 'complete'
    record(state, 'bridge', `${transfer.id}: destination credit complete on ${CHAIN_NAMES[transfer.to]}.`, before)
  }
  assertDemo(state)
  return state
}

export function displayUnits(amount: bigint, decimals = 2): string {
  const absolute = amount < 0n ? -amount : amount
  const whole = (absolute / UNIT).toLocaleString('en-US')
  const fraction = (absolute % UNIT).toString().padStart(6, '0').slice(0, decimals)
  return `${amount < 0n ? '-' : ''}${whole}${decimals ? `.${fraction}` : ''}`
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function isChain(value: unknown): value is DemoChain { return typeof value === 'string' && CHAINS.some((chain) => chain === value) }
function atoms(value: unknown): value is bigint { return typeof value === 'bigint' && value >= 0n && value <= 10n ** 24n }
function isCandidate(value: unknown): value is Candidate {
  return isObject(value) && isChain(value.buy) && isChain(value.sell) && value.buy !== value.sell
    && ['amount', 'buyCost', 'sellProceeds', 'cost', 'edge'].every((key) => atoms(value[key]))
    && (value.amount as bigint) > 0n && (value.amount as bigint) <= LIMITS.maxTokens
}
export function assertDemo(value: unknown): asserts value is DemoState {
  const invalid = () => { throw new Error('Simulation snapshot is invalid. Reset the demo to recover.') }
  if (!isObject(value) || value.version !== 1 || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0
    || !Array.isArray(value.markets) || value.markets.length !== 4 || !Array.isArray(value.transfers) || !Array.isArray(value.receipts)
    || value.transfers.length > 2_000 || value.receipts.length > 10_000 || typeof value.halted !== 'boolean'
    || !['locked', 'cost', 'spent', 'loss'].every((key) => atoms(value[key])) || typeof value.net !== 'bigint') return invalid()
  for (const chain of CHAINS) {
    const rows: unknown[] = value.markets.filter((item: unknown) => isObject(item) && item.chain === chain)
    const row = rows[0]
    if (rows.length !== 1 || !isObject(row) || !['healthy', 'stale', 'offline'].includes(String(row.health))
      || !['tokens', 'quote', 'keeperTokens', 'keeperQuote', 'publicTokens'].every((key) => atoms(row[key]))
      || row.tokens === 0n || row.quote === 0n) return invalid()
  }
  const transferIds = new Set<string>()
  for (const row of value.transfers as unknown[]) {
    if (!isObject(row) || typeof row.id !== 'string' || !/^transfer-\d+$/.test(row.id) || transferIds.has(row.id)
      || !isChain(row.from) || !isChain(row.to) || row.from === row.to || (row.from !== 'arc' && row.to !== 'arc')
      || !atoms(row.amount) || row.amount === 0n || !['pending', 'complete'].includes(String(row.status))) return invalid()
    transferIds.add(row.id)
  }
  let lastId = 0
  for (const row of value.receipts as unknown[]) {
    if (!isObject(row) || !Number.isSafeInteger(row.id) || (row.id as number) <= lastId || (row.id as number) > (value.sequence as number)
      || typeof row.summary !== 'string' || row.summary.length > 1_000 || !['demand', 'balance', 'skip', 'bridge', 'failure', 'recovery', 'control'].includes(String(row.kind))
      || typeof row.gapBefore !== 'number' || !Number.isFinite(row.gapBefore) || typeof row.gapAfter !== 'number' || !Number.isFinite(row.gapAfter)
      || typeof row.net !== 'bigint') return invalid()
    lastId = row.id as number
  }
  if (lastId !== value.sequence || (value.recovery !== null && !isCandidate(value.recovery)) || value.halted !== (value.recovery !== null)) return invalid()
  const state = value as unknown as DemoState
  if (!supply(state).reconciled || state.cost > 1_000n * UNIT || state.spent > LIMITS.dailySpend || state.loss > LIMITS.dailyLoss) return invalid()
  if (state.recovery && market(state, state.recovery.buy).keeperTokens < state.recovery.amount) return invalid()
}
export function serializeDemo(state: DemoState): string {
  assertDemo(state)
  return JSON.stringify(state, (_key, value: unknown) => typeof value === 'bigint' ? { atoms: value.toString() } : value)
}
export function restoreDemo(json: string): DemoState {
  if (json.length > 2_000_000) throw new Error('Simulation snapshot is too large.')
  const state: unknown = JSON.parse(json, (_key, value: unknown) => {
    if (isObject(value) && Object.keys(value).length === 1 && typeof value.atoms === 'string' && /^-?\d{1,30}$/.test(value.atoms)) return BigInt(value.atoms)
    return value
  })
  assertDemo(state)
  return state
}
