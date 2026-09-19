import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Hex } from 'viem'
import { usePairs } from '../hooks/usePairs'
import { useTokens } from '../hooks/useTokens'
import { isPasskeyKind, UnlockCancelledError } from '../lib/keystore'
import { shortAddress } from '../lib/format'
import { unlockLocalWallet, useLocalWallet } from '../lib/localWallet'
import { hidePopover, showPopover } from '../lib/popover'
import { describeRequest } from '../lib/signingIntent'
import { setUnlockHandler, type SigningRequest } from '../lib/unlock'
import { GhostButton } from './GhostButton'
import { PasswordField, WalletUsernameHint } from './PasswordField'
import { PrimaryButton } from './PrimaryButton'

interface PendingUnlock {
  id: number
  request: SigningRequest
  resolve: (key: Hex) => void
  reject: (error: Error) => void
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([hidden]), a[href], [tabindex]:not([tabindex="-1"])'

/**
 * The confirm sheet for the browser wallet. Every signature lands here first: the exact request in
 * receipt lines, then the passkey or password that decrypts the key for that one use. Cancel (or
 * Escape) rejects the request the way an extension wallet would.
 */
export function UnlockSheet() {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState<PendingUnlock | null>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let next = 0
    setUnlockHandler(
      (request) =>
        new Promise<Hex>((resolve, reject) => {
          next += 1
          setPending({ id: next, request, resolve, reject })
        }),
    )
    return () => setUnlockHandler(undefined)
  }, [])

  const finish = useCallback(() => setPending(null), [])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (pending) {
      restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      showPopover(panel)
      const first = panel.querySelector<HTMLElement>('input:not([hidden]), button.primary-button')
      ;(first ?? panel).focus()
      return
    }
    hidePopover(panel)
    restoreFocus.current?.focus()
    restoreFocus.current = null
  }, [pending])

  return (
    <div
      ref={panelRef}
      id="unlock-sheet"
      {...({ popover: 'manual' } as { popover: 'manual' })}
      className="unlock-sheet"
      hidden={!pending && !('popover' in HTMLElement.prototype)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="unlock-sheet-title"
      aria-label="Confirm with your browser wallet"
      tabIndex={-1}
    >
      {pending && <UnlockBody key={pending.id} pending={pending} onDone={finish} panelRef={panelRef} />}
    </div>
  )
}

interface UnlockBodyProps {
  pending: PendingUnlock
  onDone: () => void
  panelRef: React.RefObject<HTMLDivElement>
}

function UnlockBody({ pending, onDone, panelRef }: UnlockBodyProps) {
  const { pairs } = usePairs()
  const { tokens } = useTokens(pairs)
  const local = useLocalWallet()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const intent = describeRequest(pending.request, tokens)
  const usesPasskey = isPasskeyKind(local.protection)

  const cancel = useCallback(() => {
    pending.reject(new UnlockCancelledError())
    onDone()
  }, [onDone, pending])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
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
  }, [cancel, panelRef])

  const confirm = async (event?: FormEvent) => {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const key = await unlockLocalWallet(usesPasskey ? undefined : password)
      setPassword('')
      pending.resolve(key)
      onDone()
    } catch (failure) {
      if (failure instanceof UnlockCancelledError) {
        setError('Passkey request cancelled. Try again or cancel below.')
      } else {
        setError(failure instanceof Error ? failure.message : 'Could not unlock the wallet.')
      }
      setBusy(false)
    }
  }

  return (
    <form className="p-4" onSubmit={(event) => void confirm(event)}>
      <h2 id="unlock-sheet-title" className="text-lg font-semibold leading-tight tracking-[-0.01em]">{intent.title}</h2>
      {intent.lines.length > 0 && (
        <dl className="receipt-lines mt-3">
          {intent.lines.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd title={line.value}>{line.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {intent.note && <p className="mt-3 text-sm leading-6 text-g700">{intent.note}</p>}
      {usesPasskey ? (
        <p className="mt-4 text-sm leading-6 text-g700">Your passkey approves this one signature; the key is not kept afterwards.</p>
      ) : (
        <>
          <WalletUsernameHint />
          <PasswordField
            className="mt-4"
            id="current-password"
            name="password"
            label="Wallet password"
            autoComplete="current-password"
            required
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
          />
        </>
      )}
      {error && (
        <p className="mt-2 text-sm text-loss" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 grid gap-2">
        <PrimaryButton type="submit" loading={busy} disabled={busy || (!usesPasskey && password.length === 0)}>
          {busy ? 'Unlocking…' : usesPasskey ? 'Confirm with passkey' : 'Confirm'}
        </PrimaryButton>
        <GhostButton onClick={cancel}>Cancel</GhostButton>
      </div>
      {local.address && (
        <p className="mt-3 text-sm text-g500">
          Signing as {shortAddress(local.address)} · browser wallet
        </p>
      )}
    </form>
  )
}
