import type { Database } from 'bun:sqlite'
import { decodeEventLog, encodeFunctionData, type Address, type Hex, type TransactionReceipt } from 'viem'
import { hash } from '../../request'
import { LaunchError } from '../../types'
import { erc20Abi } from '../contracts'
import type { EvmAdapterConfig } from '../types'
import { STANDARD, assertAttestedFrom, bytes32, messageTransmitterAbi, messagesSent, parseMessage, tokenMessengerAbi, tokenMinterAbi, type AttestationSource, type CctpChain } from './cctp'
import { call, parsePlan, prepared, type ExecutorSender } from './executor'
import type { EvmChain, RefillRequest, Transfer, TransferResult, TransferRoute } from './types'

export interface RefillConfig {
  cctp: Record<EvmChain, CctpChain>
  attestation: AttestationSource
  /** Largest single refill and the cumulative ceiling across every refill this store has bound, in USDC atoms. */
  maxPerTransfer: string
  maxTotal: string
}
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const bad = (message: string): never => { throw new LaunchError(400, 'invalid_request', message) }
/** Rails with no verified USDC route to this pair of executors. They stay closed, never substituted. */
const CLOSED: Record<string, string> = {
  solana: 'Solana quote refill is not implemented here; 49TH-26 owns the Solana route.',
  robinhood: 'Robinhood Chain has no verified CCTP deployment pinned for this route; it stays closed.',
}

function usdcMoves(receipt: TransactionReceipt, usdc: Address) {
  return receipt.logs.filter((l) => same(l.address, usdc)).flatMap((l) => {
    try {
      const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
      return e.eventName === 'Transfer' ? [e.args] : []
    } catch { return [] }
  })
}
const total = (items: { value: bigint }[]) => items.reduce((n, x) => n + x.value, 0n)

/**
 * USDC quote-inventory refill between the Arc and Base executors with CCTP V2 standard transfers.
 * The source executor burns through Circle's TokenMessengerV2; once the burn is final the attested
 * message is received by the destination executor, which is both the mint recipient and the only
 * permitted destination caller, so nobody else can complete (or front-run) the mint.
 * Separate from EQUILIBRIUM bridging: no launch job, its own caps and its own approval.
 */
