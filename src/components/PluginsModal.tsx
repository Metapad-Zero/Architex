import { useCallback, useEffect, useRef, useState } from 'react'
import { hidePopover, showPopover } from '../lib/popover'
import { PLUGIN_REGISTRY, findPlugin, type Plugin } from '../content/plugins/registry'
import { GhostButton } from './GhostButton'

const REPO_BLOB_BASE = 'https://github.com/Metapad-Zero/Architex/blob/main/'

interface PluginsModalProps {
  open: boolean
  onClose: () => void
}

/** Fee-distribution plugin catalog, opened from the Launch page. See `docs/plugins/CONTRIBUTING.md`. */
export function PluginsModal({ open, onClose }: PluginsModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [slug, setSlug] = useState<string | undefined>(undefined)

  const close = useCallback(() => {
    onClose()
    setSlug(undefined)
  }, [onClose])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (open) {
      showPopover(panel)
      return
    }
    hidePopover(panel)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  return (
    <div
      ref={panelRef}
      id="plugins-modal"
      {...({ popover: 'manual' } as { popover: 'manual' })}
      className="unlock-sheet"
      hidden={!open && !('popover' in HTMLElement.prototype)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="plugins-modal-title"
      tabIndex={-1}
    >
      {open && <PluginsModalBody slug={slug} onSlug={setSlug} onClose={close} />}
    </div>
  )
}

interface PluginsModalBodyProps {
  slug?: string
  onSlug: (slug?: string) => void
  onClose: () => void
}

function PluginsModalBody({ slug, onSlug, onClose }: PluginsModalBodyProps) {
  const active = slug ? findPlugin(slug) : undefined

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="plugins-modal-title" className="text-lg font-semibold leading-tight tracking-[-0.01em]">
            Fee-distribution plugins
          </h2>
          <p className="mt-1 text-sm text-g700">
            Contracts anyone can deploy and point <code>feeTo</code> at, to split protocol or launch fees among more than one wallet.
          </p>
        </div>
        <GhostButton onClick={onClose}>Close</GhostButton>
      </div>

      <div className="mt-4 h-px bg-ink" />

      {active ? <PluginDetail plugin={active} onBack={() => onSlug(undefined)} /> : <PluginList onOpen={onSlug} />}

      <p className="mt-6 border-t border-g300 pt-4 text-sm text-g500">
        This catalog is edited by pull request, not from this dialog — see{' '}
        <a
          className="font-semibold text-ink underline decoration-1 underline-offset-[3px] hover:text-g700"
          href={`${REPO_BLOB_BASE}docs/plugins/CONTRIBUTING.md`}
          target="_blank"
          rel="noreferrer"
        >
          docs/plugins/CONTRIBUTING.md
        </a>{' '}
        to submit one.
      </p>
    </div>
  )
}

function PluginList({ onOpen }: { onOpen: (slug: string) => void }) {
  return (
    <div className="mt-4 space-y-3">
      {PLUGIN_REGISTRY.map((plugin) => (
        <button
          key={plugin.slug}
          type="button"
          onClick={() => onOpen(plugin.slug)}
          className="block w-full rounded-lg border border-g300 p-4 text-left transition hover:border-ink"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{plugin.name}</h3>
            <StatusChip status={plugin.status} />
          </div>
          <p className="mt-1 text-sm text-g700">{plugin.tagline}</p>
        </button>
      ))}
    </div>
  )
}

function PluginDetail({ plugin, onBack }: { plugin: Plugin; onBack: () => void }) {
  return (
    <div className="mt-4">
      <button type="button" onClick={onBack} className="text-sm font-semibold text-ink underline decoration-1 underline-offset-[3px] hover:text-g700">
        ← All plugins
      </button>

      <div className="mt-3 flex items-center gap-2">
        <h3 className="text-base font-semibold">{plugin.name}</h3>
        <StatusChip status={plugin.status} />
      </div>

      <p className="mt-3 text-sm leading-6">{plugin.description}</p>

      <h4 className="mt-5 text-xs font-semibold uppercase tracking-wide text-g500">Constructor</h4>
      <dl className="mt-2 space-y-2">
        {plugin.constructorArgs.map((arg) => (
          <div key={arg.name}>
            <dt className="font-mono text-sm">
              {arg.name}: <span className="text-g500">{arg.type}</span>
            </dt>
            <dd className="mt-0.5 text-sm text-g700">{arg.description}</dd>
          </div>
        ))}
      </dl>

      {plugin.notes && plugin.notes.length > 0 && (
        <>
          <h4 className="mt-5 text-xs font-semibold uppercase tracking-wide text-g500">Before you deploy</h4>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-g700">
            {plugin.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      )}

      {plugin.submittedBy && <p className="mt-4 text-sm text-g500">Submitted by {plugin.submittedBy}.</p>}

      <a
        className="mt-4 inline-block text-sm font-semibold text-ink underline decoration-1 underline-offset-[3px] hover:text-g700"
        href={`${REPO_BLOB_BASE}${plugin.contractPath}`}
        target="_blank"
        rel="noreferrer"
      >
        View source →
      </a>
    </div>
  )
}

function StatusChip({ status }: { status: Plugin['status'] }) {
  return (
    <span className="rounded-full border border-g300 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-g500">
      {status === 'reference' ? 'Reference' : 'Community'}
    </span>
  )
}
