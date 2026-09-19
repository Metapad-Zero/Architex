/**
 * Key custody for the browser wallet. The private key never rests in the clear, and in the default
 * case it never rests at all:
 *   - passkey-derived (create / sign in): the WebAuthn PRF extension returns 32 secret bytes only
 *     after the authenticator verifies the user (Touch ID / Face ID / security key); the wallet key
 *     is derived from them on demand. Only a public hint (address + credential id) is stored, so the
 *     same passkey signs in again on any browser where it syncs.
 *   - passkey (imported key): the key is stored as AES-256-GCM ciphertext wrapped by the PRF output.
 *   - password: AES-256-GCM ciphertext wrapped by PBKDF2-SHA-256 with a per-keystore salt.
 * Unlocking yields the raw key for the duration of one signing call and nothing else.
 */
import { bytesToHex, hexToBytes, type Hex } from 'viem'

export type KeystoreKind = 'passkey-derived' | 'passkey' | 'password'

export function isPasskeyKind(kind: KeystoreKind | undefined): boolean {
  return kind === 'passkey-derived' || kind === 'passkey'
}

interface KeystoreBase {
  version: 1
  kind: KeystoreKind
  address: Hex
  salt: string // base64url, 32 bytes
  iv: string // base64url, 12 bytes
  ciphertext: string // base64url
}

/** No secret inside: the key is re-derived from the passkey for every signature. */
export interface DerivedPasskeyKeystore {
  version: 1
  kind: 'passkey-derived'
  address: Hex
  credentialId: string // base64url
  rpId: string
}

export interface PasskeyKeystore extends KeystoreBase {
  kind: 'passkey'
  credentialId: string // base64url
  rpId: string
}

export interface PasswordKeystore extends KeystoreBase {
  kind: 'password'
  iterations: number
}

export type Keystore = DerivedPasskeyKeystore | PasskeyKeystore | PasswordKeystore

export const PBKDF2_ITERATIONS = 600_000
const PRF_INFO = new TextEncoder().encode('architex-browser-wallet-v1')

// Wallet addresses are a function of these values: changing any of them orphans every
// passkey-derived wallet ever made. They are frozen.
const WALLET_PRF_SALT = new TextEncoder().encode('architex:wallet:v1')
const WALLET_HKDF_SALT = new TextEncoder().encode('architex:wallet:hkdf:v1')
const WALLET_KEY_INFO = 'secp256k1'
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

// The first four bytes of a passkey's user handle say what it is for, so sign-in can refuse a
// passkey that only wraps an imported key in the browser that made it.
const HANDLE_WALLET = 'atx1'
const HANDLE_WRAP = 'atxw'

export class UnlockCancelledError extends Error {
  constructor(message = 'User rejected the request.') {
    super(message)
    this.name = 'UnlockCancelledError'
  }
}

export class WrongSecretError extends Error {
  constructor() {
    super('That password did not unlock the wallet.')
    this.name = 'WrongSecretError'
  }
}

// ---- encoding helpers -------------------------------------------------------------------------

export function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// ---- wrapping keys -----------------------------------------------------------------------------

async function aesKeyFromPassword(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bufferOf(salt), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function aesKeyFromPrf(prfOutput: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', bufferOf(prfOutput), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bufferOf(salt), info: bufferOf(PRF_INFO) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function seal(key: CryptoKey, privateKey: Hex): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = randomBytes(12)
  const plaintext = hexToBytes(privateKey)
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufferOf(iv) }, key, bufferOf(plaintext)))
  plaintext.fill(0)
  return { iv, ciphertext }
}

async function open(key: CryptoKey, iv: Uint8Array, ciphertext: Uint8Array): Promise<Hex> {
  try {
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufferOf(iv) }, key, bufferOf(ciphertext)))
    const hex = bytesToHex(plaintext)
    plaintext.fill(0)
    return hex
  } catch {
    throw new WrongSecretError()
  }
}

// ---- password keystores ------------------------------------------------------------------------

export async function createPasswordKeystore(privateKey: Hex, address: Hex, password: string, iterations = PBKDF2_ITERATIONS): Promise<PasswordKeystore> {
  const salt = randomBytes(32)
  const key = await aesKeyFromPassword(password, salt, iterations)
  const { iv, ciphertext } = await seal(key, privateKey)
  return { version: 1, kind: 'password', address, salt: toBase64url(salt), iv: toBase64url(iv), ciphertext: toBase64url(ciphertext), iterations }
}

