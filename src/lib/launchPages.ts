import { getAddress, isAddress, type Address } from 'viem'
import { PAGE_SIZE } from './launch'

export interface LaunchWindow {
  start: bigint
  count: bigint
}

export function launchWindows(length: bigint, pages: number, size: bigint = PAGE_SIZE): LaunchWindow[] {
  const windows: LaunchWindow[] = []
  let end = length
  for (let page = 0; page < pages && end > 0n; page++) {
    const start = end > size ? end - size : 0n
    windows.push({ start, count: end - start })
    end = start
  }
  return windows
}

export function parseLaunchAddress(input: string): Address | undefined {
  const value = input.trim()
  return isAddress(value) ? getAddress(value) : undefined
}
