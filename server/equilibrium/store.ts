import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Hex } from 'viem'
import { LaunchError, type Job, type JobStorage, type Settlement } from './types'

/** Paths a serverless or sandbox host discards between invocations. Never a production job store. */
const EPHEMERAL = [/^\/tmp(\/|$)/, /^\/var\/tmp(\/|$)/, /^\/var\/task(\/|$)/, /^\/var\/folders(\/|$)/, /^\/dev\/shm(\/|$)/]
/** Environment markers of a host whose local filesystem does not survive the next request. */
const SERVERLESS = ['AWS_LAMBDA_FUNCTION_NAME', 'LAMBDA_TASK_ROOT', 'VERCEL', 'FUNCTIONS_WORKER_RUNTIME', 'K_SERVICE']

/**
 * Refuse a job store that cannot outlive the request that wrote it. A prepared-but-unobserved
 * effect in a discarded store is an unrecoverable charge or duplicate issuance, so this is
 * checked at startup rather than discovered during a restart.
 */
export function assertDurableStore(path: string, env: Record<string, string | undefined> = process.env): string {
  const marker = SERVERLESS.find((name) => env[name])
  if (marker) throw new LaunchError(503, 'ephemeral_host', `${marker} indicates a serverless host with no durable filesystem. Run the launch service on a durable host or a transactional shared database.`)
  if (path === ':memory:') throw new LaunchError(503, 'ephemeral_store', 'An in-memory store loses prepared effects on exit. Configure a durable file or shared database.')
  const absolute = resolve(path)
  if (EPHEMERAL.some((pattern) => pattern.test(absolute))) throw new LaunchError(503, 'ephemeral_store', `${absolute} is a temporary path the host may discard. Configure EQUILIBRIUM_DB on durable storage.`)
  return absolute
}