export async function unlockPasswordKeystore(keystore: PasswordKeystore, password: string): Promise<Hex> {
  const key = await aesKeyFromPassword(password, fromBase64url(keystore.salt), keystore.iterations)
  return open(key, fromBase64url(keystore.iv), fromBase64url(keystore.ciphertext))
}

// ---- passkey keystores (WebAuthn PRF) ----------------------------------------------------------

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
}

function rpId(): string {
  return window.location.hostname
}

type ClientCapabilitiesProbe = () => Promise<Record<string, boolean | undefined>>

/**
 * True when a platform authenticator exists and the browser does not rule out PRF. Browsers without
 * `getClientCapabilities` cannot say before the first create, so they stay offered and a passkey
 * without PRF is refused at creation instead.
 */
export async function passkeysAvailable(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !('PublicKeyCredential' in window)) return false
    if (!window.isSecureContext) return false
    if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false
    const probe = (PublicKeyCredential as unknown as { getClientCapabilities?: ClientCapabilitiesProbe }).getClientCapabilities
    if (typeof probe === 'function') {
      const capabilities = await probe.call(PublicKeyCredential)
      if (capabilities['extension:prf'] === false) return false
    }
    return true
  } catch {
    return false
  }
}

function webauthnError(error: unknown): Error {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return new UnlockCancelledError('User rejected the passkey request.')
  }
  return error instanceof Error ? error : new Error('Passkey request failed.')
}

function userHandle(tag: string): Uint8Array {
  const handle = randomBytes(16)
  handle.set(new TextEncoder().encode(tag))
  return handle
}

function handleHasTag(handle: Uint8Array, tag: string): boolean {
  const expected = new TextEncoder().encode(tag)
  return handle.length >= expected.length && expected.every((byte, index) => handle[index] === byte)
}

interface Registration {
  credentialId: string
  prfOutput: Uint8Array | undefined
}

/** Registers a discoverable, user-verifying passkey and evaluates PRF with `prfSalt` where the authenticator allows it at creation. */
async function registerPasskey(userId: Uint8Array, label: string, prfSalt: Uint8Array): Promise<Registration> {
  let credential: PublicKeyCredential
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId(), name: 'Architex' },
        user: { id: bufferOf(userId), name: label, displayName: label },
        challenge: bufferOf(randomBytes(32)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        timeout: 120_000,
        extensions: { prf: { eval: { first: bufferOf(prfSalt) } } },
      },
    })) as PublicKeyCredential
  } catch (error) {
    throw webauthnError(error)
  }
  const results = credential.getClientExtensionResults() as PrfExtensionResults
  if (!results.prf?.enabled) throw new Error('This passkey cannot hold a wallet here (no PRF support). Use a password instead.')
  return {
    credentialId: toBase64url(new Uint8Array(credential.rawId)),
    prfOutput: results.prf.results?.first ? new Uint8Array(results.prf.results.first) : undefined,
  }
}

interface Assertion {
  output: Uint8Array
  credentialId: string
  userHandle: Uint8Array
}

/**
 * Asks the authenticator for the PRF output. With a `credentialId` the prompt is pinned to that one
 * passkey (every signature); without one the browser shows its own account chooser (sign-in).
 */
async function assertPrf(salt: Uint8Array, credentialId?: string): Promise<Assertion> {
  let assertion: PublicKeyCredential
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        rpId: rpId(),
        challenge: bufferOf(randomBytes(32)),
        allowCredentials: credentialId ? [{ type: 'public-key', id: bufferOf(fromBase64url(credentialId)) }] : [],
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { eval: { first: bufferOf(salt) } } },
      },
    })) as PublicKeyCredential
  } catch (error) {
    throw webauthnError(error)
  }
  const results = assertion.getClientExtensionResults() as PrfExtensionResults
  const first = results.prf?.results?.first
  if (!first) throw new Error('The passkey did not return its secret; try again.')
  const response = assertion.response as AuthenticatorAssertionResponse
  return {
    output: new Uint8Array(first),
    credentialId: toBase64url(new Uint8Array(assertion.rawId)),
    userHandle: new Uint8Array(response.userHandle ?? new ArrayBuffer(0)),
  }
}

// ---- passkey-derived wallets -------------------------------------------------------------------

