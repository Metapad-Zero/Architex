import { test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { resolve } from 'node:path'
import { rehearse } from '../rehearsal'

test.skipIf(process.env.EQUILIBRIUM_ROBINHOOD_KEEPER !== '1')('bounded Robinhood keeper, authenticated refill, finalized supply and real process crashes', async () => {
  const { mkdirSync } = await import('node:fs')
  const base = resolve('.equilibrium/49th-40/tests'); mkdirSync(base, { recursive: true })
  await rehearse(mkdtempSync(`${base}/run-`))
}, 300_000)
