import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { Token } from '../lib/tokens'
import { isCanonicalToken, tokenMonogram } from '../lib/tokens'
import { formatAmount, shortAddress } from '../lib/format'
import { hidePopover, showPopover } from '../lib/popover'
import { ChevronIcon, SearchIcon } from './Icons'
import { GhostButton } from './GhostButton'

interface TokenSelectProps {
  token: Token | undefined
  tokens: readonly Token[]
  balances: ReadonlyMap<string, bigint>
  onSelect: (token: Token) => void
  disabled?: boolean
  label?: string
  hotkey?: string
}

export function TokenSelect({ token, tokens, balances, onSelect, disabled = false, label = 'Select token', hotkey }: TokenSelectProps) {
  const rawId = useId()
  const popoverId = `token-${rawId.replace(/:/g, '')}`
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
      if (!openNow) triggerRef.current?.focus()
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
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(filtered.length - 1, index + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(0, index - 1))
    } else if (event.key === 'Enter' && filtered[activeIndex]) {
      event.preventDefault()
      onSelect(filtered[activeIndex])
      close()
    } else if (event.key === 'Escape') {
      event.preventDefault()
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
            <span className="token-mark" aria-hidden="true">{tokenMonogram(token)}</span>
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
            placeholder="Search symbol, name, or address"
          />
        </div>
        <div className="token-list" role="listbox" aria-label="Tokens">
          {filtered.map((item, index) => {
            const selected = item.address.toLowerCase() === token?.address.toLowerCase()
            return (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                key={item.address}
                className="token-row"
                data-active={index === activeIndex}
                data-selected={selected}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onSelect(item)
                  close()
                }}
              >
                <span className="token-mark" aria-hidden="true">{tokenMonogram(item)}</span>
                <span className="min-w-0 text-left">
                  <span className="block font-semibold">{item.symbol || shortAddress(item.address)}</span>
                  <span className="block truncate text-xs text-g500 group-data-[selected=true]:text-paper">
                    {item.isLaunch || !isCanonicalToken(item.address)
                      ? `${item.name || 'Token'} · ${shortAddress(item.address)}`
                      : item.name || shortAddress(item.address)}
                  </span>
                </span>
                <span className="ml-auto pl-4 text-right text-sm">{formatAmount(balances.get(item.address.toLowerCase()) ?? 0n, item.decimals)}</span>
              </button>
            )
          })}
          {filtered.length === 0 && <p className="px-4 py-8 text-center text-sm text-g500">No matching tokens.</p>}
        </div>
      </div>
    </>
  )
}
