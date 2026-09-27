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

/** One launchpad's launches as far as they have been read: newest first, and whether older ones are still unread. */
export interface LaunchPage<T> {
  rows: readonly T[]
  hasMore: boolean
}

/**
 * Several launchpads' newest launches as one list, newest first. Each launchpad is read newest first a page at a
 * time, so a row older than the oldest row read from a launchpad with more to read could have unread rows of that
 * launchpad ahead of it: such rows wait (`held`) until those pages are read, and the list never shows a launch out of
 * order. Ties in creation time keep the order the lists were given in.
 */
export function mergeNewestFirst<T extends { createdAt: bigint }>(pages: readonly LaunchPage<T>[]): { rows: T[]; held: number } {
  let cutoff: bigint | undefined
  for (const page of pages) {
    if (!page.hasMore || page.rows.length === 0) continue
    const oldest = page.rows.reduce((low, row) => (row.createdAt < low ? row.createdAt : low), page.rows[0].createdAt)
    if (cutoff === undefined || oldest > cutoff) cutoff = oldest
  }
  const all = pages.flatMap((page, list) => page.rows.map((row, index) => ({ row, list, index })))
  all.sort((a, b) => (a.row.createdAt === b.row.createdAt ? a.list - b.list || a.index - b.index : a.row.createdAt > b.row.createdAt ? -1 : 1))
  const rows = all.filter(({ row }) => cutoff === undefined || row.createdAt >= cutoff).map(({ row }) => row)
  return { rows, held: all.length - rows.length }
}
