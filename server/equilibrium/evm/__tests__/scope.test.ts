import { describe, expect, test } from 'bun:test'
import type { Address } from 'viem'
import { JobStore } from '../../store'
import { identity } from '../../request'
import type { LaunchRequest } from '../../types'
import { evmAdapter } from '../adapter'
import type { ChainConfig, EvmAdapterConfig, PilotScope } from '../types'
import { localGuardian } from '../vaa'

const PAYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' as Address
const RECIPIENT = '0x00000000000000000000000000000000000000a1' as Address
const chain = (name: 'arc' | 'base'): ChainConfig => ({ chain: name, rpc: 'http://127.0.0.1:1', chainId: name === 'arc' ? 5042002 : 84532, wormholeChainId: name === 'arc' ? 71 : 10004,
  core: '0x00000000000000000000000000000000000000c0', executor: '0x00000000000000000000000000000000000000e1', transceiverStructs: '0x00000000000000000000000000000000000000aa',
  usdc: '0x00000000000000000000000000000000000000d0', finality: 'finalized', usdcAtomsPerNative: 1_000_000n, fromBlock: 0n,
  venue: name === 'arc' ? { kind: 'architex', factory: '0x00000000000000000000000000000000000000f0' } : { kind: 'uniswap-v3', factory: '0x00000000000000000000000000000000000000f1', fee: 3000, tickSpacing: 60 } })
const destinations = [
  { chain: 'arc' as const, amount: '990000000000', poolTokens: '5000000000', poolQuote: '100000000' },
  { chain: 'base' as const, amount: '10000000000', poolTokens: '5000000000', poolQuote: '100000000' },
]
const scope: PilotScope = { launches: 1, payer: PAYER, recipient: RECIPIENT, issuance: '1000000000000', destinations, maxTotal: '219000000', operatorGas: { arc: '1', base: '1' } }
const config: EvmAdapterConfig = { mode: 'testnet', operatorKey: `0x${'1'.repeat(64)}`, arc: chain('arc'), base: chain('base'), vaa: localGuardian(`0x${'2'.repeat(64)}`, 0),
  limits: { outbound: 10_000_000_000n, inbound: 10_000_000_000n }, scope,
  budgets: { payment: '1000000', canonical: '2000000', manager: '5000000', debit: '1000000', credit: '1000000', pool: '2000000' } }
const request = (requestId = 'pilot-0001'): LaunchRequest => ({ requestId, payer: PAYER, quote: { expires: 2_000_000_000, costCap: '219000000' },
  canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient: RECIPIENT },
  destinations: destinations.map((d) => ({ ...d, recipient: RECIPIENT })) })

describe('the approved pilot scope', () => {
  const store = new JobStore(':memory:')
  const adapter = evmAdapter(config, store.db)
  const refuses = (r: LaunchRequest, text: string) => expect(() => adapter.assertReady(r)).toThrow(text)

  test('accepts exactly the approved payer, recipient and allocation at 219 USDC', () => {
    expect(() => adapter.assertReady(request())).not.toThrow()
  })
  test('refuses another payer, recipient, issuance or allocation', () => {
    refuses({ ...request(), payer: '0x00000000000000000000000000000000000000b2' }, 'approved payer')
    refuses({ ...request(), canonical: { ...request().canonical, recipient: '0x00000000000000000000000000000000000000b2' } }, 'approved recipient')
    refuses({ ...request(), canonical: { ...request().canonical, issuance: '2000000000000' } }, 'issuance differs')
    refuses({ ...request(), destinations: request().destinations.map((d) => ({ ...d, poolQuote: '200000000' })) }, 'destinations differ')
  })
  test('refuses a total above the approved cap even for the approved allocation', () => {
    const tight = evmAdapter({ ...config, scope: { ...scope, maxTotal: '218999999' } }, store.db)
    expect(() => tight.assertReady(request())).toThrow('exceeds the approved')
  })
  test('one paid launch uses the approval: it may resume, a second may not start', () => {
    const paid = request('pilot-0001')
    store.db.query('INSERT INTO jobs(identity, id, data, revision) VALUES(?, ?, ?, 0)').run(identity(paid), `0x${'9'.repeat(64)}`, JSON.stringify({ payment: {} }))
    expect(() => adapter.assertReady(paid)).not.toThrow()
    refuses(request('pilot-0002'), 'already hold an authorization')
  })
})