export function refillRoute(config: Pick<EvmAdapterConfig, 'arc' | 'base' | 'mode'>, refill: RefillConfig, sender: ExecutorSender, db: Database): TransferRoute<RefillRequest> {
  db.exec(`CREATE TABLE IF NOT EXISTS evm_transfer_attestations (transfer TEXT PRIMARY KEY, message TEXT NOT NULL, attestation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evm_refill_reservations (transfer TEXT PRIMARY KEY, amount TEXT NOT NULL);`)
  const { clients } = sender
  const chains = { arc: config.arc, base: config.base }
  const pinned = { mode: config.mode, cctp: refill.cctp, attestation: refill.attestation.kind, maxPerTransfer: refill.maxPerTransfer, maxTotal: refill.maxTotal, minFinality: STANDARD,
    executors: { arc: config.arc.executor, base: config.base.executor }, chainIds: { arc: config.arc.chainId, base: config.base.chainId } }
  const version = `evm-refill-v1:${hash(pinned).slice(2, 18)}`
  const reserved = (except?: Hex) => db.query<{ amount: string }, [string]>('SELECT amount FROM evm_refill_reservations WHERE transfer != ?').all(except ?? '').reduce((n, r) => n + BigInt(r.amount), 0n)
  const overCap = (amount: bigint, except?: Hex) => reserved(except) + amount > BigInt(refill.maxTotal)
  /**
   * Reserve against the cumulative ceiling atomically, before a burn can be prepared. Two workers on
   * two refills cannot both take the last headroom. A reservation is never released: a refill that
   * stops half way still counts, which errs toward spending less than approved.
   */
  const reserve = db.transaction((id: Hex, amount: bigint) => {
    if (db.query('SELECT 1 FROM evm_refill_reservations WHERE transfer=?').get(id)) return
    if (overCap(amount, id)) throw new LaunchError(409, 'refill_cap', `Refills would exceed the approved ${refill.maxTotal} USDC atoms in total.`)
    db.query('INSERT INTO evm_refill_reservations(transfer, amount) VALUES(?, ?)').run(id, amount.toString())
  })

  async function burned(t: Transfer<RefillRequest>, receipt: TransactionReceipt, operation: Hex): Promise<TransferResult | 'pending'> {
    const r = t.request
    const src = refill.cctp[r.from]; const dst = refill.cctp[r.to]
    if (receipt.status !== 'success') throw new Error('The burn transaction reverted')
    const sent = messagesSent(receipt.logs, src.messageTransmitter)
    if (sent.length !== 1) throw new Error(`The burn emitted ${sent.length} CCTP messages; expected exactly one`)
    const m = parseMessage(sent[0])
    const executor = { from: chains[r.from].executor, to: chains[r.to].executor }
    const expected = m.sourceDomain === src.domain && m.destinationDomain === dst.domain && same(m.sender, bytes32(src.tokenMessenger)) && same(m.recipient, bytes32(dst.tokenMessenger))
      && same(m.destinationCaller, bytes32(executor.to)) && m.minFinalityThreshold === STANDARD && same(m.body.burnToken, bytes32(src.usdc)) && same(m.body.mintRecipient, bytes32(executor.to))
      && m.body.amount === BigInt(r.amount) && same(m.body.messageSender, bytes32(executor.from)) && m.body.maxFee === BigInt(r.maxFee) && m.body.hookData === '0x'
    if (!expected) throw new Error('The CCTP message differs from the bound refill')
    const out = usdcMoves(receipt, src.usdc)
    const destroyed = total(out.filter((e) => e.to === ZERO_ADDRESS))
    if (destroyed !== BigInt(r.amount) || total(out.filter((e) => same(e.from, executor.from))) !== BigInt(r.amount)) throw new Error('The source USDC burn differs from the bound amount')
    // Standard attestations are issued at hard finality; unattested is pending, never absent.
    const attested = await refill.attestation.attested({ sourceDomain: src.domain, transaction: receipt.transactionHash, message: sent[0] })
    if (!attested) return 'pending'
    assertAttestedFrom(sent[0], attested.message)
    db.query('INSERT OR IGNORE INTO evm_transfer_attestations(transfer, message, attestation) VALUES(?,?,?)').run(t.id, attested.message, attested.attestation)
    const a = parseMessage(attested.message)
    return { operation, transaction: receipt.transactionHash, finalized: true, cost: sender.cost(r.from, receipt), amount: r.amount, by: 'executor',
      details: { nonce: a.nonce, feeExecuted: a.body.feeExecuted.toString(), minted: (BigInt(r.amount) - a.body.feeExecuted).toString() } }
  }

  return {
    kind: 'refill',
    version,
    parse(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Expected a JSON object.')
      const r = raw as Record<string, unknown>
      if (r.kind !== 'refill') return bad('Not a refill request.')
      if (Object.keys(r).some((k) => !['kind', 'requestId', 'from', 'to', 'amount', 'maxFee'].includes(k))) return bad('Unknown request field.')
      if (typeof r.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(r.requestId)) return bad('Invalid requestId.')
      for (const side of [r.from, r.to]) if (typeof side === 'string' && CLOSED[side]) throw new LaunchError(503, 'route_closed', CLOSED[side])
      if ((r.from !== 'arc' && r.from !== 'base') || (r.to !== 'arc' && r.to !== 'base') || r.from === r.to) return bad('Refills run between the Arc and Base executors.')
      if (typeof r.amount !== 'string' || !/^[1-9]\d{0,19}$/.test(r.amount)) return bad('amount must be a positive decimal string of USDC atoms.')
      // Standard transfers are free on both routes today; a nonzero fee ceiling is refused, not budgeted.
      if (r.maxFee !== '0') return bad('Only zero-fee standard transfers are accepted: maxFee must be "0".')
      return { kind: 'refill', requestId: r.requestId, from: r.from, to: r.to, amount: r.amount, maxFee: '0' }
    },
    identity: (r) => hash(['refill', r.requestId]),
    steps: (r) => [{ id: `burn:${r.from}`, chain: r.from }, { id: `mint:${r.to}`, chain: r.to }],
    async assertAllowed(r, existing) {
      if (existing?.steps[0].prepared) return // bound and possibly sent: the bytes decide from here
      const amount = BigInt(r.amount)
      if (amount > BigInt(refill.maxPerTransfer)) throw new LaunchError(409, 'refill_cap', `Refills are capped at ${refill.maxPerTransfer} USDC atoms each.`)
      if (overCap(amount, existing?.id)) throw new LaunchError(409, 'refill_cap', `Refills would exceed the approved ${refill.maxTotal} USDC atoms in total.`)
      const src = refill.cctp[r.from]
      const [held, limit] = await Promise.all([
        clients[r.from].readContract({ address: src.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [chains[r.from].executor] }),
        clients[r.from].readContract({ address: src.tokenMinter, abi: tokenMinterAbi, functionName: 'burnLimitsPerMessage', args: [src.usdc] }),
      ])
      if (held < amount) throw new LaunchError(409, 'inventory', `The ${r.from} executor holds ${held} USDC atoms, below the ${amount} to refill.`)
      if (limit < amount) throw new LaunchError(409, 'burn_limit', `CCTP burns at most ${limit} atoms per message on ${r.from}.`)
    },
    async prepare(t, step) {
      const r = t.request
      const operation = hash([t.id, step.id])
      const src = refill.cctp[r.from]; const dst = refill.cctp[r.to]
      if (step.id.startsWith('burn:')) {
        reserve.immediate(t.id, BigInt(r.amount))
        const fromBlock = await clients[r.from].getBlockNumber({ cacheTime: 0 })
        const to = chains[r.to].executor
        return prepared({ chain: r.from, chainId: chains[r.from].chainId, executor: chains[r.from].executor, operation, value: '0', fromBlock: fromBlock.toString(),
          calls: [call(src.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [src.tokenMessenger, BigInt(r.amount)] })),
            call(src.tokenMessenger, encodeFunctionData({ abi: tokenMessengerAbi, functionName: 'depositForBurn', args: [BigInt(r.amount), dst.domain, bytes32(to), src.usdc, bytes32(to), BigInt(r.maxFee), STANDARD] }))],
          expect: { usdc: src.usdc } })
      }
      const row = db.query<{ message: string; attestation: string }, [string]>('SELECT message, attestation FROM evm_transfer_attestations WHERE transfer=?').get(t.id)
      if (!row) throw new Error('No attested message is recorded for the finalized burn')
      const fromBlock = await clients[r.to].getBlockNumber({ cacheTime: 0 })
      return prepared({ chain: r.to, chainId: chains[r.to].chainId, executor: chains[r.to].executor, operation, value: '0', fromBlock: fromBlock.toString(),
        calls: [call(dst.messageTransmitter, encodeFunctionData({ abi: messageTransmitterAbi, functionName: 'receiveMessage', args: [row.message as Hex, row.attestation as Hex] }))],
        expect: { usdc: dst.usdc } })
    },
    async observe(t, step, effect) {
      const p = parsePlan(effect, hash([t.id, step.id]))
      const seen = await sender.observe(p, effect.digest)
      if (seen === 'absent' || seen === 'pending') return seen
      if (step.id.startsWith('burn:')) return burned(t, seen, p.operation)
      const to = chains[t.request.to].executor
      const minted = total(usdcMoves(seen, p.expect.usdc as Address).filter((e) => e.from === ZERO_ADDRESS && same(e.to, to)))
      return { operation: p.operation, transaction: seen.transactionHash, finalized: true, cost: sender.cost(t.request.to, seen), amount: minted.toString(), by: 'executor' }
    },
    async broadcast(t, step, effect) { await sender.broadcast(parsePlan(effect, hash([t.id, step.id])), effect.digest) },
    validate(t, step, result) {
      if (step.id.startsWith('burn:') && result.amount !== t.request.amount) throw new Error('Burned amount differs from the bound refill')
      // Conservation per refill: minted equals burned less the fee the attestation says was charged.
      if (step.id.startsWith('mint:') && result.amount !== t.steps[0].result!.details!.minted) throw new Error('Minted USDC differs from the attested burn')
    },
  }
}
