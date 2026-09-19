import { useEffect, useState } from 'react'
import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  createPasskeyKeystore,
  createPasswordKeystore,
  createWalletPasskey,
  deriveFromWalletPasskey,
  isKeystore,
  labelWalletPasskey,
  signInWalletPasskey,
  unlockPasskeyKeystore,
  unlockPasswordKeystore,
  type Keystore,
  type KeystoreKind,
} from './keystore'

/**
 * The browser wallet, for a visitor with no extension (src/lib/keystore.ts holds the custody rules).
 * Created with a passkey, the wallet IS the passkey: the key is derived from it for one signature at
 * a time and never stored, and "Sign in with passkey" brings the same wallet back in any browser
 * where the passkey syncs. An imported key, or a wallet made with a password, is stored only as
 * ciphertext in this browser, so clearing site data deletes it; the UI asks for a backup first.
 */
export const LOCAL_WALLET_EVENT = 'architex:wallet'
export const MIN_PASSWORD_LENGTH = 8
const STORAGE_KEY = 'architex.wallet.keystore'
const LEGACY_PLAINTEXT_KEY = 'architex.wallet.key'
const FORGOTTEN_KEY = 'architex.wallet.forgotten'
const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/

export type Protection = { kind: 'passkey' } | { kind: 'password'; password: string }

export class NoLocalWalletError extends Error {
  constructor() {
    super('No browser wallet yet. Create one or import a key first.')
    this.name = 'NoLocalWalletError'
  }
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function announce(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LOCAL_WALLET_EVENT))
}

function seedForgotten(): boolean {
  try {
    return typeof window !== 'undefined' && window.sessionStorage.getItem(FORGOTTEN_KEY) === '1'
  } catch {
    return false
  }
}

function setSeedForgotten(value: boolean): void {
  try {
    if (typeof window === 'undefined') return
    if (value) window.sessionStorage.setItem(FORGOTTEN_KEY, '1')
    else window.sessionStorage.removeItem(FORGOTTEN_KEY)
  } catch {
    // session storage unavailable
  }
}

export function readKeystore(): Keystore | undefined {
  const raw = storage()?.getItem(STORAGE_KEY)
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return isKeystore(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function localWalletAddress(): Address | undefined {
  return readKeystore()?.address
}

export function localWalletProtection(): KeystoreKind | undefined {
  return readKeystore()?.kind
}

export function hasLocalWallet(): boolean {
  return readKeystore() !== undefined
}

function normaliseKey(input: string): Hex {
  const trimmed = input.trim()
  const key = (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex
  if (!KEY_PATTERN.test(key)) throw new Error('A private key is 64 hex characters, with or without 0x.')
  return key
}

export function checkPassword(password: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  return password
}

function passkeyLabel(address: Address): string {
  return `Architex ${address.slice(0, 6)}…${address.slice(-4)}`
}

function save(keystore: Keystore): Address {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(keystore))
  setSeedForgotten(false)
  announce()
  return keystore.address
}

/** Stores an existing key as ciphertext, wrapped by a new passkey or by a password. */
async function wrap(privateKey: Hex, protection: Protection): Promise<Address> {
  const address = privateKeyToAccount(privateKey).address
  return save(
    protection.kind === 'passkey'
      ? await createPasskeyKeystore(privateKey, address, passkeyLabel(address))
      : await createPasswordKeystore(privateKey, address, checkPassword(protection.password)),
  )
}

/** With a passkey the wallet is derived from the passkey itself and nothing secret is stored. */
export async function createLocalWallet(protection: Protection): Promise<Address> {
  if (protection.kind === 'password') return wrap(generatePrivateKey(), protection)
  const passkey = await createWalletPasskey()
  const address = privateKeyToAccount(passkey.privateKey).address
  void labelWalletPasskey(passkey.userId, passkeyLabel(address))
  return save({ version: 1, kind: 'passkey-derived', address, credentialId: passkey.credentialId, rpId: passkey.rpId })
}

export function importLocalWallet(input: string, protection: Protection): Promise<Address> {
  return wrap(normaliseKey(input), protection)
}

/** Browser sign-in: the browser's passkey chooser picks a wallet made earlier, here or on another device. */
export async function signInWithPasskey(): Promise<Address> {
  const passkey = await signInWalletPasskey()
  const address = privateKeyToAccount(passkey.privateKey).address
  return save({ version: 1, kind: 'passkey-derived', address, credentialId: passkey.credentialId, rpId: passkey.rpId })
}

/**
 * Yields the key for one use. A passkey wallet prompts the authenticator here (call it from a user
 * gesture); a password keystore needs the password. The caller drops the key when done.
 */
export async function unlockLocalWallet(password?: string): Promise<Hex> {
  const keystore = readKeystore()
  if (!keystore) throw new NoLocalWalletError()
  if (keystore.kind === 'passkey-derived') {
    const key = await deriveFromWalletPasskey(keystore.credentialId)
    if (privateKeyToAccount(key).address.toLowerCase() !== keystore.address.toLowerCase()) {
      throw new Error('That passkey belongs to a different wallet.')
    }
    return key
  }
  if (keystore.kind === 'passkey') return unlockPasskeyKeystore(keystore)
  if (password === undefined) throw new Error('Enter the wallet password.')
  return unlockPasswordKeystore(keystore, password)
}

export function forgetLocalWallet(): void {
  storage()?.removeItem(STORAGE_KEY)
  setSeedForgotten(true)
  announce()
}

let seeding: Promise<void> = Promise.resolve()

/** Resolves once any development seed has landed, so auto-connect does not race it. */
export function whenLocalWalletReady(): Promise<void> {
  return seeding
}

/**
 * Development only: store a known testnet key once, password-protected like any other wallet, so
 * automated checks have a funded wallet. Never called from a production build (the caller is a
 * statically dead branch there), and a wallet the user forgot in this session is not re-seeded.
 */
export function seedLocalWallet(key: string, password: string): Promise<void> {
  storage()?.removeItem(LEGACY_PLAINTEXT_KEY)
  if (!KEY_PATTERN.test(key) || hasLocalWallet() || seedForgotten()) return Promise.resolve()
  seeding = wrap(key as Hex, { kind: 'password', password }).then(
    () => undefined,
    () => undefined,
  )
  return seeding
}

export interface LocalWalletState {
  address: Address | undefined
  protection: KeystoreKind | undefined
}

/** Only the address and the protection kind live in React state; the key is decrypted per use. */
export function useLocalWallet(): LocalWalletState {
  const [state, setState] = useState<LocalWalletState>(() => ({ address: localWalletAddress(), protection: localWalletProtection() }))
  useEffect(() => {
    const refresh = () => setState({ address: localWalletAddress(), protection: localWalletProtection() })
    window.addEventListener(LOCAL_WALLET_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(LOCAL_WALLET_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])
  return state
}
