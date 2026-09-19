import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { CSSProperties } from 'react'
import { useAccount, useBalance, useConfig, useConnect, useConnectors, useDisconnect, type Connector } from 'wagmi'
import { connect as connectWith } from 'wagmi/actions'
import { activeChain, addressExplorerUrl } from '../chain'
import { isUserRejection } from '../lib/errors'
import { formatAmount, shortAddress } from '../lib/format'
import { isPasskeyKind, passkeysAvailable, UnlockCancelledError, type KeystoreKind } from '../lib/keystore'
import {
  createLocalWallet,
  forgetLocalWallet,
  importLocalWallet,
  MIN_PASSWORD_LENGTH,
  signInWithPasskey,
  unlockLocalWallet,
  useLocalWallet,
  type Protection,
} from '../lib/localWallet'
import { LOCAL_WALLET_CONNECTOR_ID } from '../lib/localWalletConnector'
import { hidePopover, showPopover } from '../lib/popover'
import { ensureWalletConnectConnector, WALLETCONNECT_CONNECTOR_ID } from '../lib/walletConnect'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { ExternalLinkIcon } from './Icons'
import { GhostButton } from './GhostButton'
import { PasswordField, WalletUsernameHint } from './PasswordField'

/** The custody terms, stated on the connected face before the wallet is funded. */
function custodySentence(kind: KeystoreKind | undefined): string {
  if (kind === 'passkey-derived') {
    return 'This wallet is your passkey: the key is derived from it for each signature and never stored. Lose the passkey and the wallet goes with it, so back up the key before you fund it.'
  }
  const secret = kind === 'passkey' ? 'passkey' : 'password'
  return `The key is stored encrypted on this device and your ${secret} unlocks it for each signature; nothing spends without that. Clearing site data deletes the wallet, so back up the key before you fund it.`
}

function forgetSentence(kind: KeystoreKind | undefined): string {
  if (kind === 'passkey-derived') return 'This removes the wallet from this browser. Your passkey can sign in again; without the passkey or a backup the wallet is gone for good.'
  return 'This deletes the encrypted key from this browser. Without a backup the wallet is gone for good.'
}

function walletMonogram(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'W'
}

function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && Boolean((window as Window & { ethereum?: unknown }).ethereum)
}

function visibleConnectors(connectors: readonly Connector[]): Connector[] {
  const announced = connectors.some((connector) => connector.type === 'injected' && connector.id !== 'injected')
  return connectors.filter((connector) => {
    if (connector.type !== 'injected' || connector.id !== 'injected') return true
    return !announced && hasInjectedProvider()
  })
}

function connectErrorMessage(error: unknown): string {
  if (isUserRejection(error)) return 'Request rejected in your wallet.'
  if (error && typeof error === 'object' && 'shortMessage' in error && typeof (error).shortMessage === 'string') {
    return (error as { shortMessage: string }).shortMessage
  }
  if (error instanceof Error) return error.message
  return 'Could not connect.'
}

function failureMessage(error: unknown, fallback: string): string {
  if (error instanceof UnlockCancelledError) return 'Passkey request cancelled.'
  return error instanceof Error ? error.message : fallback
}