/** PRF output → secp256k1 private key (HKDF-SHA-256; re-drawn in the ~2^-128 case the scalar is out of range). */
export async function deriveWalletKey(prfOutput: Uint8Array): Promise<Hex> {
  const material = await crypto.subtle.importKey('raw', bufferOf(prfOutput), 'HKDF', false, ['deriveBits'])
  for (let counter = 0; counter < 8; counter += 1) {
    const info = new TextEncoder().encode(`${WALLET_KEY_INFO}:${counter}`)
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bufferOf(WALLET_HKDF_SALT), info: bufferOf(info) }, material, 256))
    const candidate = bytesToHex(bits)
    bits.fill(0)
    const scalar = BigInt(candidate)
    if (scalar > 0n && scalar < SECP256K1_ORDER) return candidate
  }
  throw new Error('Could not derive a wallet key from this passkey.')
}

export interface WalletPasskey {
  credentialId: string
  rpId: string
  privateKey: Hex
}

/** Makes a new passkey whose PRF output is the wallet. Returns the user id so the passkey can be renamed once the address is known. */
export async function createWalletPasskey(): Promise<WalletPasskey & { userId: string }> {
  const userId = userHandle(HANDLE_WALLET)
  const label = `Architex wallet · ${new Date().toISOString().slice(0, 10)}`
  const registration = await registerPasskey(userId, label, WALLET_PRF_SALT)
  const prfOutput = registration.prfOutput ?? (await assertPrf(WALLET_PRF_SALT, registration.credentialId)).output
  const privateKey = await deriveWalletKey(prfOutput)
  prfOutput.fill(0)
  return { credentialId: registration.credentialId, rpId: rpId(), privateKey, userId: toBase64url(userId) }
}

/** Browser sign-in: the browser's own passkey chooser picks the wallet; nothing local is needed. */
export async function signInWalletPasskey(): Promise<WalletPasskey> {
  const assertion = await assertPrf(WALLET_PRF_SALT)
  if (handleHasTag(assertion.userHandle, HANDLE_WRAP)) {
    assertion.output.fill(0)
    throw new Error('That passkey protects an imported key in the browser that made it, so it cannot sign in here.')
  }
  const privateKey = await deriveWalletKey(assertion.output)
  assertion.output.fill(0)
  return { credentialId: assertion.credentialId, rpId: rpId(), privateKey }
}

export async function deriveFromWalletPasskey(credentialId: string): Promise<Hex> {
  const assertion = await assertPrf(WALLET_PRF_SALT, credentialId)
  const privateKey = await deriveWalletKey(assertion.output)
  assertion.output.fill(0)
  return privateKey
}

interface UserDetailsSignal {
  rpId: string
  userId: string
  name: string
  displayName: string
}

/** Cosmetic: shows the address in the browser's passkey chooser where the Signal API exists. */
export async function labelWalletPasskey(userId: string, name: string): Promise<void> {
  try {
    const signal = (PublicKeyCredential as unknown as { signalCurrentUserDetails?: (details: UserDetailsSignal) => Promise<void> }).signalCurrentUserDetails
    if (typeof signal === 'function') await signal.call(PublicKeyCredential, { rpId: rpId(), userId, name, displayName: name })
  } catch {
    // The passkey keeps its creation label.
  }
}

// ---- passkey-wrapped keystores (imported keys) ---------------------------------------------------

/** Wraps an existing key with a new passkey. Some authenticators return the PRF output only on `get`, so after registration we assert once. */
export async function createPasskeyKeystore(privateKey: Hex, address: Hex, label: string): Promise<PasskeyKeystore> {
  const salt = randomBytes(32)
  const registration = await registerPasskey(userHandle(HANDLE_WRAP), label, salt)
  const prfOutput = registration.prfOutput ?? (await assertPrf(salt, registration.credentialId)).output
  const key = await aesKeyFromPrf(prfOutput, salt)
  prfOutput.fill(0)
  const { iv, ciphertext } = await seal(key, privateKey)
  return { version: 1, kind: 'passkey', address, salt: toBase64url(salt), iv: toBase64url(iv), ciphertext: toBase64url(ciphertext), credentialId: registration.credentialId, rpId: rpId() }
}

export async function unlockPasskeyKeystore(keystore: PasskeyKeystore): Promise<Hex> {
  const salt = fromBase64url(keystore.salt)
  const { output } = await assertPrf(salt, keystore.credentialId)
  const key = await aesKeyFromPrf(output, salt)
  output.fill(0)
  return open(key, fromBase64url(keystore.iv), fromBase64url(keystore.ciphertext))
}

export function isKeystore(value: unknown): value is Keystore {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.address !== 'string') return false
  if (record.kind === 'passkey-derived') return typeof record.credentialId === 'string'
  return (record.kind === 'passkey' || record.kind === 'password') && typeof record.ciphertext === 'string'
}
