import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../store'
import { localAdapter } from '../localAdapter'
import { quote, runJob } from '../runner'
import { fixture, sign } from './fixtures'
import type { Job } from '../types'

/**
 * Separate processes opening one launch journal at the same moment: a service, its reconciler and
 * fork workers all do this at startup. Each opener waits on a barrier file so they really collide.
 */
const now = 1_800_000_000
const OPENERS = 8
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function journal() { const dir = mkdtempSync(join(tmpdir(), 'equilibrium-startup-')); dirs.push(dir); return { dir, path: join(dir, 'jobs.sqlite') } }

interface Opened { exit: number; signal: string | null; ok: boolean; error?: string }
async function open(dir: string, path: string, count: number, mode?: string): Promise<Opened[]> {
  const barrier = join(dir, `go-${Math.random().toString(36).slice(2)}`)
  const children = Array.from({ length: count }, () => Bun.spawn([process.execPath, 'run', join(import.meta.dir, 'opener.ts'), path, barrier, ...(mode ? [mode] : [])], { stdout: 'pipe', stderr: 'pipe' }))
  await Bun.sleep(300)
  writeFileSync(barrier, '')
  return Promise.all(children.map(async (child) => {
    const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    const line = stdout.trim()
    return { exit, signal: child.signalCode ?? null, ...(line ? JSON.parse(line) as { ok: boolean; error?: string } : { ok: false }) }
  }))
}
const columns = (db: Database, table: string) => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name)
const rows = (db: Database, table: string) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()

/** A store written before the state/payable/sweep and attribution columns, holding one paid, running job. */
async function legacy(path: string, extra: (db: Database) => void = () => {}) {
  const source = new JobStore(':memory:'); const adapter = localAdapter(source)
  const job = quote(source, adapter, fixture(now), now)
  const paid: Job = { ...job, payment: await sign(job), state: 'running' }
  source.close()
  const db = new Database(path, { create: true, strict: true })
  db.exec(`CREATE TABLE jobs (identity TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, lease TEXT, until_ms INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE settled_authorizations (chain_id INTEGER NOT NULL, asset TEXT NOT NULL, nonce TEXT NOT NULL, job TEXT NOT NULL, settlement TEXT, PRIMARY KEY (chain_id, asset, nonce));
    CREATE TABLE robinhood_launches (asset TEXT PRIMARY KEY, identity TEXT NOT NULL, job TEXT NOT NULL, payer TEXT NOT NULL, valid_before INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE multispoke_launches (job TEXT PRIMARY KEY, identity TEXT NOT NULL, payer TEXT NOT NULL, valid_before INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
      released_reason TEXT, released_block TEXT, created_at INTEGER NOT NULL);`)
  db.query('INSERT INTO jobs(identity,id,data,revision) VALUES(?,?,?,?)').run(paid.identity, paid.id, JSON.stringify(paid), 0)
  db.query('INSERT INTO settled_authorizations(chain_id,asset,nonce,job) VALUES(?,?,?,?)').run(paid.terms.chainId, paid.terms.asset.toLowerCase(), paid.payment!.authorization.nonce, paid.id)
  db.query('INSERT INTO robinhood_launches(asset,identity,job,payer,valid_before,settled,created_at) VALUES(?,?,?,?,?,?,?)').run('unit-asset', paid.identity, paid.id, paid.request.payer, now + 600, 0, now)
  db.query('INSERT INTO multispoke_launches(job,identity,payer,valid_before,settled,created_at) VALUES(?,?,?,?,?,?)').run(paid.id, paid.identity, paid.request.payer, now + 600, 0, now)
  extra(db)
  db.close()
  return paid
}
const durable = (db: Database) => ({ jobs: db.query('SELECT identity,id,data,revision,lease,until_ms FROM jobs ORDER BY rowid').all(), authorizations: rows(db, 'settled_authorizations'),
  robinhood: db.query('SELECT asset,identity,job,payer,valid_before,settled,created_at FROM robinhood_launches').all(),
  multispoke: db.query('SELECT job,identity,payer,valid_before,settled,released_reason,released_block,created_at FROM multispoke_launches').all() })

describe('concurrent startup of one launch journal', () => {
  test('separate processes creating a new journal together all open it, with one complete schema', async () => {
    for (let round = 0; round < 3; round++) {
      const { dir, path } = journal()
      const opened = await open(dir, path, OPENERS)
      expect(opened.filter((o) => !o.ok)).toEqual([])
      const db = new Database(path, { readonly: true })
      expect(db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()!.journal_mode).toBe('wal')
      for (const column of ['state', 'payable', 'sweep']) expect(columns(db, 'jobs')).toContain(column)
      expect(columns(db, 'robinhood_launches')).toContain('value')
      expect(columns(db, 'multispoke_launches')).toContain('value')
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='jobs_resumable'").get()!.n).toBe(1)
      db.close()
    }
  }, 60_000)

  test('separate processes migrating an existing journal together keep its payment, claims and job resumable', async () => {
    const { dir, path } = journal()
    const paid = await legacy(path)
    const before = (() => { const db = new Database(path, { readonly: true }); const d = durable(db); db.close(); return d })()
    const opened = await open(dir, path, OPENERS)
    expect(opened.filter((o) => !o.ok)).toEqual([])
    const store = new JobStore(path)
    expect(durable(store.db)).toEqual(before)
    expect(store.db.query('SELECT state,payable,sweep FROM jobs').get()).toEqual({ state: 'running', payable: 1, sweep: 1 })
    expect(store.resumable(now * 1000).map((j) => j.id)).toEqual([paid.id])
    const finished = await runJob(store, localAdapter(store), paid.id, undefined, () => now * 1000)
    expect(finished.state).toBe('complete')
    store.close()
  }, 60_000)

  test('a worker killed part-way through migration commits nothing, and the next openers finish it', async () => {
    const { dir, path } = journal()
    const paid = await legacy(path)
    const [crashed] = await open(dir, path, 1, 'crash-before-backfill')
    expect(crashed.signal).toBe('SIGKILL')
    // The columns were added inside the killed transaction. Committed alone, their defaults would
    // mark this paid job unpaid and the backfill would never run again, so it could not resume.
    const after = new Database(path, { readonly: true })
    expect(columns(after, 'jobs')).not.toContain('state')
    after.close()
    const reopened = await open(dir, path, OPENERS)
    expect(reopened.filter((o) => !o.ok)).toEqual([])
    const store = new JobStore(path)
    expect(store.resumable(now * 1000).map((j) => j.id)).toEqual([paid.id])
    expect((await runJob(store, localAdapter(store), paid.id, undefined, () => now * 1000)).state).toBe('complete')
    store.close()
  }, 60_000)

  test('a failed initializer leaves the existing journal exactly as it was', async () => {
    const { path } = journal()
    await legacy(path, (db) => db.query('INSERT INTO jobs(identity,id,data,revision) VALUES(?,?,?,?)').run('corrupt', '0xcorrupt', '{not json', 0))
    const snapshot = () => { const db = new Database(path, { readonly: true }); const s = { schema: db.query('SELECT name,sql FROM sqlite_master ORDER BY name').all(), all: rows(db, 'jobs'), ...durable(db) }; db.close(); return s }
    const before = snapshot()
    expect(() => new JobStore(path)).toThrow()
    expect(snapshot()).toEqual(before)
  })
})