export function ConnectSheet() {
  const { isOpen, open, close, triggerRef } = useConnectSheet()
  const panelRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>()
  const [notice, setNotice] = useState<string | null>(null)
  const { reset } = useConnect()
  const config = useConfig()

  // Reown's QR modal is an ordinary element, and nothing ordinary can draw above a top-layer
  // popover, so the sheet steps aside first. It comes back only to report a failure; closing the
  // QR modal is a plain cancel and says nothing.
  const connectPhoneWallet = useCallback(async () => {
    setNotice(null)
    close()
    try {
      await connectWith(config, { connector: ensureWalletConnectConnector(config) })
    } catch (failure) {
      if (isUserRejection(failure) || /connection request reset/i.test(failure instanceof Error ? failure.message : '')) return
      setNotice(connectErrorMessage(failure))
      open()
    }
  }, [close, config, open])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onToggle = (event: Event) => {
      const toggle = event as ToggleEvent
      if (toggle.newState === 'closed') close()
    }
    panel.addEventListener('toggle', onToggle)
    return () => panel.removeEventListener('toggle', onToggle)
  }, [close])

  useEffect(() => {
    if (isOpen) reset()
  }, [isOpen, reset])

  // Escape always closes, even where the browser's own light-dismiss does not fire for a
  // programmatically opened popover; and a successful connect closes the sheet on its own.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, close])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (isOpen) {
      const trigger = triggerRef.current
      if (trigger) {
        const rect = trigger.getBoundingClientRect()
        const top = rect.bottom + 8
        // Below 640px the stylesheet turns the sheet into a bottom sheet with its own cap; the inline cap is desktop-only.
        const desktop = window.matchMedia('(min-width: 640px)').matches
        setStyle(desktop ? { top, left: Math.max(16, rect.right - 320), width: 320, maxHeight: `calc(100dvh - ${top + 16}px)` } : { top, left: Math.max(16, rect.right - 320), width: 320 })
      } else {
        setStyle({ top: 64, right: 16, width: 320 })
      }
      return
    }
    hidePopover(panel)
  }, [isOpen, triggerRef])

  // Shown only after the position has been committed, so it never paints at the default spot first.
  // No animation frame in between: a hidden or throttled tab pauses those, and a dialog must not wait on one.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel || !isOpen || !style) return
    showPopover(panel)
    panel.focus()
  }, [isOpen, style])

  useEffect(() => {
    if (!isOpen || 'popover' in HTMLElement.prototype) return
    const onPointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [isOpen, close, triggerRef])

  return (
    <div
      ref={panelRef}
      id="connect-sheet"
      {...({ popover: 'auto' } as { popover: 'auto' })}
      style={style}
      className="connect-sheet"
      hidden={!isOpen && !('popover' in HTMLElement.prototype)}
      role="dialog"
      aria-labelledby="connect-sheet-title"
      aria-label="Wallet"
      tabIndex={-1}
    >
      {isOpen && <ConnectSheetBody notice={notice} onPhoneWallet={() => void connectPhoneWallet()} />}
    </div>
  )
}

type Mode = 'menu' | 'create' | 'import'
type ProtectionKind = Protection['kind']

interface ConnectSheetBodyProps {
  notice: string | null
  onPhoneWallet: () => void
}

