import type { Database } from 'bun:sqlite'
import { createPublicClient, createWalletClient, http, keccak256, type Address, type Hex, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hash } from '../../request'
import { keeperChain, legFees, legCost, assertInputs, toQuoteAtoms } from './quotes'
import { KeeperError, type KeeperChain, type KeeperConfig } from './types'

interface Row { id: string; side: KeeperChain; binding: string; raw: Hex; tx: Hex; worst: string; actual: string | null; receipt: string | null }
export interface SendOptions { checkpoint?: (point: string, id: string) => void }

/** Fork-only, one signed transaction per operation. The private WAL is the recovery authority. */
export function boundedSender(config: KeeperConfig, db: Database, options: SendOptions = {}) {
  config = structuredClone(config)
  if (config.mode !== 'fork') throw new KeeperError('not_approved', 'Public Robinhood sends are closed.')
  for (const side of ['arc', 'robinhood'] as const) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(config[side].rpc)) throw new KeeperError('not_approved', 'Only loopback fork RPCs are allowed.')
  }
  if (!/^[1-9]\d*$/.test(config.policy.operatingCap)) throw new KeeperError('invalid_configuration', 'An explicit operating cost cap is required.')
  const account = privateKeyToAccount(config.operatorKey)
  const clients = Object.fromEntries(['arc', 'robinhood'].map((side) => [side, createPublicClient({ chain: keeperChain(config[side as KeeperChain]), transport: http(config[side as KeeperChain].rpc) })]))
  db.exec('CREATE TABLE IF NOT EXISTS rh_sends(id TEXT PRIMARY KEY, side TEXT NOT NULL, binding TEXT NOT NULL, raw TEXT NOT NULL, tx TEXT NOT NULL, worst TEXT NOT NULL, actual TEXT, receipt TEXT);')
  const rowOf = (id: string) => db.query<Row, [string]>('SELECT * FROM rh_sends WHERE id=?').get(id)
  const rows = () => db.query<Row, []>('SELECT * FROM rh_sends ORDER BY rowid').all()
  const totals = () => rows().reduce((s, r) => ({ realized: s.realized + BigInt(r.actual ?? '0'), reserved: s.reserved + (r.actual === null ? BigInt(r.worst) : 0n) }), { realized: 0n, reserved: 0n })

  async function settle(row: Row): Promise<TransactionReceipt | null> {
    const receipt = await clients[row.side].getTransactionReceipt({ hash: row.tx }).catch(() => null)
    if (!receipt) return null
    const c = config[row.side]
    // Fork fixture only. This does not claim a measured Robinhood L1 receipt component.
    const actual = toQuoteAtoms(c, receipt.gasUsed * receipt.effectiveGasPrice + BigInt(c.feeInput.l1UpperWei))
    if (actual > BigInt(row.worst)) throw new KeeperError('leg_failed', 'Receipt exceeded its reserved cost; journal remains blocked.')
    options.checkpoint?.('before-cost', row.id)
    db.query('UPDATE rh_sends SET actual=?,receipt=? WHERE id=? AND actual IS NULL').run(actual.toString(), JSON.stringify(receipt, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v), row.id)
    options.checkpoint?.('after-cost', row.id)
    return receipt
  }

  async function send(id: string, side: KeeperChain, to: Address, data: Hex, value = 0n, budget = BigInt(config.policy.maxLegCost)): Promise<Hex> {
    const c = config[side]
    assertInputs(c)
    if (value !== 0n) throw new KeeperError('invalid_configuration', 'Native protocol payments need separate accounting and remain closed.')
    const binding = hash(JSON.stringify([side, c.chainId, to, data, value.toString(), c, config.policy], (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v))
    let row = rowOf(id)
    if (row && row.binding !== binding) throw new KeeperError('leg_failed', 'Send identity is already bound to other bytes or cost inputs.')
    if (!row) {
      for (const pending of rows().filter((r) => r.actual === null)) await settle(pending)
      const client = clients[side]
      if (await client.getChainId() !== c.chainId) throw new KeeperError('invalid_configuration', 'RPC chain ID differs.')
      const gas = ((await client.estimateGas({ account, to, data, value })) * 12n + 9n) / 10n
      const fees = await legFees(client, c)
      const worst = legCost(client, c, gas, fees.maxFeePerGas)
      if (worst > budget || worst > BigInt(config.policy.maxLegCost)) throw new KeeperError('leg_failed', 'Worst-case gas exceeds the leg cost budget; nothing sent.')
      if (await client.getBalance({ address: account.address }) < gas * fees.maxFeePerGas + BigInt(c.feeInput.l1UpperWei)) throw new KeeperError('inventory', 'Operator native gas inventory is depleted.')
      const wallet = createWalletClient({ account, chain: keeperChain(c), transport: http(c.rpc) })
      const request = await wallet.prepareTransactionRequest({ account, chain: keeperChain(c), to, data, value, gas, ...fees })
      const raw = await wallet.signTransaction(request)
      db.transaction(() => {
        const prior = rowOf(id)
        if (prior) {
          if (prior.binding !== binding) throw new KeeperError('leg_failed', 'Conflicting concurrent operation.')
          return
        }
        if (rows().some((r) => r.side === side && r.actual === null)) throw new KeeperError('unresolved_exposure', 'An uncertain send on this chain must be reconciled first.')
        const t = totals()
        if (t.realized + t.reserved + worst > BigInt(config.policy.operatingCap)) throw new KeeperError('spend_cap', 'Cumulative operating cost cap is exhausted; nothing sent.')
        db.query('INSERT INTO rh_sends(id,side,binding,raw,tx,worst) VALUES(?,?,?,?,?,?)').run(id, side, binding, raw, keccak256(raw), worst.toString())
      }).immediate()
      row = rowOf(id)!
      options.checkpoint?.('after-sign', id)
    }
    const receipt = await settle(row)
    if (receipt) {
      if (receipt.status !== 'success') throw new KeeperError('leg_failed', 'The persisted transaction reverted; it is not replaced.')
      return row.tx
    }
    // Signed bytes survive a crash before send, after send, and before receipt/cost persistence.
    try { await clients[side].sendRawTransaction({ serializedTransaction: row.raw }) } catch (cause) {
      if (!/already known|nonce too low/i.test(String(cause))) throw cause
    }
    options.checkpoint?.('after-send', id)
    const observed = await clients[side].waitForTransactionReceipt({ hash: row.tx, timeout: config.receiptTimeoutMs ?? 10_000 })
    options.checkpoint?.('after-receipt', id)
    await settle(row)
    if (observed.status !== 'success') throw new KeeperError('leg_failed', 'The persisted transaction reverted; it is not replaced.')
    return row.tx
  }
  return { send, totals, rows: () => rows().map(({ raw: _raw, ...row }) => row), async reconcile() {
    for (const row of rows().filter((r) => r.actual === null)) {
      if (await settle(row)) continue
      assertInputs(config[row.side])
      try { await clients[row.side].sendRawTransaction({ serializedTransaction: row.raw }) } catch (cause) {
        if (!/already known|nonce too low/i.test(String(cause))) throw cause
      }
      await clients[row.side].waitForTransactionReceipt({ hash: row.tx, timeout: config.receiptTimeoutMs ?? 10_000 })
      await settle(row)
    }
  } }
}
