import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { hashFor, type AppRoute } from '../../hooks/useHashRoute'

// The landing page (public/home/index.html) is served at architex.fun/ and the app at architex.fun/app/: one origin,
// so the passkeys and browser wallets people saved on architex.fun are still there. vite.config.ts moves both pages
// into place at build time. These checks keep the landing's links and its forwarder in step with the app's router.

const LANDING = readFileSync(fileURLToPath(new URL('../../../public/home/index.html', import.meta.url)), 'utf8')

/** Every view the app opens, as the hash the app itself writes, plus the bulletin's `#updates` (lib/updates). */
const VIEWS: AppRoute[] = [{ view: 'swap' }, { view: 'pools' }, { view: 'launch' }, { view: 'launch-new' }, { view: 'bridge' }, { view: 'docs' }]
const APP_HASHES = new Set([...VIEWS.map(hashFor), '#updates'])

/** The landing's own section anchors: its forwarder keeps these and sends every other hash to the app. */
const OWN = (LANDING.match(/var own=\[([^\]]*)\]/)?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, ''))

/** The forwarder is the first script in the head; it runs before anything paints. */
const FORWARDER = LANDING.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''

/**
 * Where the forwarder sends a visitor, or undefined when the landing stays. `later` is a hash put in the address bar
 * once the landing is open: the browser fires hashchange for that and does not load the page again.
 */
function forward(hash: string, opts: { search?: string; ios?: boolean; installed?: boolean; later?: string } = {}): string | undefined {
  let target: string | undefined
  const listeners: Array<() => void> = []
  const location = { hash, search: opts.search ?? '', replace: (url: string) => { target = url } }
  const root = { setAttribute() {}, classList: { add() {} } }
  runInNewContext(FORWARDER, {
    location,
    navigator: { standalone: opts.ios === true },
    matchMedia: () => ({ matches: opts.installed === true }),
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.push(listener)
    },
    localStorage: { getItem: () => null },
    document: { documentElement: root, querySelectorAll: () => [] },
    setTimeout: () => 0,
  })
  if (opts.later !== undefined && target === undefined) {
    location.hash = opts.later
    for (const listener of listeners) listener()
  }
  return target
}

describe('landing page', () => {
  test('opens the app on this origin, at a view the app knows', () => {
    expect(LANDING).not.toContain('app.architex.fun')
    const links = [...LANDING.matchAll(/href="(\/app\/[^"]*)"/g)].map((m) => m[1])
    expect(links.length).toBeGreaterThan(5)
    for (const link of links) {
      expect(link.startsWith('/app/#')).toBe(true)
      expect(APP_HASHES.has(link.slice('/app/'.length))).toBe(true)
    }
  })

  test('its in-page links are its own anchors, and none of them is an app view', () => {
    expect(OWN.length).toBeGreaterThan(5)
    for (const anchor of OWN) expect(LANDING).toContain(`id="${anchor}"`)
    for (const [, anchor] of LANDING.matchAll(/<a\b[^>]*\bhref="#([^"]*)"/g)) expect(OWN).toContain(anchor)
    const views = new Set([...APP_HASHES].map((h) => h.slice(1).split(/[/?]/)[0]))
    for (const anchor of OWN) expect(views.has(anchor)).toBe(false)
  })

  test('old links to the app forward to /app/ with their query and hash', () => {
    expect(forward('#swap')).toBe('/app/#swap')
    expect(forward('#swap?in=USDC&out=EURC')).toBe('/app/#swap?in=USDC&out=EURC')
    expect(forward('#launch/0x1111111111111111111111111111111111111111?side=sell', { search: '?ref=x' })).toBe(
      '/app/?ref=x#launch/0x1111111111111111111111111111111111111111?side=sell',
    )
    expect(forward('#docs/integrate')).toBe('/app/#docs/integrate')
    expect(forward('#bridge')).toBe('/app/#bridge')
    expect(forward('#updates')).toBe('/app/#updates')
  })

  test('the landing stays for its own anchors and a bare visit', () => {
    expect(forward('')).toBe(undefined)
    for (const anchor of OWN) expect(forward(`#${anchor}`)).toBe(undefined)
  })

  test('an old link put into the address bar of the open landing still opens the app', () => {
    expect(forward('', { later: '#launch/new' })).toBe('/app/#launch/new')
    expect(forward('#about', { later: '#pools' })).toBe('/app/#pools')
    expect(forward('', { later: '#contracts' })).toBe(undefined)
  })

  test('home-screen installs made before the move open the app', () => {
    expect(forward('', { installed: true })).toBe('/app/')
    expect(forward('', { ios: true })).toBe('/app/')
    expect(forward('#about', { installed: true })).toBe('/app/')
    expect(forward('#pools', { ios: true })).toBe('/app/#pools')
  })
})
