import { isLaunchViewAvailable } from './deployment'

export type UpdateView = 'launch' | 'bridge' | 'docs'

export type UpdateFigure = 'launch' | 'bridge' | 'docs'

export interface ProductUpdate {
  id: string
  title: string
  body: string
  action: { label: string; view: UpdateView }
  figure: UpdateFigure
  /** When true, the item is omitted unless the Launch view is on this network. */
  requiresLaunch?: boolean
}

const STORAGE_KEY = 'architex-updates'

/**
 * Newest first. Adding an item with a new `id` at the top is what makes the bulletin
 * appear again for browsers that already dismissed an older stack.
 */
export const PRODUCT_UPDATES: readonly ProductUpdate[] = [
  {
    id: 'docs',
    title: 'How the curve works',
    body: 'The docs cover the curve, launching, graduation, and the risks — including that the contracts have not been audited by a third party, and that nobody reviews a launch before it goes live.',
    action: { label: 'Open Docs', view: 'docs' },
    figure: 'docs',
  },
  {
    id: 'bridge',
    title: 'Bridge native USDC',
    body: 'Bring USDC onto Arc from Ethereum or Solana, or take it back, over Circle CCTP. The coins are burned on one chain and minted on the other. Nothing is wrapped.',
    action: { label: 'Open Bridge', view: 'bridge' },
    figure: 'bridge',
  },
  {
    id: 'launch',
    title: 'Launch on a bonding curve',
    body: 'Anyone can list a token. It trades from the first buy, at a price the curve sets. When the curve sells out, two hundred million tokens and the USDC raised seed a live pool, and the LP tokens are burned.',
    action: { label: 'Open Launch', view: 'launch' },
    figure: 'launch',
    requiresLaunch: true,
  },
]

export function visibleUpdates(launchAvailable = isLaunchViewAvailable): ProductUpdate[] {
  return PRODUCT_UPDATES.filter((item) => !item.requiresLaunch || launchAvailable)
}

export function latestId(items: readonly ProductUpdate[]): string | undefined {
  return items[0]?.id
}

export function loadSeenId(): string | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

export function storeSeenId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // Private browsing can refuse storage; the bulletin still dismisses for this visit.
  }
}

export function isUnread(items: readonly ProductUpdate[], seenId = loadSeenId()): boolean {
  const latest = latestId(items)
  return Boolean(latest) && seenId !== latest
}

export function markSeen(items: readonly ProductUpdate[]): void {
  const latest = latestId(items)
  if (latest) storeSeenId(latest)
}

export const UPDATES_OPEN_EVENT = 'architex:open-updates'

export function hashRequestsUpdates(): boolean {
  return window.location.hash === '#updates'
}

/** Reopen the bulletin without changing the task under it. */
export function requestUpdates(): void {
  window.dispatchEvent(new Event(UPDATES_OPEN_EVENT))
}
