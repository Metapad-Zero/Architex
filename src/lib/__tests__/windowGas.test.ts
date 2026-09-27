import { describe, expect, test } from 'bun:test'
import { WINDOW_GAS_EXTRA, launchTradeGas, windowBuyGasLimit, type LaunchTradeGasArgs } from '../windowGas'

/** Chain reads that count how often they are asked, answering in turn from the lists given. */
function reads(snipes: bigint[], estimates: bigint[]) {
  const asked = { snipeBps: 0, estimate: 0 }
  return {
    asked,
    snipeBps: () => Promise.resolve(snipes[asked.snipeBps++] ?? 0n),
    estimate: () => {
      const estimate = estimates[asked.estimate++]
      return estimate === undefined ? Promise.reject(new Error('execution reverted: SlippageExceeded()')) : Promise.resolve(estimate)
    },
  }
}

const windowBuy: LaunchTradeGasArgs = { side: 'buy', v14: true, windowClosed: false }

describe('the gas a buy in a v1.4 snipe window is sent with', () => {
  test('a fresh estimate times 1.3, or plus 200,000, whichever is larger', () => {
    // Small estimates take the 200,000: where the extra bid costs most for its size.
    expect(windowBuyGasLimit(100_000n)).toBe(300_000n)
    expect(windowBuyGasLimit(266_000n)).toBe(466_000n)
    // The two meet at 666,666⅔; above it, ×1.3 (rounded up) is the larger.
    expect(windowBuyGasLimit(666_666n)).toBe(866_666n)
    expect(windowBuyGasLimit(666_667n)).toBe(866_668n)
    expect(windowBuyGasLimit(1_000_000n)).toBe(1_300_000n)
    expect(windowBuyGasLimit(1_000_001n)).toBe(1_300_002n)
    expect(WINDOW_GAS_EXTRA).toBe(200_000n)
    expect(() => windowBuyGasLimit(0n)).toThrow('No gas estimate')
  })

  test('covers what integration review #9b measured an estimate taken a moment earlier to fall short by', () => {
    // [estimate, gas the buy then needed] from EstimateDrift.t.sol: another buy landing first (+16% to +18%), and one
    // that also opens a new tick-bitmap word (+23% to +25%), in both USDC orders.
    const drifts: Array<[bigint, bigint]> = [
      [266_000n, 313_300n],
      [266_800n, 310_700n],
      [266_000n, 331_600n],
      [266_800n, 329_000n],
    ]
    for (const [estimate, needed] of drifts) expect(windowBuyGasLimit(estimate) >= needed).toBe(true)
  })

  test('a v1.4 buy whose window is open on chain gets its own limit, from an estimate made for that send', async () => {
    const chain = reads([4_500n], [266_000n])
    expect(await launchTradeGas(windowBuy, chain)).toBe(466_000n)
    expect(chain.asked).toEqual({ snipeBps: 1, estimate: 1 })
  })

  test('every send asks again: a limit is never carried over from an earlier estimate or receipt', async () => {
    const chain = reads([4_500n, 450n], [266_000n, 700_000n])
    expect(await launchTradeGas(windowBuy, chain)).toBe(466_000n)
    expect(await launchTradeGas(windowBuy, chain)).toBe(910_000n)
    expect(chain.asked).toEqual({ snipeBps: 2, estimate: 2 })
  })

  test('once the window has closed on chain the wallet estimates as usual, without an estimate from the site', async () => {
    const chain = reads([0n], [266_000n])
    expect(await launchTradeGas(windowBuy, chain)).toBe(undefined)
    expect(chain.asked).toEqual({ snipeBps: 1, estimate: 0 })
  })

  test('sells, v1.3 trades and windows a seen block has passed never ask the chain', async () => {
    const cases: LaunchTradeGasArgs[] = [
      { side: 'sell', v14: true, windowClosed: false },
      { side: 'buy', v14: false, windowClosed: false },
      { side: 'buy', v14: true, windowClosed: true },
    ]
    for (const trade of cases) {
      const chain = reads([4_500n], [266_000n])
      expect(await launchTradeGas(trade, chain)).toBe(undefined)
      expect(chain.asked).toEqual({ snipeBps: 0, estimate: 0 })
    }
  })

  test('an estimate that reverts stops the send with the chain’s reason', async () => {
    await expect(launchTradeGas(windowBuy, reads([4_500n], []))).rejects.toThrow('SlippageExceeded')
  })
})
