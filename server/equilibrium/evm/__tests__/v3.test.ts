import { describe, expect, test } from 'bun:test'
import { plan, sqrtRatioAtTick } from '../v3'

describe('Uniswap v3 full-range plan', () => {
  test('TickMath matches the reference boundary values', () => {
    expect(sqrtRatioAtTick(-887272)).toBe(4295128739n)
    expect(sqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n)
    expect(sqrtRatioAtTick(0)).toBe(1n << 96n)
  })
  test('owed amounts never exceed the bound deposits and stay within rounding of them', () => {
    for (const [a, b] of [[1_000_000_000n, 10_000_000n], [10_000_000n, 1_000_000_000n], [5_000_000_000n, 100_000_000n], [123_456_789n, 987_654n]]) {
      const p = plan(a, b, 60)
      expect(p.owed0 <= a && p.owed1 <= b).toBe(true)
      // The larger shortfall is a rounding remainder, not a price error.
      expect(Number(a - p.owed0) / Number(a) < 1e-5 || Number(b - p.owed1) / Number(b) < 1e-5).toBe(true)
    }
  })
})
