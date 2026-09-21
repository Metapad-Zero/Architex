import { describe, expect, test } from 'bun:test'
import { launchWindows, parseLaunchAddress } from '../launchPages'

describe('launch list windows', () => {
  test('asks for nothing when there are no launches', () => {
    expect(launchWindows(0n, 1)).toEqual([])
  })

  test('reads every launch in one window while they fit', () => {
    expect(launchWindows(12n, 1)).toEqual([{ start: 0n, count: 12n }])
    expect(launchWindows(50n, 3)).toEqual([{ start: 0n, count: 50n }])
  })

  test('walks back from the newest launch one page at a time', () => {
    expect(launchWindows(123n, 1)).toEqual([{ start: 73n, count: 50n }])
    expect(launchWindows(123n, 2)).toEqual([
      { start: 73n, count: 50n },
      { start: 23n, count: 50n },
    ])
    expect(launchWindows(123n, 3)).toEqual([
      { start: 73n, count: 50n },
      { start: 23n, count: 50n },
      { start: 0n, count: 23n },
    ])
  })

  test('stops at the first launch however many pages are asked for', () => {
    const windows = launchWindows(123n, 10)
    expect(windows).toHaveLength(3)
    expect(windows.reduce((sum, window) => sum + window.count, 0n)).toBe(123n)
  })
})

describe('launch address lookup', () => {
  const address = '0x3600000000000000000000000000000000000000'

  test('accepts a pasted address and trims it', () => {
    expect(parseLaunchAddress(`  ${address}\n`)).toBe(address)
  })

  test('returns the checksummed form of a lowercase address', () => {
    expect(parseLaunchAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
  })

  test('rejects anything that is not an address', () => {
    expect(parseLaunchAddress('')).toBe(undefined)
    expect(parseLaunchAddress('DOGE')).toBe(undefined)
    expect(parseLaunchAddress('0x1234')).toBe(undefined)
    expect(parseLaunchAddress(`${address}00`)).toBe(undefined)
    expect(parseLaunchAddress('0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(undefined)
  })
})