/** Everything inside the sheet. Mounted fresh on each open, so form, reveal and confirm state never leaks between opens. */
function ConnectSheetBody({ notice, onPhoneWallet }: ConnectSheetBodyProps) {
  const { close } = useConnectSheet()
  const importRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const revealRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState<'address' | 'key' | null>(null)
  const [mode, setMode] = useState<Mode>('menu')
  const [passkeyOk, setPasskeyOk] = useState(false)
  const [protection, setProtection] = useState<ProtectionKind>('password')
  const [password, setPassword] = useState('')
  const [passwordRepeat, setPasswordRepeat] = useState('')
  const [importValue, setImportValue] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealing, setRevealing] = useState(false)
  const [revealPassword, setRevealPassword] = useState('')
  const [revealError, setRevealError] = useState<string | null>(null)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)
  const [confirmForget, setConfirmForget] = useState(false)
  const { address, isConnected, isReconnecting, connector: activeConnector } = useAccount()
  const connectors = useConnectors()
  const { connect, isPending, variables, error } = useConnect()
  const { disconnect } = useDisconnect()
  const { data: balance } = useBalance({ address, query: { enabled: Boolean(address) } })
  const local = useLocalWallet()
  // A connect from an extension row closes the sheet; a wallet made or imported here stays open so
  // the owner meets the custody terms and "Back up private key" before anything else.
  const keepOpenRef = useRef(false)
  const wasConnected = useRef(isConnected)
  useEffect(() => {
    if (isConnected && !wasConnected.current && !keepOpenRef.current) close()
    if (isConnected) keepOpenRef.current = false
    wasConnected.current = isConnected
  }, [close, isConnected])

  useEffect(() => {
    let cancelled = false
    void passkeysAvailable().then((ok) => {
      if (cancelled) return
      setPasskeyOk(ok)
      if (ok) setProtection('passkey')
    })
    return () => {
      cancelled = true
    }
  }, [])

  // WalletConnect has its own row below: it exists before its connector does.
  const rows = visibleConnectors(connectors).filter(
    (connector) => connector.id !== WALLETCONNECT_CONNECTOR_ID && (connector.id !== LOCAL_WALLET_CONNECTOR_ID || local.address),
  )
  const injectedRows = rows.filter((connector) => connector.type === 'injected')
  const localConnector = connectors.find((connector) => connector.id === LOCAL_WALLET_CONNECTOR_ID)
  const usingLocal = activeConnector?.id === LOCAL_WALLET_CONNECTOR_ID
  const pendingId = isPending
    ? typeof variables?.connector === 'object' && variables.connector
      ? variables.connector.id
      : undefined
    : undefined

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (mode === 'import') importRef.current?.focus()
    else if (mode === 'create') passwordRef.current?.focus()
  }, [mode])

  useEffect(() => {
    if (revealing) revealRef.current?.focus()
  }, [revealing])

  const copy = async (value: string, what: 'address' | 'key') => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
    } catch {
      // Clipboard can be denied; the value stays visible to copy by hand.
    }
  }

  const connectLocal = () => {
    if (localConnector) connect({ connector: localConnector })
  }

  const leaveForm = () => {
    setMode('menu')
    setFormError(null)
    setPassword('')
    setPasswordRepeat('')
    setImportValue('')
  }

  const submitWallet = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setFormError(null)
    if (protection === 'password') {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setFormError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
        return
      }
      if (password !== passwordRepeat) {
        setFormError('The two passwords differ.')
        return
      }
    }
    const choice: Protection = protection === 'passkey' ? { kind: 'passkey' } : { kind: 'password', password }
    setBusy(true)
    keepOpenRef.current = true
    try {
      if (mode === 'import') await importLocalWallet(importValue, choice)
      else await createLocalWallet(choice)
      leaveForm()
      connectLocal()
    } catch (failure) {
      keepOpenRef.current = false
      setFormError(failureMessage(failure, mode === 'import' ? 'Could not import the key.' : 'Could not create the wallet.'))
    } finally {
      setBusy(false)
    }
  }

  // Browser sign-in: the browser's own passkey chooser picks a wallet made earlier, here or elsewhere.
  // A returning owner has met the custody terms already, so a successful sign-in closes the sheet.
  const signIn = async () => {
    if (busy) return
    setBusy(true)
    setFormError(null)
    try {
      await signInWithPasskey()
      connectLocal()
    } catch (failure) {
      setFormError(failure instanceof UnlockCancelledError ? 'No passkey was chosen. New here? Create a browser wallet.' : failureMessage(failure, 'Could not sign in.'))
    } finally {
      setBusy(false)
    }
  }

  const reveal = async (event?: FormEvent) => {
    event?.preventDefault()
    if (busy) return
    setBusy(true)
    setRevealError(null)
    try {
      const key = await unlockLocalWallet(isPasskeyKind(local.protection) ? undefined : revealPassword)
      setRevealPassword('')
      setRevealing(false)
      setRevealedKey(key)
    } catch (failure) {
      setRevealError(failureMessage(failure, 'Could not unlock the wallet.'))
    } finally {
      setBusy(false)
    }
  }

  const startReveal = () => {
    if (isPasskeyKind(local.protection)) void reveal()
    else setRevealing(true)
  }

  const forget = () => {
    if (!confirmForget) {
      setConfirmForget(true)
      return
    }
    disconnect()
    forgetLocalWallet()
    setRevealedKey(null)
    close()
  }

  const protectionCopy =
    protection === 'password'
      ? `At least ${MIN_PASSWORD_LENGTH} characters. There is no reset: without the password the wallet cannot be unlocked.`
      : mode === 'import'
        ? 'Touch ID, Face ID or a security key unlocks each signature. The imported key stays encrypted in this browser.'
        : 'Touch ID, Face ID or a security key makes the wallet and approves each signature. The same passkey signs you in on your other devices.'

  return (
    <>
      {isConnected && address ? (
        <div className="p-4">
          <h2 className="text-sm text-g500">{usingLocal ? 'Browser wallet' : 'Connected wallet'}</h2>
          <p id="connect-sheet-title" className="mt-1 break-all text-lg font-semibold leading-tight tracking-[-0.01em]">{address}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <GhostButton onClick={() => void copy(address, 'address')}>{copied === 'address' ? 'Copied' : 'Copy address'}</GhostButton>
            <a className="ghost-button" href={addressExplorerUrl(address)} target="_blank" rel="noreferrer">
              View on ArcScan <ExternalLinkIcon className="h-4 w-4" />
            </a>
          </div>
          <dl className="receipt-lines mt-4">
            <div>
              <dt>Network</dt>
              <dd>{activeChain.name}</dd>
            </div>
            <div>
              <dt>USDC balance</dt>
              <dd>{balance ? formatAmount(balance.value, balance.decimals) : '—'}</dd>
            </div>
            {usingLocal && local.protection && (
              <div>
                <dt>Unlocked by</dt>
                <dd>{isPasskeyKind(local.protection) ? 'Passkey' : 'Password'}</dd>
              </div>
            )}
          </dl>
          {usingLocal && (
            <div className="mt-4 border-t border-ink pt-4">
              <p className="text-sm leading-6 text-g700">{custodySentence(local.protection)}</p>
              {revealedKey ? (
                <div className="mt-3">
                  <p className="text-sm leading-6 text-g700">Private key — never share it. Anyone holding it controls the wallet.</p>
                  <p className="mt-1 break-all text-sm font-semibold leading-snug">{revealedKey}</p>
                  <GhostButton className="mt-3" onClick={() => void copy(revealedKey, 'key')}>{copied === 'key' ? 'Copied' : 'Copy key'}</GhostButton>
                </div>
              ) : revealing ? (
                <form className="mt-3" onSubmit={(event) => void reveal(event)}>
                  <WalletUsernameHint />
                  <PasswordField
                    id="reveal-password"
                    name="password"
                    label="Wallet password"
                    ref={revealRef}
                    autoComplete="current-password"
                    required
                    value={revealPassword}
                    disabled={busy}
                    onChange={(event) => setRevealPassword(event.target.value)}
                  />
                  {revealError && <p className="mt-2 text-sm text-loss" role="alert">{revealError}</p>}
                  <div className="mt-3 flex gap-2">
                    <GhostButton type="submit" className="flex-1" disabled={busy || revealPassword.length === 0}>{busy ? 'Unlocking…' : 'Reveal key'}</GhostButton>
                    <GhostButton className="flex-1" disabled={busy} onClick={() => { setRevealing(false); setRevealError(null); setRevealPassword('') }}>Cancel</GhostButton>
                  </div>
                </form>
              ) : (
                <div className="mt-3">
                  <GhostButton disabled={busy} onClick={startReveal}>{busy ? 'Unlocking…' : 'Back up private key'}</GhostButton>
                  {revealError && <p className="mt-2 text-sm text-loss" role="alert">{revealError}</p>}
                </div>
              )}
            </div>
          )}
          {/* A disconnect during the post-reload session restore is undone when the restore lands, so it waits for it. */}
          <GhostButton className="mt-4 w-full" disabled={isReconnecting} onClick={() => disconnect()}>Disconnect</GhostButton>
          {usingLocal && (
            <div className="mt-3 border-t border-g300 pt-3">
              {confirmForget ? (
                <div>
                  <p className="text-sm leading-6 text-g700">{forgetSentence(local.protection)}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <GhostButton className="text-loss" onClick={forget}>Forget for good</GhostButton>
                    <GhostButton onClick={() => setConfirmForget(false)}>Keep it</GhostButton>
                  </div>
                </div>
              ) : (
                <button type="button" className="inline-flex min-h-11 items-center text-sm text-g700 underline underline-offset-[3px]" onClick={forget}>Forget this wallet</button>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <h2 id="connect-sheet-title" className="border-b border-ink px-4 py-3 text-base font-semibold">Connect a wallet</h2>
          <div className="token-list">
              {rows.map((connector) => {
                const pending = pendingId === connector.id
                const isLocal = connector.id === LOCAL_WALLET_CONNECTOR_ID
                return (
                  <button
                    type="button"
                    key={connector.uid}
                    className="token-row"
                    disabled={isPending}
                    aria-busy={pending}
                    onClick={() => connect({ connector })}
                  >
                    <span className="token-mark overflow-hidden" aria-hidden="true">
                      {connector.icon ? (
                        <img src={connector.icon} alt="" className="h-full w-full" />
                      ) : (
                        walletMonogram(connector.name)
                      )}
                    </span>
                    <span className="min-w-0 truncate text-left font-semibold">{connector.name}</span>
                    <span className="ml-auto pl-4 text-sm text-g500">
                      {pending ? 'Connecting…' : isLocal && local.address ? shortAddress(local.address) : 'Detected'}
                    </span>
                  </button>
                )
              })}
              <button type="button" className="token-row" disabled={isPending || busy} onClick={onPhoneWallet}>
                <span className="token-mark" aria-hidden="true">WC</span>
                <span className="min-w-0 truncate text-left font-semibold">WalletConnect</span>
                <span className="ml-auto pl-4 text-sm text-g500">Phone wallet</span>
              </button>
          </div>
          {notice && <p className="px-4 pt-3 text-sm text-loss" role="alert">{notice}</p>}
          {injectedRows.length === 0 && (
            <div className="px-4 py-3">
              <p className="text-sm leading-6 text-g700">
                No wallet extension found. {local.address ? 'Your browser wallet is above.' : 'Use a phone wallet above or a browser wallet below, or install MetaMask or Rabby and reload.'}
              </p>
              <a className="ghost-button mt-3" href="https://metamask.io/download" target="_blank" rel="noreferrer">Get MetaMask</a>
            </div>
          )}
          {!local.address && (
            <div className="border-t border-ink px-4 py-4">
              <h3 className="text-sm font-semibold">Browser wallet</h3>
              <p className="mt-1 text-sm leading-6 text-g700">
                {passkeyOk && (mode === 'menu' || protection === 'passkey')
                  ? mode === 'import'
                    ? 'The imported key is stored encrypted in this browser, and your passkey unlocks it for each signature, so nothing spends without you.'
                    : 'Your passkey is the wallet: the key is derived from it for each signature and never stored. Sign in with it in any browser where it syncs.'
                  : 'Made on this device and stored encrypted. Every signature asks for your password first, so nothing spends without you.'}
              </p>
              {mode === 'menu' ? (
                <div className="mt-3 grid gap-2">
                  {passkeyOk && <GhostButton disabled={busy} aria-busy={busy} onClick={() => void signIn()}>{busy ? 'Waiting for your passkey…' : 'Sign in with passkey'}</GhostButton>}
                  <GhostButton disabled={busy} onClick={() => setMode('create')}>Create a browser wallet</GhostButton>
                  {formError && <p className="text-sm text-loss" role="alert">{formError}</p>}
                  <button type="button" className="inline-flex min-h-11 items-center justify-self-start text-sm text-g700 underline underline-offset-[3px] disabled:text-g500" disabled={busy} onClick={() => setMode('import')}>
                    Import a private key
                  </button>
                </div>
              ) : (
                <form className="mt-3" onSubmit={(event) => void submitWallet(event)}>
                  {mode === 'import' && (
                    <PasswordField
                      id="import-key"
                      name="private-key"
                      label="Private key"
                      ref={importRef}
                      autoComplete="off"
                      required
                      value={importValue}
                      placeholder="0x… (64 hex characters)"
                      disabled={busy}
                      onChange={(event) => setImportValue(event.target.value)}
                    />
                  )}
                  {passkeyOk && (
                    <fieldset className={mode === 'import' ? 'mt-3' : undefined}>
                      <legend className="text-sm text-g500">Unlock with</legend>
                      <div className="mt-1 grid grid-cols-2 gap-2">
                        <button type="button" className="choice-button" data-active={protection === 'passkey'} aria-pressed={protection === 'passkey'} disabled={busy} onClick={() => setProtection('passkey')}>
                          Passkey
                        </button>
                        <button type="button" className="choice-button" data-active={protection === 'password'} aria-pressed={protection === 'password'} disabled={busy} onClick={() => setProtection('password')}>
                          Password
                        </button>
                      </div>
                    </fieldset>
                  )}
                  {protection === 'password' && (
                    <div className={mode === 'import' || passkeyOk ? 'mt-3' : undefined}>
                      <WalletUsernameHint />
                      <PasswordField
                        id="new-password"
                        name="new-password"
                        label="Wallet password"
                        ref={passwordRef}
                        autoComplete="new-password"
                        required
                        minLength={MIN_PASSWORD_LENGTH}
                        value={password}
                        disabled={busy}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <PasswordField
                        className="mt-2"
                        id="confirm-password"
                        name="confirm-password"
                        label="Repeat password"
                        autoComplete="new-password"
                        required
                        value={passwordRepeat}
                        disabled={busy}
                        onChange={(event) => setPasswordRepeat(event.target.value)}
                      />
                    </div>
                  )}
                  <p className="mt-2 text-sm leading-6 text-g700">{protectionCopy}</p>
                  {formError && <p className="mt-2 text-sm text-loss" role="alert">{formError}</p>}
                  <div className="mt-3 flex gap-2">
                    <GhostButton type="submit" className="flex-1" disabled={busy}>
                      {busy ? (mode === 'import' ? 'Importing…' : 'Creating…') : mode === 'import' ? 'Import wallet' : 'Create wallet'}
                    </GhostButton>
                    <GhostButton className="flex-1" disabled={busy} onClick={leaveForm}>Cancel</GhostButton>
                  </div>
                </form>
              )}
            </div>
          )}
          {error && <p className="px-4 py-3 text-sm text-g700">{connectErrorMessage(error)}</p>}
        </>
      )}
    </>
  )
}
