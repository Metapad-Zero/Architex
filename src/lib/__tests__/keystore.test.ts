import { describe, expect, test } from 'bun:test'
import { privateKeyToAccount } from 'viem/accounts'
import { createPasswordKeystore, deriveWalletKey, fromBase64url, isKeystore, isPasskeyKind, rpIdFor, toBase64url, unlockPasswordKeystore } from '../keystore'

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const FROZEN_ADDRESS = '0xf2F9D3a936fC92583203923303b0db15A6578219'

describe('passkey-derived wallet', () => {
  const prf = (fill: number) => new Uint8Array(32).fill(fill)

  test('the same passkey output always yields the same wallet', async () => {
    const first = await deriveWalletKey(prf(7))
    const again = await deriveWalletKey(prf(7))
    expect(first).toBe(again)
    expect(/^0x[0-9a-f]{64}$/.test(first)).toBe(true)
    expect(/^0x[0-9a-fA-F]{40}$/.test(privateKeyToAccount(first).address)).toBe(true)
  })

  test('different passkeys yield different wallets, and the key is not the raw output', async () => {
    const a = await deriveWalletKey(prf(1))
    const b = await deriveWalletKey(prf(2))
    expect(a === b).toBe(false)
    expect(a === `0x${'01'.repeat(32)}`).toBe(false)
  })

  // Frozen vector: if this changes, every passkey-derived wallet in the wild changes address.
  test('derivation constants are frozen', async () => {
    expect(await deriveWalletKey(prf(0xa5))).toBe(await deriveWalletKey(new Uint8Array(32).fill(0xa5)))
    const address = privateKeyToAccount(await deriveWalletKey(prf(0xa5))).address
    expect(address).toBe(FROZEN_ADDRESS)
  })

  // Frozen: the passkey scope decides which wallets a browser can reach.
  test('the production domain and its subdomains share one passkey scope; other hosts keep their own', () => {
    expect(rpIdFor('architex.fun')).toBe('architex.fun')
    expect(rpIdFor('www.architex.fun')).toBe('architex.fun')
    expect(rpIdFor('app.architex.fun')).toBe('architex.fun')
    expect(rpIdFor('localhost')).toBe('localhost')
    expect(rpIdFor('architex-git-main.vercel.app')).toBe('architex-git-main.vercel.app')
    expect(rpIdFor('notarchitex.fun')).toBe('notarchitex.fun')
    expect(rpIdFor('architex.fun.evil.example')).toBe('architex.fun.evil.example')
  })

  test('the stored hint carries no secret and is recognised', () => {
    const hint = { version: 1, kind: 'passkey-derived', address: ADDRESS, credentialId: 'abc', rpId: 'localhost' }
    expect(isKeystore(hint)).toBe(true)
    expect(isKeystore({ ...hint, credentialId: undefined })).toBe(false)
    expect(isPasskeyKind('passkey-derived')).toBe(true)
    expect(isPasskeyKind('passkey')).toBe(true)
    expect(isPasskeyKind('password')).toBe(false)
  })
})

describe('password keystore', () => {
  test('encrypts and unlocks with the right password', async () => {
    const keystore = await createPasswordKeystore(KEY, ADDRESS, 'correct horse battery staple', 10_000)
    expect(keystore.kind).toBe('password')
    expect(keystore.address).toBe(ADDRESS)
    expect(keystore.ciphertext.includes(KEY.slice(2))).toBe(false)
    expect(JSON.stringify(keystore).includes(KEY.slice(4, 20))).toBe(false)
    expect(await unlockPasswordKeystore(keystore, 'correct horse battery staple')).toBe(KEY)
  })

  test('refuses the wrong password', async () => {
    const keystore = await createPasswordKeystore(KEY, ADDRESS, 'right', 10_000)
    let failed = false
    try {
      await unlockPasswordKeystore(keystore, 'wrong')
    } catch (error) {
      failed = error instanceof Error && error.name === 'WrongSecretError'
    }
    expect(failed).toBe(true)
  })

  test('uses a fresh salt and iv every time', async () => {
    const a = await createPasswordKeystore(KEY, ADDRESS, 'pw', 10_000)
    const b = await createPasswordKeystore(KEY, ADDRESS, 'pw', 10_000)
    expect(a.salt === b.salt).toBe(false)
    expect(a.iv === b.iv).toBe(false)
    expect(a.ciphertext === b.ciphertext).toBe(false)
  })

  test('base64url round-trips and the guard recognises keystores', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(Array.from(fromBase64url(toBase64url(bytes)))).toEqual(Array.from(bytes))
    const keystore = await createPasswordKeystore(KEY, ADDRESS, 'pw', 10_000)
    expect(isKeystore(keystore)).toBe(true)
    expect(isKeystore({ kind: 'password' })).toBe(false)
    expect(isKeystore(KEY)).toBe(false)
  })
})
