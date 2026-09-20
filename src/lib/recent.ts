import { useEffect, useState } from 'react'
/**
 * The "Recent" ledger: transactions confirmed from this browser, kept per chain in localStorage.
 * It is a printed record of what this user did here, never a substitute for chain data.
 */
export interface RecentEntry {
  hash: string
  kind: 'swap' | 'add' | 'remove' | 'faucet' | 'launch' | 'bridge'
  summary: string
  time: number
}

const MAX_ENTRIES = 8
const EVENT = 'architex:recent'

function storageKey(chainId: number): string {
  return `architex.recent.${chainId}`
}

export function readRecent(chainId: number): RecentEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(chainId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is RecentEntry =>
        typeof entry === 'object' && entry !== null && typeof (entry as RecentEntry).hash === 'string' && typeof (entry as RecentEntry).summary === 'string',
    )
  } catch {
    return []
  }
}

export function pushRecent(chainId: number, input: Omit<RecentEntry, 'time'> & { time?: number }): void {
  try {
    const entry: RecentEntry = { ...input, time: input.time ?? Date.now() }
    const next = [entry, ...readRecent(chainId).filter((item) => item.hash !== entry.hash)].slice(0, MAX_ENTRIES)
    localStorage.setItem(storageKey(chainId), JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(EVENT))
  } catch {
    // Storage unavailable (private mode, quota): the ledger is a convenience, never required.
  }
}

export function useRecent(chainId: number): RecentEntry[] {
  const [entries, setEntries] = useState<RecentEntry[]>(() => readRecent(chainId))
  useEffect(() => {
    const refresh = () => setEntries(readRecent(chainId))
    refresh()
    window.addEventListener(EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [chainId])
  return entries
}

export function relativeTime(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}
