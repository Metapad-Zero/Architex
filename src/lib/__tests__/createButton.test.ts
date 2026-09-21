import { describe, expect, test } from 'bun:test'
import { allowanceLagging, createButtonState, type CreateButtonInput } from '../createButton'

const FEE = 1_000_000n

const base: CreateButtonInput = {
  connected: true,
  onActiveChain: true,
  phase: 'idle',
  valid: true,
  feeKnown: true,
  spendable: 100_000_000n,
  totalUsdc: FEE,
  allowance: 0n,
  approvedAmount: undefined,
}

describe('create button', () => {
  test('an unknown launch fee is not ready, even with no allowance to check against', () => {
    expect(createButtonState({ ...base, feeKnown: false, totalUsdc: 0n })).toBe('loadingFee')
    expect(createButtonState({ ...base, feeKnown: false, totalUsdc: 25_000_000n, allowance: 25_000_000n })).toBe('loadingFee')
  })

  test('an invalid form still reports invalid while the fee loads', () => {
    expect(createButtonState({ ...base, valid: false, feeKnown: false })).toBe('invalid')
  })

  test('once the fee is known, approval and balance are checked against the full total', () => {
    expect(createButtonState(base)).toBe('needsApproval')
    expect(createButtonState({ ...base, allowance: FEE })).toBe('ready')
    expect(createButtonState({ ...base, spendable: FEE - 1n })).toBe('insufficientBalance')
  })

  test('stays approving until the allowance read shows the confirmed approval', () => {
    const confirmed = { ...base, totalUsdc: 26_000_000n, approvedAmount: 26_000_000n }
    expect(createButtonState(confirmed)).toBe('approving')
    expect(createButtonState({ ...confirmed, allowance: 26_000_000n })).toBe('ready')
  })

  test('a larger total after the approval asks for a new approval once the read catches up', () => {
    expect(createButtonState({ ...base, totalUsdc: 30_000_000n, approvedAmount: 26_000_000n, allowance: 26_000_000n })).toBe('needsApproval')
  })

  test('the allowance lags only while it is below a confirmed approval', () => {
    expect(allowanceLagging(0n, undefined)).toBe(false)
    expect(allowanceLagging(0n, FEE)).toBe(true)
    expect(allowanceLagging(FEE, FEE)).toBe(false)
  })
})
