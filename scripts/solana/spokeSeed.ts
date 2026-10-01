/**
 * Dumping a spoke ledger and rebuilding it, so the clock fixture can be applied at a genesis.
 *
 * Agave's clock can only start somewhere other than now; it cannot be moved once a ledger is
 * running, because the stake-weighted vote estimate is clamped to 150% of elapsed PoH and a
 * reopened ledger carries its own `epoch_start_timestamp` into that clamp. So a 24-hour advance
 * means a new genesis, and a new genesis is only useful if the state the queue is in comes with it.
 *
 * What comes with it is every account the pinned programs wrote, read back as bytes and reloaded by
 * `--account-dir`. Nothing is interpreted and nothing is edited on the way through — that is the
 * whole point. The queued claim's release boundary on the rebuilt ledger is the boundary the
 * manager itself wrote on the ledger that queued it, and `seedDifferences` is what proves it.
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Connection, PublicKey } from '@solana/web3.js'
import { seedAccountJson, type SeedAccount } from '../../src/lib/equilibriumArcSolana'

/**
 * Every account belonging to `programs`, plus `extra` named addresses.
 *
 * `extra` is not a convenience: the Wormhole fee collector is a core-bridge PDA owned by the system
 * program, so scanning by owner misses it, and a core bridge that cannot take its fee cannot post
 * the message the return leg is made of.
 *
 * Executable accounts are excluded. The programs come back from `--upgradeable-program` with the
 * same ids and the same upgrade authority; reloading their bytes as data accounts would collide
 * with that and leave the manager unable to check its own deployer.
 */
export async function dumpSpokeLedger(
  connection: Connection, programs: PublicKey[], extra: PublicKey[],
): Promise<SeedAccount[]> {
  const found = new Map<string, SeedAccount>()
  const keep = (pubkey: PublicKey, account: { lamports: number; owner: PublicKey; data: Buffer; executable: boolean }): void => {
    if (account.executable) return
    found.set(pubkey.toBase58(), {
      pubkey: pubkey.toBase58(),
      lamports: account.lamports,
      owner: account.owner.toBase58(),
      data: Uint8Array.from(account.data),
    })
  }
  for (const program of programs) {
    for (const { pubkey, account } of await connection.getProgramAccounts(program, 'finalized')) {
      keep(pubkey, account)
    }
  }
  for (const pubkey of extra) {
    const account = await connection.getAccountInfo(pubkey, 'finalized')
    if (account) keep(pubkey, account)
  }
  return [...found.values()].sort((left, right) => left.pubkey.localeCompare(right.pubkey))
}

/** Reads the same accounts back off a rebuilt ledger, for comparison against the dump. */
export async function readSeeded(connection: Connection, dumped: SeedAccount[]): Promise<SeedAccount[]> {
  const read: SeedAccount[] = []
  for (const source of dumped) {
    const pubkey = new PublicKey(source.pubkey)
    const account = await connection.getAccountInfo(pubkey, 'confirmed')
    if (!account) continue
    read.push({
      pubkey: source.pubkey,
      lamports: account.lamports,
      owner: account.owner.toBase58(),
      data: Uint8Array.from(account.data),
    })
  }
  return read
}

/** One file per account, named by address, in a directory `--account-dir` is pointed at. */
export function writeSeedDirectory(directory: string, accounts: SeedAccount[]): void {
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  for (const account of accounts) {
    writeFileSync(join(directory, `${account.pubkey}.json`), seedAccountJson(account))
  }
}

/** A line for the record: how many accounts came across, grouped by the program that owns them. */
export function describeSeed(accounts: SeedAccount[], names: Map<string, string>): string {
  const counts = new Map<string, number>()
  for (const account of accounts) {
    const owner = names.get(account.owner) ?? account.owner
    counts.set(owner, (counts.get(owner) ?? 0) + 1)
  }
  return [...counts.entries()].map(([owner, count]) => `${count} ${owner}`).join(', ')
}
