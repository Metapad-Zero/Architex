import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { Token } from '../lib/tokens'
import { isCanonicalToken } from '../lib/tokens'
import { TokenMark } from './TokenMark'
import { formatAmount, shortAddress } from '../lib/format'
import { hidePopover, showPopover } from '../lib/popover'
import { ChevronIcon, SearchIcon } from './Icons'
import { GhostButton } from './GhostButton'

/**
 * Rows a page adds under the picker's tokens; rendered (and so mounted) only while the picker is open. They are
 * links to other pages, so they need no way to close the picker: leaving the page takes it away.
 */
export type PickerExtra = (props: { query: string }) => ReactNode

interface TokenSelectProps {
  token: Token | undefined
  tokens: readonly Token[]
  balances: ReadonlyMap<string, bigint>
  onSelect: (token: Token) => void
  disabled?: boolean
  label?: string
  hotkey?: string
  extra?: PickerExtra
}

export function TokenSelect({ token, tokens, balances, onSelect, disabled = false, label = 'Select token', hotkey, extra }: TokenSelectProps) {
  const rawId = useId()
  const popoverId = `token-${rawId.replace(/:/g, '')}`
  const listId = `${popoverId}-list`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [style, setStyle] = useState<CSSProperties>()

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return tokens
    return tokens.filter((item) =>
      `${item.symbol} ${item.name} ${item.address}`.toLowerCase().includes(normalized),
    )
  }, [query, tokens])
  const activeOption = Math.min(activeIndex, filtered.length - 1)

  useEffect(() => {
    if (!isOpen || activeOption < 0) return
    const row = document.getElementById(`${listId}-${activeOption}`)
    const list = row?.closest('.token-list')
    if (!row || !list) return
    const rowRect = row.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    if (rowRect.top < listRect.top) list.scrollTop += rowRect.top - listRect.top
    else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom
  }, [activeOption, isOpen, listId, query])

  const close = (restoreFocus = true) => {
    hidePopover(panelRef.current)
    setIsOpen(false)
    setQuery('')
    if (restoreFocus) triggerRef.current?.focus()
  }

  const open = () => {
    const panel = panelRef.current
    const trigger = triggerRef.current
    if (!panel || !trigger) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.max(320, rect.width)
    setStyle({ top: rect.bottom + 8, left: Math.min(rect.left, window.innerWidth - width - 16), width })
    setIsOpen(true)
    setActiveIndex(Math.max(0, tokens.findIndex((item) => item.address === token?.address)))
    showPopover(panel)
    requestAnimationFrame(() => searchRef.current?.focus())
  }

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onToggle = (event: Event) => {
      const toggle = event as ToggleEvent
      const openNow = toggle.newState === 'open'
      setIsOpen(openNow)
      if (!openNow) {
        setQuery('')
        triggerRef.current?.focus()
      }
    }
    panel.addEventListener('toggle', onToggle)
    return () => panel.removeEventListener('toggle', onToggle)
  }, [])

  useEffect(() => {
    if (!isOpen || 'popover' in HTMLElement.prototype) return
    const onPointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [isOpen])

  const handleKeys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.target !== searchRef.current) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(Math.max(0, Math.min(filtered.length - 1, activeOption + 1)))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(Math.max(0, activeOption - 1))
    } else if (event.key === 'Enter' && filtered[activeOption]) {
      event.preventDefault()
      onSelect(filtered[activeOption])
      close()
    }
  }

  return (
    <>
      <GhostButton
        ref={triggerRef}
        aria-controls={popoverId}
        aria-expanded={isOpen}
        aria-label={token ? `${label}: ${token.symbol}` : label}
        disabled={disabled}
        onClick={() => (isOpen ? close() : open())}
        className="token-trigger"
        data-hotkey={hotkey}
      >
        {token ? (
          <>
            <TokenMark token={token} />
            <span>{token.symbol}</span>
          </>
        ) : (
          <span>Select</span>
        )}
        <ChevronIcon className="h-4 w-4" />
      </GhostButton>
      <div
        ref={panelRef}
        id={popoverId}
        {...({ popover: 'auto' } as { popover: 'auto' })}
        style={style}
        className="token-popover"
        hidden={!isOpen && !('popover' in HTMLElement.prototype)}
        onKeyDown={handleKeys}
      >
        <div className="token-search">
          <SearchIcon className="h-4 w-4 shrink-0" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            aria-label="Search tokens"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={isOpen}
            aria-controls={listId}
            aria-activedescendant={isOpen && activeOption >= 0 ? `${listId}-${activeOption}` : undefined}
            placeholder="Search symbol, name, or address"
          />
        </div>
        <div className="token-list">
          <div id={listId} role="listbox" aria-label="Tokens">
          {filtered.map((item, index) => {
            const selected = item.address.toLowerCase() === token?.address.toLowerCase()
            return (
              <button
                type="button"
                role="option"
                id={`${listId}-${index}`}
                tabIndex={-1}
                aria-selected={selected}
                key={item.address}
                className="token-row"
                data-active={index === activeOption}
                data-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onSelect(item)
                  close()
                }}
              >
                <TokenMark token={item} />
                <span className="min-w-0 text-left">
                  <span className="block font-semibold">{item.symbol || shortAddress(item.address)}</span>
                  <span className="block truncate text-xs text-g500 group-data-[selected=true]:text-paper">
                    {item.isLaunch || !isCanonicalToken(item.address)
                      ? `${item.name || 'Token'} · ${shortAddress(item.address)}`
                      : item.name || shortAddress(item.address)}
                  </span>
                </span>
                {balances.has(item.address.toLowerCase()) && (
                  <span className="ml-auto pl-4 text-right text-sm">{formatAmount(balances.get(item.address.toLowerCase())!, item.decimals)}</span>
                )}
              </button>
            )
          })}
          </div>
          {filtered.length === 0 && <p role="status" className="px-4 py-8 text-center text-sm text-g500">{extra ? 'No pool tokens match.' : 'No matching tokens.'}</p>}
          {isOpen && extra?.({ query })}
        </div>
      </div>
    </>
  )
}
