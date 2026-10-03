import { describe, expect, test } from 'bun:test'
import { jobSummary, shouldRefresh, usdcAmount, usdcLabel, type PublicJob } from '../equilibriumRecord'

const base: PublicJob = { id: '0x569d4379835612dc', mode: 'local', state: 'partial', payment: { settled: true, fulfillment: 'incomplete' },
  settlement: { amount: '27200000', transaction: 'local:0x1', nonce: '0x569d', fulfillment: 'incomplete' },
  supply: { issuance: '0', custody: '0', remote: '0', pending: '0', reconciled: false, evidence: 'incomplete' }, steps: [] }

describe('EQUILIBRIUM public record', () => {
  test('USDC atoms read exactly, never rounded', () => {
    expect(usdcAmount('27200000')).toBe('27.2')
    expect(usdcAmount('1000000')).toBe('1')
    expect(usdcAmount('1')).toBe('0.000001')
    expect(usdcAmount('0')).toBe('0')
    expect(usdcAmount('1234567890123')).toBe('1,234,567.890123')
    expect(usdcAmount('not-atoms')).toBe('not-atoms')
  })

  test('local money is labeled synthetic', () => {
    expect(usdcLabel('27200000', 'local')).toBe('27.2 synthetic USDC')
    expect(usdcLabel('27200000', 'testnet')).toBe('27.2 USDC')
  })

  test('open records and a failed read keep refreshing; a complete record stops', () => {
    expect(shouldRefresh([base], false)).toBe(true)
    expect(shouldRefresh([{ ...base, state: 'complete' }], false)).toBe(false)
    expect(shouldRefresh([], true)).toBe(true)
    expect(shouldRefresh([], false)).toBe(false)
  })

  test('the collapsed summary names settlement and fulfillment apart, including older records', () => {
    expect(jobSummary(base)).toBe('Local rehearsal · partial · Settled · fulfillment incomplete · 0x569d437983')
    expect(jobSummary({ ...base, state: 'complete' })).toContain('Settled · fulfilled')
    expect(jobSummary({ ...base, settlement: undefined })).toContain('Payment settled, no settlement record')
    expect(jobSummary({ ...base, state: 'awaiting_payment', settlement: null, payment: { settled: false, fulfillment: 'incomplete' } })).toContain('Not settled · not started')
  })
})
