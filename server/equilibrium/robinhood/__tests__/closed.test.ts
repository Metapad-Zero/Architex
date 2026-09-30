import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { LaunchError } from '../../types'
import { DEV } from '../../evm/fork'
import { localGuardian } from '../../evm/vaa'
import { robinhoodClosedAdapter, robinhoodStatus } from '../adapter'
import { ROBINHOOD_DECISIONS, ROBINHOOD_MAINNET, ROBINHOOD_TESTNET } from '../pins'
import { layout, robinhoodRoute, type RobinhoodRouteConfig } from '../route'

const chain = (side: 'arc' | 'robinhood', rpc: string) => ({ side, rpc, chainId: side === 'arc' ? 5042002 : 4663, wormholeChainId: side === 'arc' ? 71 : 72,
  core: '0x0000000000000000000000000000000000000c01' as const, executor: '0x0000000000000000000000000000000000000e01' as const,
  transceiverStructs: '0x0000000000000000000000000000000000000501' as const, confirmations: 0, fromBlock: 1n })
function config(rpc: { arc: string; robinhood: string }): RobinhoodRouteConfig {
  return { mode: 'fork', environment: 'mixed:arc-testnet-fork+robinhood-mainnet-fork', operatorKey: DEV.operator,
    arc: chain('arc', rpc.arc),
    robinhood: { ...chain('robinhood', rpc.robinhood), venue: { factory: ROBINHOOD_MAINNET.venue.factory, quoterV2: ROBINHOOD_MAINNET.venue.quoterV2, fee: 3000, tickSpacing: 60 }, quote: ROBINHOOD_MAINNET.usdgFixture },
    vaa: { arc: localGuardian(DEV.guardian, 0), robinhood: localGuardian(DEV.guardian, 7) },
    limits: { outbound: 1_000n, inbound: 1_000n }, asset: { id: 'unit', name: 'Equilibrium', symbol: 'EQL', issuance: 1_000_000n } }
}
const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return e instanceof LaunchError ? e.code : String(e) } }

describe('Robinhood spoke stays closed', () => {
  test('the public adapter refuses every entry point in testnet and live mode, naming each missing decision', () => {
    for (const mode of ['testnet', 'live'] as const) {
      const adapter = robinhoodClosedAdapter(mode)
      expect(code(() => adapter.assertReady({} as never))).toBe('route_closed')
      expect(code(() => adapter.budgets({} as never))).toBe('route_closed')
      expect(code(() => adapter.prepare({} as never))).toBe('route_closed')
      expect(code(() => adapter.observe({} as never, {} as never))).toBe('route_closed')
      expect(code(() => adapter.broadcast({} as never, {} as never))).toBe('route_closed')
      try { adapter.assertReady({} as never) } catch (e) { for (const d of ROBINHOOD_DECISIONS) expect(String((e as Error).message)).toContain(d.key) }
    }
  })
  test('status reports no deployments, a provisional USDG fixture and an undocumented testnet', () => {
    const s = robinhoodStatus()
    expect(s.route).toBe('closed')
    expect(Object.values(s.deployments).every((x) => x === null)).toBe(true)
    expect(s.quoteAsset.status).toBe('provisional-fork-fixture')
    expect(s.testnet.core).toBeNull(); expect(ROBINHOOD_TESTNET.wormholeChainId).toBeNull()
  })
  test('the route engine refuses public RPCs, non-fork modes and unlabelled environments', () => {
    const db = new Database(':memory:')
    expect(code(() => robinhoodRoute(config({ arc: 'https://rpc.testnet.arc.io', robinhood: 'http://127.0.0.1:1' }), db))).toBe('route_closed')
    expect(code(() => robinhoodRoute(config({ arc: 'http://127.0.0.1:1', robinhood: ROBINHOOD_MAINNET.rpc }), db))).toBe('route_closed')
    expect(code(() => robinhoodRoute(config({ arc: 'http://127.0.0.1.evil.example:1', robinhood: 'http://127.0.0.1:2' }), db))).toBe('route_closed')
    expect(code(() => robinhoodRoute({ ...config({ arc: 'http://127.0.0.1:1', robinhood: 'http://127.0.0.1:2' }), mode: 'testnet' as never }, db))).toBe('route_closed')
    expect(code(() => robinhoodRoute({ ...config({ arc: 'http://127.0.0.1:1', robinhood: 'http://127.0.0.1:2' }), environment: 'robinhood-mainnet' as never }, db))).toBe('route_closed')
    expect(code(() => robinhoodRoute(config({ arc: 'http://127.0.0.1:1', robinhood: 'http://localhost:2' }), db))).toBe('ok')
  })
  test('a transfer id binds once: other parameters conflict, amounts above the NTT limit are refused before any debit', () => {
    const route = robinhoodRoute(config({ arc: 'http://127.0.0.1:1', robinhood: 'http://127.0.0.1:2' }), new Database(':memory:'))
    const to = '0x00000000000000000000000000000000000000a1'
    expect(route.transfer('t1', 'outbound', 10n, to).state).toBe('planned')
    expect(route.transfer('t1', 'outbound', 10n, to).state).toBe('planned')
    expect(code(() => route.transfer('t1', 'outbound', 11n, to))).toBe('transfer_conflict')
    expect(code(() => route.transfer('t1', 'return', 10n, to))).toBe('transfer_conflict')
    expect(code(() => route.transfer('t2', 'outbound', 1_001n, to))).toBe('rate_limit')
    expect(code(() => route.transfer('t3', 'outbound', 0n, to))).toBe('amount')
  })
  test('addresses derive from the asset id and executors alone, before anything exists', () => {
    const a = layout(config({ arc: 'http://127.0.0.1:1', robinhood: 'http://127.0.0.1:2' }))
    const b = layout({ ...config({ arc: 'http://127.0.0.1:1', robinhood: 'http://127.0.0.1:2' }), asset: { id: 'other', name: 'Equilibrium', symbol: 'EQL', issuance: 1_000_000n } })
    expect(a.spoke).not.toBe(b.spoke); expect(a.canonical).not.toBe(b.canonical)
    expect(new Set([a.canonical, a.hub.proxy, a.hub.transceiver, a.spoke, a.spokeManager.proxy, a.spokeManager.transceiver]).size).toBe(6)
  })
})
