import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// No em dashes in anything the site shows. Rewrite the sentence with a comma, a colon, a period or
// parentheses, never a hyphen or an en dash in the dash's place; an empty value slot shows GHOST from
// lib/format. Comments are free to use them. This file writes the dash as \u2014 so it holds none itself.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** Everything in these folders ends up on screen: docs pages, plugin listings, components, and the hooks behind their labels. */
const FOLDERS = ['src/content', 'src/components', 'src/hooks']

/** Everything else whose strings reach the screen: receipts, errors, form checks, chain names, the bulletin, the page head. */
const FILES = [
  'index.html',
  'public/site.webmanifest',
  'server/metadataService.ts',
  'src/App.tsx',
  'src/index.css',
  'src/lib/amountInput.ts',
  'src/lib/cctp.ts',
  'src/lib/docs.ts',
  'src/lib/errors.ts',
  'src/lib/format.ts',
  'src/lib/impactGuard.ts',
  'src/lib/keystore.ts',
  'src/lib/launch.ts',
  'src/lib/localWallet.ts',
  'src/lib/localWalletConnector.ts',
  'src/lib/plugins/destination.ts',
  'src/lib/plugins/plan.ts',
  'src/lib/prepareImage.ts',
  'src/lib/saveDetails.ts',
  'src/lib/signingIntent.ts',
  'src/lib/tokenMetadata.ts',
  'src/lib/tokens.ts',
  'src/lib/unlock.ts',
  'src/lib/updates.ts',
  'src/lib/walletConnect.ts',
]

/** The em dash, and the spellings that render as one: HTML entities in JSX, JavaScript and CSS escapes. */
const EM_DASH = /\u2014|&mdash;|&#0*8212;|&#x0*2014;|\\u\{?0*2014\}?|\\0*2014(?![0-9a-f])/i

type Kind = 'script' | 'html' | 'json'

/** Every character but the newlines turned to spaces, so line numbers survive. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ')
}

/**
 * The source with its comments blanked out: line, block, doc and JSX comments. A small scanner, not a
 * parser. It follows strings, template literals and their `${}` holes; an apostrophe in JSX text reads
 * as a quote that closes at the end of the line, and a `//` straight after a colon as part of a URL.
 * Where it guesses, it guesses towards showing copy, never towards hiding it.
 */
function withoutComments(source: string): string {
  let out = ''
  let i = 0
  // Open template literals and the `${` holes inside them, innermost last; a number is a hole's brace depth.
  const stack: Array<'template' | number> = []
  while (i < source.length) {
    const ch = source[i]
    const top = stack[stack.length - 1]
    if (top === 'template') {
      if (ch === '\\') {
        out += source.slice(i, i + 2)
        i += 2
        continue
      }
      if (ch === '$' && source[i + 1] === '{') {
        stack.push(0)
        out += '${'
        i += 2
        continue
      }
      if (ch === '`') stack.pop()
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '/' && source[i - 1] !== ':') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += blank(source.slice(i, stop))
      i = stop
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '`') stack.push('template')
    else if (typeof top === 'number' && ch === '{') stack[stack.length - 1] = top + 1
    else if (typeof top === 'number' && ch === '}') {
      if (top === 0) stack.pop()
      else stack[stack.length - 1] = top - 1
    }
    out += ch
    i += 1
  }
  return out
}

/** What a visitor can see of a file: HTML loses its comments and the generator tag, code loses its comments. */
function visible(source: string, kind: Kind): string {
  if (kind === 'json') return source
  if (kind === 'html') return source.replace(/<!--[\s\S]*?-->/g, blank).replace(/<meta\s+name="generator"[^>]*>/gi, blank)
  return withoutComments(source)
}

/** 1-based numbers of the lines that would show an em dash. */
function dashLines(source: string, kind: Kind): number[] {
  return visible(source, kind)
    .split('\n')
    .flatMap((line, index) => (EM_DASH.test(line) ? [index + 1] : []))
}

function kindOf(path: string): Kind {
  if (path.endsWith('.html')) return 'html'
  if (path.endsWith('.json') || path.endsWith('.webmanifest')) return 'json'
  return 'script'
}

function scannedFiles(): string[] {
  const inFolders = FOLDERS.flatMap((folder) =>
    readdirSync(join(ROOT, folder), { encoding: 'utf8', recursive: true })
      .map((name) => `${folder}/${name}`)
      .filter((path) => /\.tsx?$/.test(path) && !/__tests__\/|\.test\.tsx?$/.test(path)),
  )
  return [...inFolders, ...FILES].sort()
}

/** Test sources spell the em dash as @; this turns it into the real one. */
function sample(lines: string[]): string {
  return lines.join('\n').replace(/@/g, '\u2014')
}

describe('no em dashes in user-facing copy', () => {
  test('nothing the site shows has an em dash', () => {
    const hits = scannedFiles().flatMap((path) => {
      const source = readFileSync(join(ROOT, path), 'utf8')
      const lines = source.split('\n')
      return dashLines(source, kindOf(path)).map((line) => `${path}:${line}: ${lines[line - 1].trim()}`)
    })
    if (hits.length > 0) {
      throw new Error(
        `Em dashes in user-facing copy. Rewrite each with a comma, colon, period or parentheses (not a hyphen or an en dash); an empty value slot takes GHOST from lib/format.\n${hits.join('\n')}`,
      )
    }
  })

  test('scans every page, component and hook, and every listed module still exists', () => {
    expect(FILES.filter((path) => !existsSync(join(ROOT, path)))).toEqual([])
    const files = scannedFiles()
    expect(files).toContain('src/content/docs/Curve.tsx')
    expect(files).toContain('src/content/plugins/registry.ts')
    expect(files).toContain('src/components/ReceiptLines.tsx')
    expect(files).toContain('src/hooks/useSwap.ts')
  })

  test('skips line, block, doc and JSX comments', () => {
    const source = sample([
      '// a line comment @ here',
      '/* a block comment @ here */',
      '/**',
      ' * a doc comment @ here',
      ' */',
      'const a = 1 // a trailing comment @ here',
      'const b = <p>{/* a JSX comment @ here */}</p>',
    ])
    expect(dashLines(source, 'script')).toEqual([])
  })

  test('finds the dash in strings, templates, JSX text, attributes, entities and escapes, on the right line', () => {
    const source = sample([
      "const a = 'single @ quoted'",
      'const b = "double @ quoted"',
      'const c = `template ${ready ? "yes" : "no"} @ after the hole`',
      "const d = <p>That's it @ an apostrophe in JSX text is no quote</p>",
      '/* a comment @ that',
      '   runs on */ const e = <p title="@" />',
      '<p>See https://architex.fun @ a URL is no comment</p>',
      '<p>Nothing to see</p>',
      '<p>An entity &mdash; renders as one</p>',
      "const f = 'an escape \\u2014 does too'",
    ])
    expect(dashLines(source, 'script')).toEqual([1, 2, 3, 4, 6, 7, 9, 10])
  })

  test('in HTML, only what a visitor sees counts', () => {
    const html = sample([
      '<meta name="generator" content="A tool @ its site" />',
      '<!-- a comment @ here -->',
      '<!--',
      '  a longer comment @ here',
      '-->',
      '<title>Name @ tagline</title>',
    ])
    expect(dashLines(html, 'html')).toEqual([6])
  })
})