/** Single durable host only. Never use a serverless /tmp file as a production job store. */
export class JobStore implements JobStorage {
  readonly db: Database
  readonly leaseMs: number
  constructor(path: string, options: { leaseMs?: number } = {}) {
    this.leaseMs = options.leaseMs ?? 30_000
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS jobs (identity TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, lease TEXT, until_ms INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS local_effects (operation TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_supply (job TEXT PRIMARY KEY, issuance TEXT NOT NULL, custody TEXT NOT NULL, remote TEXT NOT NULL, pending TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_pool_inventory (operation TEXT PRIMARY KEY, tokens TEXT NOT NULL, quote TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settled_authorizations (chain_id INTEGER NOT NULL, asset TEXT NOT NULL, nonce TEXT NOT NULL, job TEXT NOT NULL, settlement TEXT, PRIMARY KEY (chain_id, asset, nonce));
      CREATE UNIQUE INDEX IF NOT EXISTS settled_authorizations_job ON settled_authorizations (job);`)
    this.migrate()
  }
  /** Additive, idempotent column migration so an existing store opens without losing jobs. */
  private migrate() {
    const columns = new Set(this.db.query<{ name: string }, []>('PRAGMA table_info(jobs)').all().map((c) => c.name))
    if (!columns.has('state')) this.db.exec(`ALTER TABLE jobs ADD COLUMN state TEXT NOT NULL DEFAULT 'awaiting_payment'`)
    if (!columns.has('payable')) this.db.exec('ALTER TABLE jobs ADD COLUMN payable INTEGER NOT NULL DEFAULT 0')
    if (!columns.has('state') || !columns.has('payable')) {
      for (const row of this.db.query<{ id: string; data: string }, []>('SELECT id,data FROM jobs').all()) {
        const job = JSON.parse(row.data) as Job
        this.db.query('UPDATE jobs SET state=?, payable=? WHERE id=?').run(job.state, job.payment ? 1 : 0, row.id)
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_resumable ON jobs (state, payable, until_ms)')
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
      this.db.query('INSERT INTO jobs(identity,id,data,revision,state,payable) VALUES(?,?,?,?,?,?)').run(job.identity, job.id, JSON.stringify(job), job.revision, job.state, job.payment ? 1 : 0)
      return job
    }).immediate()
  }
  claim(id: Hex, owner: string, now: number, duration = this.leaseMs): Job {
    const result = this.db.query('UPDATE jobs SET lease=?, until_ms=? WHERE id=? AND (lease IS NULL OR until_ms<=?)').run(owner, now + duration, id, now)
    if (!result.changes) throw new LaunchError(409, 'job_busy', 'A worker owns this job. Read its status and retry later.')
    return this.get(id)!
  }
  /**
   * Extend an owned lease without writing job data. A worker calls this while an adapter is
   * still submitting, so a slow chain or provider call cannot orphan the effect it produced.
   */
  renew(id: Hex, owner: string, now: number, duration = this.leaseMs): void {
    const result = this.db.query('UPDATE jobs SET until_ms=? WHERE id=? AND lease=? AND until_ms>?').run(now + duration, id, owner, now)
    if (!result.changes) throw new LaunchError(409, 'stale_worker', 'Worker lost its lease. Do not submit further effects; reconcile with a new worker.')
  }
  save(job: Job, owner: string, now: number): void {
    const next = { ...job, revision: job.revision + 1 }
    const result = this.db.query('UPDATE jobs SET data=?, revision=?, until_ms=?, state=?, payable=? WHERE id=? AND revision=? AND lease=? AND until_ms>?')
      .run(JSON.stringify(next), next.revision, now + this.leaseMs, next.state, next.payment ? 1 : 0, job.id, job.revision, owner, now)
    if (!result.changes) throw new LaunchError(409, 'stale_worker', 'Worker lost its lease or revision. Reconcile with a new worker.')
    job.revision = next.revision
  }
  release(id: string, owner: string) { this.db.query('UPDATE jobs SET lease=NULL, until_ms=0 WHERE id=? AND lease=?').run(id, owner) }
  list(limit = 20): Job[] { return this.db.query<{ data: string }, [number]>('SELECT data FROM jobs ORDER BY rowid DESC LIMIT ?').all(limit).map((r) => JSON.parse(r.data) as Job) }
  /**
   * Jobs a restart must finish: an authorization is already held, the launch is not complete and
   * no live worker owns them. An unpaid quote is excluded — it has no effect to reconcile.
   */
  resumable(now: number, limit = 20): Job[] {
    return this.db.query<{ data: string }, [number, number]>(`SELECT data FROM jobs WHERE state!='complete' AND payable=1 AND until_ms<=? ORDER BY rowid LIMIT ?`)
      .all(now, limit).map((r) => JSON.parse(r.data) as Job)
  }
  /**
   * Bind the EIP-3009 authorization to this job before any settlement is submitted. A second job
   * reaching the same (chainId, asset, nonce) is refused, so one authorization can settle once
   * even if a job row were restored from a backup or duplicated by a faulty deployment.
   */
  reserveAuthorization(job: Job): void {
    const nonce = job.payment?.authorization.nonce
    if (!nonce) throw new LaunchError(402, 'payment_required', 'No authorization to reserve.')
    this.db.transaction(() => {
      const existing = this.db.query<{ job: string }, [number, string, string]>('SELECT job FROM settled_authorizations WHERE chain_id=? AND asset=? AND nonce=?').get(job.terms.chainId, job.terms.asset.toLowerCase(), nonce)
      if (existing) {
        if (existing.job !== job.id) throw new LaunchError(409, 'authorization_reused', 'This payment authorization is already reserved by a different job. It may settle at most once.')
        return
      }
      const owned = this.db.query<{ nonce: string }, [string]>('SELECT nonce FROM settled_authorizations WHERE job=?').get(job.id)
      if (owned && owned.nonce !== nonce) throw new LaunchError(409, 'authorization_conflict', 'This job already reserved a different authorization nonce.')
      this.db.query('INSERT INTO settled_authorizations(chain_id,asset,nonce,job) VALUES(?,?,?,?)').run(job.terms.chainId, job.terms.asset.toLowerCase(), nonce, job.id)
    }).immediate()
  }
  /** Record finalized settlement against the reservation. A differing second record is refused. */
  recordSettlement(settlement: Settlement, jobId: Hex): Settlement {
    return this.db.transaction(() => {
      const row = this.db.query<{ job: string; settlement: string | null }, [number, string, string]>('SELECT job,settlement FROM settled_authorizations WHERE chain_id=? AND asset=? AND nonce=?')
        .get(settlement.chainId, settlement.asset.toLowerCase(), settlement.nonce)
      if (!row) throw new LaunchError(409, 'authorization_unreserved', 'Settlement was recorded without a reservation. Reconcile before charging.')
      if (row.job !== jobId) throw new LaunchError(409, 'authorization_reused', 'This authorization belongs to a different job.')
      if (row.settlement) {
        const prior = JSON.parse(row.settlement) as Settlement
        if (prior.transaction !== settlement.transaction || prior.amount !== settlement.amount) throw new LaunchError(409, 'settlement_conflict', 'A different settlement is already recorded for this authorization.')
        return prior
      }
      this.db.query('UPDATE settled_authorizations SET settlement=? WHERE chain_id=? AND asset=? AND nonce=?').run(JSON.stringify(settlement), settlement.chainId, settlement.asset.toLowerCase(), settlement.nonce)
      return settlement
    }).immediate()
  }
  settlementOf(jobId: Hex): Settlement | undefined {
    const row = this.db.query<{ settlement: string | null }, [string]>('SELECT settlement FROM settled_authorizations WHERE job=?').get(jobId)
    return row?.settlement ? JSON.parse(row.settlement) as Settlement : undefined
  }
  close() { this.db.close() }
}
