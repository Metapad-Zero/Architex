import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { KeeperStore } from '../store'
import { KeeperError, type CycleCandidate, type LegPlan, type LegResult } from '../types'
import { POLICY } from './fixtures'

const candidate: CycleCandidate = { tokens: '1000000000', buy: 'arc', sell: 'base', buyCost: '1005000000', sellProceeds: '1194000000', cost: '2600000', edge: '185900000' }

function plan(cycle: string, kind: LegPlan['kind'], chain: LegPlan['chain'], over: Partial<LegPlan> = {}): LegPlan {
  return {
    chain, chainId: chain === 'arc' ? 5042002 : 84532, keeper: '0x00000000000000000000000000000000000000c1', cycle, kind,
    id: `0x${kind.padEnd(64, '0')}`, digest: `0x${kind.padStart(64, '1')}`,
    pool: '0x00000000000000000000000000000000000000a1', tokens: '1000000000', limit: '1010000000', deadline: 1_800_000_600,
    fromBlock: '1000', ...over,
  }
}
const result = (over: Partial<LegResult> = {}): LegResult => ({ transaction: '0xtx', amountIn: '1005000000', amountOut: '1000000000', cost: '250000', finalized: true, ...over })

let dir: string
let store: KeeperStore

describe('keeper durable record', () => {
  beforeEach(() => {
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    dir = mkdtempSync(join(process.cwd(), 'output', 'keeper-store-'))
    store = new KeeperStore(join(dir, 'keeper.sqlite'))
  })
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  test('refuses an ephemeral record, because a lost position is real money', () => {
    expect(() => new KeeperStore('/tmp/keeper-should-be-refused.sqlite')).toThrow(/temporary path/)
    expect(() => new KeeperStore(':memory:')).toThrow(/in-memory/)
  })

  test('opening the same cycle twice is idempotent, with a different plan refused', () => {
    const first = store.open('cycle-1', candidate, 1, POLICY.maxOpenCycles)
    expect(store.open('cycle-1', candidate, 2, POLICY.maxOpenCycles).id).toBe(first.id)
    expect(() => store.open('cycle-1', { ...candidate, tokens: '1' }, 3, POLICY.maxOpenCycles)).toThrow(/different plan/)
  })

  test('a second open cycle is refused while the first is unresolved', () => {
    store.open('cycle-1', candidate, 1, 1)
    expect(() => store.open('cycle-2', candidate, 2, 1)).toThrow(KeeperError)
    expect(() => store.open('cycle-2', candidate, 2, 1)).toThrow(/Resolve them before opening another/)
  })

  test('a leg is planned once; re-planning it under a different id is refused', () => {
    store.open('cycle-1', candidate, 1, 1)
    const buy = plan('cycle-1', 'buy', 'arc')
    expect(store.planLeg(buy).state).toBe('planned')
    expect(store.planLeg(buy).state).toBe('planned')
    expect(() => store.planLeg({ ...buy, id: '0xdead', digest: '0xbeef' })).toThrow(/planned once/)
  })

  test('a settled leg cannot be re-settled by a different transaction', () => {
    store.open('cycle-1', candidate, 1, 1)
    const buy = store.planLeg(plan('cycle-1', 'buy', 'arc')).plan
    store.settleLeg(buy, result(), 2)
    store.settleLeg(buy, result(), 3)
    expect(() => store.settleLeg(buy, result({ transaction: '0xother' }), 4)).toThrow(/already settled/)
  })

  test('a settled purchase with no sale is the exposure a restart must resolve', () => {
    store.open('cycle-1', candidate, 1, 1)
    const buy = store.planLeg(plan('cycle-1', 'buy', 'arc')).plan
    expect(store.unresolved()).toHaveLength(0)
    store.settleLeg(buy, result(), 2)
    expect(store.unresolved().map((cycle) => cycle.id)).toEqual(['cycle-1'])
    const sell = store.planLeg(plan('cycle-1', 'sell', 'base')).plan
    // A planned-but-unsettled sale is still exposure.
    expect(store.unresolved()).toHaveLength(1)
    store.settleLeg(sell, result({ transaction: '0xsell', amountIn: '1000000000', amountOut: '1194000000' }), 3)
    expect(store.unresolved()).toHaveLength(0)
  })

  test('a recovery closes the exposure just as a sale does', () => {
    store.open('cycle-1', candidate, 1, 1)
    store.settleLeg(store.planLeg(plan('cycle-1', 'buy', 'arc')).plan, result(), 2)
    store.setCycle('cycle-1', 'halted', 3, { note: 'sale failed' })
    expect(store.unresolved()).toHaveLength(1)
    store.settleLeg(store.planLeg(plan('cycle-1', 'recover', 'arc')).plan, result({ transaction: '0xrec', amountIn: '1000000000', amountOut: '990000000' }), 4)
    expect(store.unresolved()).toHaveLength(0)
  })

  test('a cycle that sent nothing is untouched and safe to abandon', () => {
    store.open('cycle-1', candidate, 1, 1)
    store.planLeg(plan('cycle-1', 'buy', 'arc'))
    expect(store.untouched().map((cycle) => cycle.id)).toEqual(['cycle-1'])
    store.settleLeg(plan('cycle-1', 'buy', 'arc'), result(), 2)
    expect(store.untouched()).toHaveLength(0)
  })

  test('the record survives the process: a new store on the same file sees the same exposure', () => {
    const path = join(dir, 'keeper.sqlite')
    store.open('cycle-1', candidate, 1, 1)
    store.settleLeg(store.planLeg(plan('cycle-1', 'buy', 'arc')).plan, result(), 2)
    store.recordSend(plan('cycle-1', 'buy', 'arc'), '0xtx', 3)
    store.close()
    const reopened = new KeeperStore(path)
    try {
      expect(reopened.unresolved().map((cycle) => cycle.id)).toEqual(['cycle-1'])
      expect(reopened.get('cycle-1')!.legs[0].result!.amountIn).toBe('1005000000')
      expect(reopened.sendsFor(plan('cycle-1', 'buy', 'arc').id)).toEqual(['0xtx'])
    } finally { reopened.close() }
    store = new KeeperStore(path)
  })

  test('totals report realized loss and net separately, from closed cycles only', () => {
    store.open('cycle-1', candidate, 1, 2)
    store.setCycle('cycle-1', 'closed', 2, { net: '185000000' })
    store.open('cycle-2', candidate, 3, 2)
    store.setCycle('cycle-2', 'recovered', 4, { net: '-15000000' })
    store.open('cycle-3', candidate, 5, 3)
    expect(store.totals()).toEqual({ loss: '15000000', net: '170000000', closed: 2 })
  })

  test('every decision is recorded so a refusal can be re-derived from its numbers', () => {
    store.recordSnapshot(1, null, { reason: 'no_edge' })
    store.recordSnapshot(2, 'cycle-1', { reason: 'ok' })
    expect(store.snapshots(2).map((row) => row.cycle)).toEqual(['cycle-1', null])
  })
})
