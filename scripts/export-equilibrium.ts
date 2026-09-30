/** Package the tested React view as one offline HTML artifact, with no wallet or RPC dependencies. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const output = resolve('output/equilibrium')
mkdirSync(output, { recursive: true })
const entry = resolve(output, 'demo.tsx')
const view = resolve('src/components/EquilibriumView.tsx')
writeFileSync(entry, `import { createRoot } from 'react-dom/client'\nimport { EquilibriumView } from ${JSON.stringify(view)}\ncreateRoot(document.getElementById('root')!).render(<EquilibriumView />)\n`)
const result = spawnSync(process.execPath, ['build', entry, '--target', 'browser', '--minify', '--outdir', output], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`Standalone demo build failed (${result.status ?? 'unknown'}).`)
const checklist = `data:text/markdown;base64,${readFileSync('public/equilibrium-readiness.md').toString('base64')}`
const js = readFileSync(resolve(output, 'demo.js'), 'utf8').split('/equilibrium-readiness.md').join(checklist).replace(/<\/script/gi, '<\\/script')
const css = readFileSync(resolve(output, 'demo.css'), 'utf8')
const tokens = readFileSync('src/index.css', 'utf8').split('@layer components')[0].replace(/@(?:import|tailwind)[^;]+;/g, '')
const font = readFileSync('node_modules/@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2').toString('base64')
const icon = readFileSync('public/icon.svg').toString('base64')
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="data:image/svg+xml;base64,${icon}"><title>Architex EQUILIBRIUM — local simulation</title>
<style>@font-face{font-family:'Public Sans Variable';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format('woff2');font-display:swap}
${tokens}
h1,h2,h3,p,ol,ul,dl{margin:0}button,select,input{font:inherit}button{cursor:pointer}button:disabled{cursor:default;color:var(--g500);background:var(--g100)}
.ghost-button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 12px;border:1px solid var(--ink);border-radius:var(--radius);background:var(--paper);color:var(--ink);font-size:.875rem;font-weight:600}
.ghost-button:hover:not(:disabled){background:var(--g100)}
.offline-brand{max-width:1064px;margin:0 auto;padding:16px 24px;border-bottom:1px solid var(--ink);font-size:1.125rem;font-weight:600}
${css}</style></head><body><header class="offline-brand">Architex</header><main id="root"></main><script type="module">${js}</script></body></html>`
const artifact = resolve(output, 'equilibrium-demo.html')
writeFileSync(artifact, html)
console.log(`Standalone simulation: ${artifact} (${Buffer.byteLength(html).toLocaleString('en-US')} bytes)`)
