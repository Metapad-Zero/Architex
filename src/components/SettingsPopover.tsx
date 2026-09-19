import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { hidePopover, showPopover } from '../lib/popover'
import { GhostButton } from './GhostButton'
import { SettingsIcon, XIcon } from './Icons'

interface SettingsPopoverProps {
  slippageBps: number
  deadlineMinutes: number
  onSlippage: (value: number) => void
  onDeadline: (value: number) => void
}

export function SettingsPopover({ slippageBps, deadlineMinutes, onSlippage, onDeadline }: SettingsPopoverProps) {
  const id = `settings-${useId().replace(/:/g, '')}`
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<CSSProperties>()

  const close = () => {
    hidePopover(panelRef.current)
    setOpen(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onToggle = (event: Event) => {
      const toggle = event as ToggleEvent
      setOpen(toggle.newState === 'open')
      if (toggle.newState === 'closed') triggerRef.current?.focus()
    }
    panel.addEventListener('toggle', onToggle)
    return () => panel.removeEventListener('toggle', onToggle)
  }, [])

  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect || !panelRef.current) return
    setStyle({ top: rect.bottom + 8, left: Math.max(16, rect.right - 320), width: 320 })
    setOpen(true)
    showPopover(panelRef.current)
  }

  return (
    <>
      <GhostButton ref={triggerRef} className="h-11 w-11 justify-center px-0" aria-label="Swap settings" aria-controls={id} aria-expanded={open} onClick={() => (open ? close() : show())}>
        <SettingsIcon />
      </GhostButton>
      <div ref={panelRef} id={id} {...({ popover: 'auto' } as { popover: 'auto' })} style={style} className="settings-popover" hidden={!open && !('popover' in HTMLElement.prototype)}>
        <div className="flex items-center justify-between border-b border-ink px-4 py-3">
          <h2 className="text-base font-semibold">Swap settings</h2>
          <button type="button" className="icon-button" onClick={close} aria-label="Close settings"><XIcon /></button>
        </div>
        <div className="space-y-6 p-4">
          <fieldset>
            <legend className="mb-2 text-sm text-g500">Slippage</legend>
            <div className="grid grid-cols-3 gap-2">
              {[10, 50, 100].map((value) => (
                <button type="button" key={value} className="choice-button" data-active={slippageBps === value} onClick={() => onSlippage(value)}>
                  {(value / 100).toFixed(value % 100 === 0 ? 0 : 1)}%
                </button>
              ))}
            </div>
            <label className="mt-3 block text-sm">
              <span className="sr-only">Custom slippage percentage</span>
              <span className="field-with-suffix"><input type="number" min="0.01" max="50" step="0.01" value={slippageBps / 100} onChange={(event) => onSlippage(Number(event.target.value) * 100)} /><span>%</span></span>
            </label>
            <p className="mt-2 text-xs leading-5 text-g500">Your swap fails if the price moves more than this while it confirms.</p>
          </fieldset>
          <label className="block text-sm text-g500">
            Deadline
            <span className="field-with-suffix mt-2"><input type="number" min="1" max="180" value={deadlineMinutes} onChange={(event) => onDeadline(Number(event.target.value))} /><span>minutes</span></span>
          </label>
        </div>
      </div>
    </>
  )
}
