import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hidePopover, showPopover } from '../lib/popover'
import { onSplashFinished } from '../lib/splash'
import {
  hashRequestsUpdates,
  isUnread,
  markSeen,
  UPDATES_OPEN_EVENT,
  visibleUpdates,
  type ProductUpdate,
  type UpdateFigure,
} from '../lib/updates'
import { navigate, type AppRoute } from '../hooks/useHashRoute'
import { GhostButton } from './GhostButton'
import { PrimaryButton } from './PrimaryButton'

const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

/**
 * The unread-product bulletin. Same scrim-and-outline grammar as the confirm sheet: it
 * interrupts landing the way a signature interrupts a send, then gets out of the way.
 */
export function UpdatesSheet() {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const items = useMemo(() => visibleUpdates(), [])
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)

  const close = useCallback(() => {
    markSeen(items)
    setOpen(false)
    setIndex(0)
    if (window.location.hash === '#updates') navigate({ view: 'swap' })
  }, [items])

  const openSheet = useCallback(() => {
    if (items.length === 0) return
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setIndex(0)
    setOpen(true)
  }, [items.length])

  useEffect(() => {
    return onSplashFinished(() => {
      if (hashRequestsUpdates() || isUnread(items)) openSheet()
    })
  }, [items, openSheet])

  useEffect(() => {
    const onHash = () => {
      if (hashRequestsUpdates()) openSheet()
    }
    const onRequest = () => openSheet()
    window.addEventListener('hashchange', onHash)
    window.addEventListener(UPDATES_OPEN_EVENT, onRequest)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener(UPDATES_OPEN_EVENT, onRequest)
    }
  }, [openSheet])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (open) {
      showPopover(panel)
      const next = panel.querySelector<HTMLElement>('button.primary-button')
      ;(next ?? panel).focus({ preventScroll: true })
      return
    }
    hidePopover(panel)
    restoreFocus.current?.focus()
    restoreFocus.current = null
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setIndex((current) => Math.min(items.length - 1, current + 1))
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setIndex((current) => Math.max(0, current - 1))
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close, items.length, open])

  const item = items[index]
  const last = index >= items.length - 1

  const goNext = () => {
    if (last) close()
    else setIndex((current) => current + 1)
  }

  const follow = (update: ProductUpdate) => {
    const route: AppRoute = { view: update.action.view }
    markSeen(items)
    setOpen(false)
    setIndex(0)
    navigate(route)
  }

  return (
    <div
      ref={panelRef}
      id="updates-sheet"
      {...({ popover: 'manual' } as { popover: 'manual' })}
      className="updates-sheet"
      hidden={!open && !('popover' in HTMLElement.prototype)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="updates-sheet-title"
      aria-describedby="updates-sheet-body"
      tabIndex={-1}
    >
      {open && item && (
        <div className="updates-panel">
          <div className="updates-main">
            <div className="updates-figure" aria-hidden="true">
              <div className="updates-specimen">
                <UpdateFigure figure={item.figure} />
              </div>
              <p className="mt-3 text-2xs text-g500">Example</p>
            </div>
            <div className="updates-copy">
              <h2 id="updates-sheet-title" className="text-lg font-semibold leading-tight tracking-[-0.01em]">
                {item.title}
              </h2>
              <p id="updates-sheet-body" className="mt-3 text-base leading-6">
                {item.body}
              </p>
              <GhostButton className="mt-4 w-auto self-start" onClick={() => follow(item)}>
                {item.action.label}
              </GhostButton>
            </div>
          </div>
          <div className="updates-actions">
            <div className="flex min-h-11 items-center justify-between gap-4 sm:justify-start">
              <p className="text-sm text-g500" aria-live="polite">
                Architex updated
                {items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}
              </p>
              <button type="button" className="updates-later" onClick={close}>
                Later
              </button>
            </div>
            <PrimaryButton className="w-full sm:w-auto sm:min-w-56" onClick={goNext}>
              {last ? 'Done' : 'Next'}
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  )
}

function UpdateFigure({ figure }: { figure: UpdateFigure }) {
  if (figure === 'launch') {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-sm font-semibold">Token</span>
          <span className="text-sm text-g500">62% sold</span>
        </div>
        <div className="launch-meter mt-3 w-full">
          <span style={{ width: '62%' }} />
        </div>
      </div>
    )
  }
  if (figure === 'bridge') {
    return (
      <dl className="receipt-lines border-t-0">
        <div>
          <dt>From</dt>
          <dd>Ethereum · Solana</dd>
        </div>
        <div>
          <dt>To</dt>
          <dd>Arc</dd>
        </div>
        <div>
          <dt>Asset</dt>
          <dd>USDC</dd>
        </div>
      </dl>
    )
  }
  return (
    <ul className="m-0 list-none p-0">
      {['How the curve works', 'Graduation', 'Risks'].map((row) => (
        <li key={row} className="flex min-h-10 items-center border-b border-g300 text-sm font-semibold">
          {row}
        </li>
      ))}
    </ul>
  )
}
