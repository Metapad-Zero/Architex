import { describe, expect, test } from 'bun:test'
import { MAX_FAILED_READS, REFRESH_MS, fulfillment, jobSummary, recoveryNote, refreshDelay, shouldRefresh, supplyNote, supplyWithheld, usdcAmount, usdcLabel, type PublicJob } from '../equilibriumRecord'

const base: PublicJob = { id: '0x569d4379835612dc', mode: 'local', state: 'partial', payment: { settled: true, fulfillment: 'incomplete' },
  settlement: { amount: '27200000', transaction: 'local:0x1', nonce: '0x569d', fulfillment: 'incomplete' },
  recovery: { automatic: true, reason: 'pending_evidence' },
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

  test('only explicitly recoverable authorized work refreshes, including alongside unpaid quotes', () => {
    const unpaid = { ...base, state: 'awaiting_payment', settlement: null, payment: { settled: false, fulfillment: 'not_started' }, recovery: { automatic: false, reason: 'awaiting_payment' } }
    const blocked = { ...base, recovery: { automatic: false, reason: 'blocked' }, error: 'Unsettled authorization expired' }
    expect(shouldRefresh([base])).toBe(true)
    expect(shouldRefresh([unpaid, base])).toBe(true)
    expect(shouldRefresh([unpaid])).toBe(false)
    expect(shouldRefresh([blocked])).toBe(false)
    expect(shouldRefresh([{ ...base, recovery: undefined }])).toBe(false)
    expect(shouldRefresh([{ ...base, state: 'complete' }])).toBe(false)
    expect(shouldRefresh([])).toBe(false)
  })

  test('outage retries back off and stop, even when the last good record can recover', () => {
    expect(refreshDelay([base], 0)).toBe(REFRESH_MS)
    expect(refreshDelay([base], 1)).toBe(REFRESH_MS)
    expect(refreshDelay([base], 2)).toBe(2 * REFRESH_MS)
    expect(refreshDelay([base], MAX_FAILED_READS)).toBeNull()
    expect(refreshDelay([], 1)).toBe(REFRESH_MS)
    expect(refreshDelay([], MAX_FAILED_READS)).toBeNull()
    expect(refreshDelay([{ ...base, recovery: { automatic: false, reason: 'blocked' } }], 1)).toBeNull()
    // A successful manual read resets the consecutive failure count and restores eligible reads.
    expect(refreshDelay([base], 0)).toBe(REFRESH_MS)
  })

  test('unpaid planned jobs describe no issuance and no fulfillment', () => {
    const unpaid: PublicJob = { ...base, state: 'awaiting_payment', settlement: null, payment: { settled: false, fulfillment: 'incomplete' },
      steps: [{ id: 'canonical:arc', chain: 'arc', state: 'planned' }] }
    expect(fulfillment(unpaid)).toBe('not_started')
    expect(supplyNote(unpaid)).toContain('Issuance has not started')
    expect(recoveryNote(unpaid)).toContain('No authorization is held')
  })

  test('new withheld and older stale prepared records cannot display a supply vector', () => {
    const ambiguous = { ...base, steps: [{ id: 'credit:base', chain: 'base', state: 'prepared' }] }
    expect(supplyWithheld(ambiguous)).toBe(true)
    expect(supplyNote(ambiguous)).toContain('withheld until finalized receipts')
    expect(supplyWithheld({ ...base, supply: { ...base.supply, evidence: 'withheld', remote: null } })).toBe(true)
    expect(supplyWithheld({ ...ambiguous, steps: [{ id: 'credit:base', chain: 'base', state: 'complete' }] })).toBe(false)
  })

  test('the collapsed summary names settlement and fulfillment apart, including older records', () => {
    expect(jobSummary(base)).toBe('Local rehearsal · partial · Settled · fulfillment incomplete · 0x569d437983')
    expect(jobSummary({ ...base, state: 'complete' })).toContain('Settled · fulfilled')
    expect(jobSummary({ ...base, settlement: undefined })).toContain('Payment settled, no settlement record')
    expect(jobSummary({ ...base, state: 'awaiting_payment', settlement: null, payment: { settled: false, fulfillment: 'incomplete' } })).toContain('Not settled · not started')
  })
})
