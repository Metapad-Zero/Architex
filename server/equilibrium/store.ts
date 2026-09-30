import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Hex } from 'viem'
import { LaunchError, type Job } from './types'

/** Single durable host only. Never use a serverless /tmp file as a production job store. */
export class JobStore {
  readonly db: Database
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (identity TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, lease TEXT, until_ms INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS local_effects (operation TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_supply (job TEXT PRIMARY KEY, issuance TEXT NOT NULL, custody TEXT NOT NULL, remote TEXT NOT NULL, pending TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_pool_inventory (operation TEXT PRIMARY KEY, tokens TEXT NOT NULL, quote TEXT NOT NULL);`)
  }
  get(id: string): Job | undefined {
    const row = this.db.query<{ data: string }, [string, string]>('SELECT data FROM jobs WHERE id=? OR identity=?').get(id, id)
    return row ? JSON.parse(row.data) as Job : undefined
  }
  insert(job: Job): Job {
    return this.db.transaction(() => {
      const existing = this.get(job.identity)
      if (existing) {
        if (existing.id !== job.id) throw new LaunchError(409, 'identity_conflict', 'This payer/requestId is already bound to a different payload.')
        return existing
      }
      this.db.query('INSERT INTO jobs(identity,id,data,revision) VALUES(?,?,?,?)').run(job.identity, job.id, JSON.stringify(job), job.revision)
      return job
    }).immediate()
  }
  claim(id: Hex, owner: string, now: number, duration = 30_000): Job {
    const result = this.db.query('UPDATE jobs SET lease=?, until_ms=? WHERE id=? AND (lease IS NULL OR until_ms<=?)').run(owner, now + duration, id, now)
    if (!result.changes) throw new LaunchError(409, 'job_busy', 'A worker owns this job. Read its status and retry later.')
    return this.get(id)!
  }
  save(job: Job, owner: string, now: number): void {
    const next = { ...job, revision: job.revision + 1 }
    const result = this.db.query('UPDATE jobs SET data=?, revision=?, until_ms=? WHERE id=? AND revision=? AND lease=? AND until_ms>?').run(JSON.stringify(next), next.revision, now + 30_000, job.id, job.revision, owner, now)
    if (!result.changes) throw new LaunchError(409, 'stale_worker', 'Worker lost its lease or revision. Reconcile with a new worker.')
    job.revision = next.revision
  }
  release(id: string, owner: string) { this.db.query('UPDATE jobs SET lease=NULL, until_ms=0 WHERE id=? AND lease=?').run(id, owner) }
  list(limit = 20): Job[] { return this.db.query<{ data: string }, [number]>('SELECT data FROM jobs ORDER BY rowid DESC LIMIT ?').all(limit).map((r) => JSON.parse(r.data) as Job) }
  close() { this.db.close() }
}
