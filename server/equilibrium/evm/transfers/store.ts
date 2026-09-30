import type { Database } from 'bun:sqlite'
import type { Hex } from 'viem'
import { LaunchError } from '../../types'
import type { Transfer } from './types'

/**
 * Durable transfer records in the launch store's database, with the same fencing rules: one lease
 * owner at a time, and every write checks both the lease and the revision it read. A stale worker
 * cannot overwrite newer progress; on-chain executor idempotency covers what it may already have sent.
 */
export class TransferStore {
  constructor(readonly db: Database, readonly leaseMs = 30_000) {
    db.exec(`CREATE TABLE IF NOT EXISTS evm_transfers (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      data TEXT NOT NULL, revision INTEGER NOT NULL, lease TEXT, until_ms INTEGER NOT NULL DEFAULT 0);`)
  }
  get(id: string): Transfer | undefined {
    const row = this.db.query<{ data: string }, [string]>('SELECT data FROM evm_transfers WHERE id=?').get(id)
    return row ? JSON.parse(row.data) as Transfer : undefined
  }
  byIdentity(identity: Hex): Transfer | undefined {
    const row = this.db.query<{ data: string }, [string]>('SELECT data FROM evm_transfers WHERE identity=?').get(identity)
    return row ? JSON.parse(row.data) as Transfer : undefined
  }
  /** Insert once. A second insert of the same identity returns the stored record, or refuses different content. */
  insert(transfer: Transfer): Transfer {
    this.db.query('INSERT OR IGNORE INTO evm_transfers(id, identity, kind, state, data, revision) VALUES(?,?,?,?,?,0)')
      .run(transfer.id, transfer.identity, transfer.kind, transfer.state, JSON.stringify(transfer))
    const stored = this.byIdentity(transfer.identity)!
    if (stored.id !== transfer.id) throw new LaunchError(409, 'identity_conflict', 'This transfer identity is already bound to a different request. Read the existing transfer.')
    return stored
  }
  claim(id: Hex, owner: string, now: number, duration = this.leaseMs): Transfer {
    const changed = this.db.query('UPDATE evm_transfers SET lease=?, until_ms=? WHERE id=? AND (lease IS NULL OR until_ms < ?)').run(owner, now + duration, id, now).changes
    if (!changed) {
      if (!this.get(id)) throw new LaunchError(404, 'not_found', 'Unknown transfer.')
      throw new LaunchError(409, 'leased', 'Another worker holds this transfer.')
    }
    return this.get(id)!
  }
  /** Persist progress. Refuses when the lease was lost or another write landed first. */
  save(transfer: Transfer, owner: string, now: number, duration = this.leaseMs) {
    const changed = this.db.query('UPDATE evm_transfers SET data=?, state=?, revision=revision+1, until_ms=? WHERE id=? AND lease=? AND revision=? AND until_ms >= ?')
      .run(JSON.stringify({ ...transfer, revision: transfer.revision + 1 }), transfer.state, now + duration, transfer.id, owner, transfer.revision, now).changes
    if (!changed) throw new LaunchError(409, 'stale_worker', 'The transfer lease or revision changed; this worker stops without writing.')
    transfer.revision += 1
  }
  release(id: string, owner: string) { this.db.query('UPDATE evm_transfers SET lease=NULL, until_ms=0 WHERE id=? AND lease=?').run(id, owner) }
  list(limit = 100): Transfer[] {
    return this.db.query<{ data: string }, [number]>('SELECT data FROM evm_transfers ORDER BY rowid DESC LIMIT ?').all(limit).map((r) => JSON.parse(r.data) as Transfer)
  }
  /** Unleased, unfinished transfers: what a restarted sweep resumes without any client request. */
  resumable(now: number, limit = 20): Transfer[] {
    return this.db.query<{ data: string }, [number, number]>("SELECT data FROM evm_transfers WHERE state != 'complete' AND (lease IS NULL OR until_ms < ?) ORDER BY rowid LIMIT ?")
      .all(now, limit).map((r) => JSON.parse(r.data) as Transfer)
  }
}
