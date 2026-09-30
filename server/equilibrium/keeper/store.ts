/**
 * The keeper's durable record. A cross-chain cycle is not atomic: the purchase settles on one chain
 * and the sale on another, with a gap in between that a crash, a restart or an RPC outage can land
 * in. The record exists so that gap is always recoverable — every leg is written with its exact
 * plan before anything is sent, and a restart can tell "bought, not yet sold" from "nothing sent".
 *
 * WAL and synchronous=FULL, and the same ephemeral-path refusal the job store uses: a keeper whose
 * record does not survive the process can lose a bought position, which is real money.
 */
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertDurableStore } from '../store'
import { KeeperError, type CycleCandidate, type CycleRecord, type CycleState, type KeeperChain, type LegPlan, type LegRecord, type LegResult, type LegState } from './types'

interface CycleRow { id: string; state: string; candidate: string; created_at: number; updated_at: number; net: string | null; note: string | null }
interface LegRow { cycle: string; kind: string; chain: string; state: string; plan: string; result: string | null; error: string | null }

export class KeeperStore {
  readonly db: Database
  constructor(path: string, options: { allowEphemeral?: boolean } = {}) {
    const resolved = options.allowEphemeral ? path : assertDurableStore(path)
    if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 })
    this.db = new Database(resolved, { create: true, strict: true })
    if (resolved !== ':memory:') chmodSync(resolved, 0o600)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS keeper_cycles (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, candidate TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, net TEXT, note TEXT);
      CREATE TABLE IF NOT EXISTS keeper_legs (
        cycle TEXT NOT NULL, kind TEXT NOT NULL, chain TEXT NOT NULL, state TEXT NOT NULL,
        plan TEXT NOT NULL, result TEXT, error TEXT,
        PRIMARY KEY (cycle, kind), FOREIGN KEY (cycle) REFERENCES keeper_cycles(id));
      CREATE TABLE IF NOT EXISTS keeper_sends (leg TEXT NOT NULL, chain TEXT NOT NULL, tx TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY (leg, tx));
      CREATE TABLE IF NOT EXISTS keeper_snapshots (at INTEGER NOT NULL, cycle TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS keeper_cycles_state ON keeper_cycles (state);`)
  }

  private legs(cycle: string): LegRecord[] {
    return this.db.query<LegRow, [string]>('SELECT * FROM keeper_legs WHERE cycle=? ORDER BY rowid').all(cycle).map((row) => ({
      cycle: row.cycle, kind: row.kind as LegRecord['kind'], chain: row.chain as KeeperChain, state: row.state as LegState,
      plan: JSON.parse(row.plan) as LegPlan, result: row.result ? JSON.parse(row.result) as LegResult : null, error: row.error,
    }))
  }
  private hydrate(row: CycleRow): CycleRecord {
    return {
      id: row.id, state: row.state as CycleState, candidate: JSON.parse(row.candidate) as CycleCandidate,
      createdAt: row.created_at, updatedAt: row.updated_at, legs: this.legs(row.id), net: row.net, note: row.note,
    }
  }

  get(id: string): CycleRecord | undefined {
    const row = this.db.query<CycleRow, [string]>('SELECT * FROM keeper_cycles WHERE id=?').get(id)
    return row ? this.hydrate(row) : undefined
  }
  list(limit = 50): CycleRecord[] {
    return this.db.query<CycleRow, [number]>('SELECT * FROM keeper_cycles ORDER BY rowid DESC LIMIT ?').all(limit).map((row) => this.hydrate(row))
  }

  /** Open a cycle. Refuses a second open cycle, whichever process asks: recovery comes first. */
  open(id: string, candidate: CycleCandidate, now: number, maxOpen: number): CycleRecord {
    return this.db.transaction(() => {
      const existing = this.get(id)
      if (existing) {
        if (JSON.stringify(existing.candidate) !== JSON.stringify(candidate)) throw new KeeperError('leg_failed', `Cycle ${id} already exists with a different plan.`)
        return existing
      }
      const open = this.db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM keeper_cycles WHERE state IN ('open','halted')`).get()!.count
      if (open >= maxOpen) throw new KeeperError('unresolved_exposure', `${open} cycle(s) are already open or halted; the limit is ${maxOpen}. Resolve them before opening another.`)
      this.db.query('INSERT INTO keeper_cycles(id,state,candidate,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, 'open', JSON.stringify(candidate), now, now)
      return this.get(id)!
    }).immediate()
  }

  /** Persist a leg's exact plan before anything is sent. Re-planning the same leg is refused. */
  planLeg(plan: LegPlan): LegRecord {
    return this.db.transaction(() => {
      const existing = this.db.query<LegRow, [string, string]>('SELECT * FROM keeper_legs WHERE cycle=? AND kind=?').get(plan.cycle, plan.kind)
      if (existing) {
        const prior = JSON.parse(existing.plan) as LegPlan
        if (prior.id !== plan.id || prior.digest !== plan.digest) {
          throw new KeeperError('leg_failed', `Cycle ${plan.cycle} already planned a ${plan.kind} leg as ${prior.id}. A leg is planned once; observe it before replanning.`)
        }
        return this.legs(plan.cycle).find((leg) => leg.kind === plan.kind)!
      }
      this.db.query('INSERT INTO keeper_legs(cycle,kind,chain,state,plan) VALUES(?,?,?,?,?)').run(plan.cycle, plan.kind, plan.chain, 'planned', JSON.stringify(plan))
      const created: LegRecord = { cycle: plan.cycle, kind: plan.kind, chain: plan.chain, state: 'planned', plan, result: null, error: null }
      return created
    }).immediate()
  }

  recordSend(leg: LegPlan, tx: string, now: number): void {
    this.db.query('INSERT OR IGNORE INTO keeper_sends(leg,chain,tx,sent_at) VALUES(?,?,?,?)').run(leg.id, leg.chain, tx, now)
    this.db.query(`UPDATE keeper_legs SET state='sent' WHERE cycle=? AND kind=? AND state='planned'`).run(leg.cycle, leg.kind)
  }
  sendsFor(legId: string): string[] {
    return this.db.query<{ tx: string }, [string]>('SELECT tx FROM keeper_sends WHERE leg=?').all(legId).map((row) => row.tx)
  }

  settleLeg(plan: LegPlan, result: LegResult, now: number): void {
    this.db.transaction(() => {
      const row = this.db.query<LegRow, [string, string]>('SELECT * FROM keeper_legs WHERE cycle=? AND kind=?').get(plan.cycle, plan.kind)
      if (!row) throw new KeeperError('leg_failed', `No planned ${plan.kind} leg for cycle ${plan.cycle}.`)
      if (row.state === 'settled') {
        const prior = JSON.parse(row.result!) as LegResult
        if (prior.transaction !== result.transaction) throw new KeeperError('leg_failed', `Cycle ${plan.cycle} ${plan.kind} already settled in ${prior.transaction}.`)
        return
      }
      this.db.query(`UPDATE keeper_legs SET state='settled', result=?, error=NULL WHERE cycle=? AND kind=?`).run(JSON.stringify(result), plan.cycle, plan.kind)
      this.db.query('UPDATE keeper_cycles SET updated_at=? WHERE id=?').run(now, plan.cycle)
    }).immediate()
  }

  failLeg(plan: LegPlan, error: string, now: number): void {
    this.db.transaction(() => {
      this.db.query(`UPDATE keeper_legs SET state='failed', error=? WHERE cycle=? AND kind=? AND state!='settled'`).run(error, plan.cycle, plan.kind)
      this.db.query('UPDATE keeper_cycles SET updated_at=? WHERE id=?').run(now, plan.cycle)
    }).immediate()
  }

  setCycle(id: string, state: CycleState, now: number, fields: { net?: string; note?: string } = {}): void {
    const result = this.db.query('UPDATE keeper_cycles SET state=?, updated_at=?, net=COALESCE(?,net), note=COALESCE(?,note) WHERE id=?')
      .run(state, now, fields.net ?? null, fields.note ?? null, id)
    if (!result.changes) throw new KeeperError('leg_failed', `Unknown cycle ${id}.`)
  }

  /**
   * Cycles a restart must resolve: a settled purchase and no settled sale or recovery. This is the
   * exposure the keeper is not allowed to trade over.
   */
  unresolved(): CycleRecord[] {
    return this.db.query<CycleRow, []>(`SELECT * FROM keeper_cycles WHERE state IN ('open','halted') ORDER BY rowid`).all()
      .map((row) => this.hydrate(row))
      .filter((cycle) => cycle.legs.some((leg) => leg.kind === 'buy' && leg.state === 'settled')
        && !cycle.legs.some((leg) => (leg.kind === 'sell' || leg.kind === 'recover') && leg.state === 'settled'))
  }
  /** Cycles with nothing settled at all: safe to abandon, because no money moved. */
  untouched(): CycleRecord[] {
    return this.db.query<CycleRow, []>(`SELECT * FROM keeper_cycles WHERE state='open' ORDER BY rowid`).all()
      .map((row) => this.hydrate(row))
      .filter((cycle) => cycle.legs.every((leg) => leg.state !== 'settled'))
  }

  /** Realized loss and net across cycles the record considers finished. */
  totals(): { loss: string; net: string; closed: number } {
    const rows = this.db.query<{ net: string | null; state: string }, []>(`SELECT net,state FROM keeper_cycles WHERE state IN ('closed','recovered')`).all()
    let loss = 0n
    let net = 0n
    for (const row of rows) {
      const value = BigInt(row.net ?? '0')
      net += value
      if (value < 0n) loss += -value
    }
    return { loss: loss.toString(), net: net.toString(), closed: rows.length }
  }

  /** Every snapshot the keeper decided on, so a refusal can be re-derived from recorded numbers. */
  recordSnapshot(at: number, cycle: string | null, body: unknown): void {
    this.db.query('INSERT INTO keeper_snapshots(at,cycle,body) VALUES(?,?,?)').run(at, cycle, JSON.stringify(body))
  }
  snapshots(limit = 50): { at: number; cycle: string | null; body: unknown }[] {
    return this.db.query<{ at: number; cycle: string | null; body: string }, [number]>('SELECT at,cycle,body FROM keeper_snapshots ORDER BY rowid DESC LIMIT ?')
      .all(limit).map((row) => ({ at: row.at, cycle: row.cycle, body: JSON.parse(row.body) as unknown }))
  }

  close() { this.db.close() }
}
