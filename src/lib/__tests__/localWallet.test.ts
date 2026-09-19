import { beforeEach, describe, expect, test } from 'bun:test'

// Minimal browser shims so the module's storage and event plumbing run under bun test.
const store = new Map<string, string>()
const session = new Map<string, string>()
const fakeStorage = (map: Map<string, string>) => ({
  getItem: (key: string) => map.get(key) ?? null,
  setItem: (key: string, value: string) => void map.set(key, value),
  removeItem: (key: string) => void map.delete(key),
})
const events: string[] = []
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: fakeStorage(store),
  sessionStorage: fakeStorage(session),
  dispatchEvent: (event: { type: string }) => {
    events.push(event.type)
    return true
  },
  addEventListener: () => {},
  removeEventListener: () => {},
}
;(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class {
  type: string
  constructor(type: string) {
    this.type = type
  }
}

const { createLocalWallet, forgetLocalWallet, hasLocalWallet, importLocalWallet, localWalletAddress, localWalletProtection, readKeystore, unlockLocalWallet } =
  await import('../localWallet')

const KEY = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const PASSWORD = 'correct horse battery staple'

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return ''
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  }
}

describe('browser wallet keystore', () => {
  beforeEach(() => {
    store.clear()
    session.clear()
    events.length = 0
  })

  test('creates an encrypted wallet and unlocks it with the password', async () => {
    expect(hasLocalWallet()).toBe(false)
    const address = await createLocalWallet({ kind: 'password', password: PASSWORD })
    expect(ADDRESS.test(address)).toBe(true)
    expect(localWalletAddress()).toBe(address)
    expect(localWalletProtection()).toBe('password')
    expect(events.includes('architex:wallet')).toBe(true)

    const key = await unlockLocalWallet(PASSWORD)
    expect(KEY.test(key)).toBe(true)
    const stored = store.get('architex.wallet.keystore') ?? ''
    expect(stored.includes(key.slice(2, 20))).toBe(false)
    expect(readKeystore()?.address).toBe(address)
  })

  test('imports a key with or without 0x and rejects junk or a short password', async () => {
    const raw = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const address = await importLocalWallet(raw, { kind: 'password', password: PASSWORD })
    expect(address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(await unlockLocalWallet(PASSWORD)).toBe(`0x${raw}`)
    expect(await importLocalWallet(`0x${raw}`, { kind: 'password', password: PASSWORD })).toBe(address)
    expect((await failure(() => importLocalWallet('not-a-key', { kind: 'password', password: PASSWORD }))).includes('64 hex characters')).toBe(true)
    expect((await failure(() => importLocalWallet(raw, { kind: 'password', password: 'short' }))).includes('at least 8 characters')).toBe(true)
  })

  test('refuses the wrong password and forgets on request', async () => {
    await createLocalWallet({ kind: 'password', password: PASSWORD })
    expect((await failure(() => unlockLocalWallet('wrong password'))).startsWith('WrongSecretError')).toBe(true)
    expect((await failure(() => unlockLocalWallet())).includes('Enter the wallet password')).toBe(true)
    forgetLocalWallet()
    expect(hasLocalWallet()).toBe(false)
    expect(localWalletAddress() === undefined).toBe(true)
    expect((await failure(() => unlockLocalWallet(PASSWORD))).startsWith('NoLocalWalletError')).toBe(true)
  })
})
