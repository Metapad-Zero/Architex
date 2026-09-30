import type { Database } from 'bun:sqlite'
import { decodeEventLog, encodeFunctionData, isAddress, isHex, parseAbi, type Address, type Hex, type TransactionReceipt } from 'viem'
import { hash } from '../../request'
import { LaunchError, type Job } from '../../types'
import { layout } from '../adapter'
import { NTT_COMMIT, coreAbi, erc20Abi, nttAbi, transceiverAbi, universal } from '../contracts'
import type { EvmAdapterConfig } from '../types'
import { publishedFrom } from '../vaa'
import { call, parsePlan, prepared, type ExecutorPlan, type ExecutorSender } from './executor'
import { evmAddress, managerDigest, parseTransfer } from './ntt'
import type { ReturnRequest, Transfer, TransferResult, TransferRoute } from './types'

export const nttViewAbi = parseAbi([
  'function isMessageExecuted(bytes32 digest) view returns (bool)',
  'function getCurrentInboundCapacity(uint16 chainId) view returns (uint256)',
  'event TransferRedeemed(bytes32 indexed digest)',
  'event InboundTransferQueued(bytes32 digest)',
])
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const bad = (message: string): never => { throw new LaunchError(400, 'invalid_request', message) }

export interface ReturnConfig {
  /** Largest single return, in EQUILIBRIUM atoms. It must also fit the Arc hub's inbound NTT limit. */
  maxPerTransfer: string
}

function transfers(receipt: TransactionReceipt, token: string) {
  return receipt.logs.filter((l) => same(l.address, token)).flatMap((l) => {
    try {
      const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics })
      return e.eventName === 'Transfer' ? [e.args] : []
    } catch { return [] }
  })
}
const total = (items: { value: bigint }[]) => items.reduce((n, x) => n + x.value, 0n)

/**
 * Base→Arc return of EQUILIBRIUM through the launch's own NTT managers: the Base spoke burns, the
 * Wormhole Guardians attest the finalized burn, and the Arc hub unlocks the same amount from custody.
 *
 * Two sources. `executor`: operator inventory held by the Base executor is burned by an executor
 * operation. `holder`: a holder already called the Base manager's `transfer` themselves; this route
 * observes that burn once finalized and relays its VAA. Either way the Arc unlock is one executor
 * operation. A third party may relay the same VAA first (receiveMessage is permissionless); the
 * route then records their redemption instead of trying again, so nothing is credited twice.
 */
export function returnRoute(config: Pick<EvmAdapterConfig, 'arc' | 'base' | 'vaa' | 'limits' | 'mode'>, limits: ReturnConfig, sender: ExecutorSender, db: Database, launchOf: (id: Hex) => Job | undefined): TransferRoute<ReturnRequest> {
  db.exec('CREATE TABLE IF NOT EXISTS evm_transfer_vaas (transfer TEXT PRIMARY KEY, vaa TEXT NOT NULL);')
  const { clients } = sender
  const pinned = { ntt: NTT_COMMIT, mode: config.mode, vaa: config.vaa.kind, limits: { inbound: config.limits.inbound.toString() }, maxPerTransfer: limits.maxPerTransfer,
    chains: [config.arc, config.base].map((c) => ({ chain: c.chain, chainId: c.chainId, wormholeChainId: c.wormholeChainId, core: c.core, executor: c.executor, finality: c.finality })) }
  const version = `evm-return-v1:${hash(pinned).slice(2, 18)}`

  function launch(id: Hex) {
    const job = launchOf(id)
    if (!job || job.state !== 'complete') throw new LaunchError(409, 'launch_incomplete', 'Returns need a completed launch whose Base representation exists.')
    const L = layout(job, config)
    // The launch recorded where its managers were deployed; a different configuration cannot address them.
    const baseManager = job.steps.find((s) => s.id === 'manager:base')?.result?.address
    if (!baseManager || !same(baseManager, L.spokeManager.proxy)) throw new LaunchError(409, 'adapter_conflict', 'The launch was executed under a different executor configuration.')
    return { job, L }
  }
  const stepOf = (t: Transfer<ReturnRequest>, id: string) => t.steps.find((s) => s.id === id)!

  /** Everything the finalized burn proves: one NTT transfer from this launch's Base manager to its Arc hub. */
  async function burned(t: Transfer<ReturnRequest>, receipt: TransactionReceipt, by: TransferResult['by'], operation: Hex): Promise<TransferResult | 'pending'> {
    const { L } = launch(t.request.launch)
    if (receipt.status !== 'success') throw new Error('The burn transaction reverted')
    const block = await clients.base.getBlock({ blockNumber: receipt.blockNumber })
    const messages = publishedFrom(receipt.logs, config.base.core, config.base.wormholeChainId, Number(block.timestamp))
      .filter((m) => same(m.emitter, universal(L.spokeManager.transceiver)))
    if (messages.length !== 1) throw new Error(`The burn published ${messages.length} messages from this launch's Base transceiver; expected exactly one`)
    const message = messages[0]
    const x = parseTransfer(message.payload)
    if (!same(x.sourceManager, universal(L.spokeManager.proxy)) || !same(x.recipientManager, universal(L.hub.proxy))) throw new Error('The message does not route this launch from Base to Arc')
    if (x.toChain !== config.arc.wormholeChainId || !same(x.sourceToken, universal(L.spoke)) || x.decimals !== 6) throw new Error('The message targets another chain, token or precision')
    const burnt = total(transfers(receipt, L.spoke).filter((e) => same(e.from, L.spokeManager.proxy) && e.to === ZERO_ADDRESS))
    if (burnt !== x.amount) throw new Error(`The spoke burned ${burnt}, but the message carries ${x.amount}`)
    const r = t.request
    if (r.source === 'executor' && (x.amount !== BigInt(r.amount) || !same(x.to, universal(r.recipient)) || !same(x.sender, universal(config.base.executor)))) throw new Error('The executor burn differs from the bound return')
    // Signed only after the burn is final on Base; unsigned is pending, never absent.
    const vaa = await config.vaa.signed(message)
    if (!vaa) return 'pending'
    db.query('INSERT OR IGNORE INTO evm_transfer_vaas(transfer, vaa) VALUES(?, ?)').run(t.id, vaa)
    return { operation, transaction: receipt.transactionHash, finalized: true, cost: by === 'executor' ? sender.cost('base', receipt) : '0', amount: x.amount.toString(), by,
      details: { to: evmAddress(x.to), sender: x.sender, sequence: message.sequence.toString(), digest: managerDigest(config.base.wormholeChainId, x) } }
  }

  function unlocked(t: Transfer<ReturnRequest>, receipt: TransactionReceipt, by: TransferResult['by'], operation: Hex): TransferResult {
    const { L } = launch(t.request.launch)
    const burn = stepOf(t, 'burn:base').result!
    const digest = burn.details!.digest as Hex
    const redeemed = receipt.logs.some((l) => same(l.address, L.hub.proxy) && (() => {
      try { const e = decodeEventLog({ abi: nttViewAbi, data: l.data, topics: l.topics }); return e.eventName === 'TransferRedeemed' && e.args.digest === digest } catch { return false }
    })())
    if (!redeemed) throw new LaunchError(409, 'queued', 'The Arc hub did not redeem the transfer (inbound rate limit queue or a different message).')
    const amount = total(transfers(receipt, L.canonical).filter((e) => same(e.from, L.hub.proxy) && same(e.to, burn.details!.to)))
    return { operation, transaction: receipt.transactionHash, finalized: true, cost: by === 'executor' ? sender.cost('arc', receipt) : '0', amount: amount.toString(), by, details: { to: burn.details!.to, digest } }
  }

  async function redemption(p: ExecutorPlan, digest: Hex, blockNumber: bigint) {
    return clients.arc.readContract({ address: p.expect.manager as Address, abi: nttViewAbi, functionName: 'isMessageExecuted', args: [digest], blockNumber })
  }

  return {
    kind: 'return',
    version,
    parse(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Expected a JSON object.')
      const r = raw as Record<string, unknown>
      const hex32 = (v: unknown, label: string) => (typeof v === 'string' && isHex(v) && v.length === 66 ? v.toLowerCase() as Hex : bad(`Invalid ${label}.`))
      if (r.kind !== 'return') return bad('Not a return request.')
      if (r.source === 'holder') {
        if (Object.keys(r).some((k) => !['kind', 'source', 'launch', 'transaction'].includes(k))) return bad('Unknown request field.')
        return { kind: 'return', source: 'holder', launch: hex32(r.launch, 'launch'), transaction: hex32(r.transaction, 'transaction') }
      }
      if (r.source !== 'executor') return bad('source must be executor or holder.')
      if (Object.keys(r).some((k) => !['kind', 'source', 'requestId', 'launch', 'amount', 'recipient'].includes(k))) return bad('Unknown request field.')
      if (typeof r.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(r.requestId)) return bad('Invalid requestId.')
      if (typeof r.amount !== 'string' || !/^[1-9]\d{0,19}$/.test(r.amount) || BigInt(r.amount) > 18446744073709551615n) return bad('amount must be a positive uint64 decimal string.')
      if (typeof r.recipient !== 'string' || !isAddress(r.recipient) || /^0x0+$/.test(r.recipient)) return bad('A nonzero Arc recipient is required.')
      return { kind: 'return', source: 'executor', requestId: r.requestId, launch: hex32(r.launch, 'launch'), amount: r.amount, recipient: r.recipient.toLowerCase() as Address }
    },
    // A holder burn can be returned once, whoever asks; an operator return is keyed by its request id.
    identity: (r) => (r.source === 'holder' ? hash(['return', 'holder', r.transaction]) : hash(['return', 'executor', r.requestId])),
    steps: () => [{ id: 'burn:base', chain: 'base' }, { id: 'unlock:arc', chain: 'arc' }],
    async assertAllowed(r, existing) {
      const { L } = launch(r.launch)
      // Once the burn is prepared the executor's balance already reflects it; the bound bytes decide.
      if (r.source === 'holder' || existing?.steps[0].prepared) return
      const amount = BigInt(r.amount)
      if (amount > BigInt(limits.maxPerTransfer)) throw new LaunchError(409, 'return_cap', `Returns are capped at ${limits.maxPerTransfer} atoms each.`)
      if (amount > config.limits.inbound) throw new LaunchError(409, 'rate_limit', 'The return exceeds the Arc hub inbound limit and would queue.')
      const held = await clients.base.readContract({ address: L.spoke, abi: erc20Abi, functionName: 'balanceOf', args: [config.base.executor] })
      // Operator inventory only: the executor cannot burn tokens it does not hold.
      if (held < amount) throw new LaunchError(409, 'inventory', `The Base executor holds ${held} atoms, below the ${amount} to return.`)
    },
    async prepare(t, step) {
      const { L } = launch(t.request.launch)
      const operation = hash([t.id, step.id])
      const r = t.request
      if (step.id === 'burn:base' && r.source === 'holder') {
        // Nothing to send: the holder's own transaction is the effect. Bytes bind which one.
        return prepared({ chain: 'base', chainId: config.base.chainId, executor: config.base.executor, operation, calls: [], value: '0', fromBlock: '0', expect: { transaction: r.transaction } })
      }
      if (step.id === 'burn:base' && r.source === 'executor') {
        const fee = await clients.base.readContract({ address: config.base.core, abi: coreAbi, functionName: 'messageFee' })
        const fromBlock = await clients.base.getBlockNumber({ cacheTime: 0 })
        return prepared({ chain: 'base', chainId: config.base.chainId, executor: config.base.executor, operation, value: fee.toString(), fromBlock: fromBlock.toString(),
          calls: [call(L.spoke, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [L.spokeManager.proxy, BigInt(r.amount)] })),
            call(L.spokeManager.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'transfer', args: [BigInt(r.amount), config.arc.wormholeChainId, universal(r.recipient)] }), fee)],
          expect: { token: L.spoke, manager: L.spokeManager.proxy } })
      }
      const vaa = db.query<{ vaa: string }, [string]>('SELECT vaa FROM evm_transfer_vaas WHERE transfer=?').get(t.id)?.vaa
      if (!vaa) throw new Error('No signed VAA is recorded for the finalized burn')
      const burn = stepOf(t, 'burn:base').result!
      const capacity = await clients.arc.readContract({ address: L.hub.proxy, abi: nttViewAbi, functionName: 'getCurrentInboundCapacity', args: [config.base.wormholeChainId] })
      if (capacity < BigInt(burn.amount)) throw new LaunchError(409, 'rate_limit', `The Arc hub can take ${capacity} atoms from Base now; the return of ${burn.amount} would queue.`)
      const fromBlock = await clients.arc.getBlockNumber({ cacheTime: 0 })
      return prepared({ chain: 'arc', chainId: config.arc.chainId, executor: config.arc.executor, operation, value: '0', fromBlock: fromBlock.toString(),
        calls: [call(L.hub.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa as Hex] }))],
        expect: { token: L.canonical, manager: L.hub.proxy, digest: burn.details!.digest } })
    },
    async observe(t, step, effect) {
      const p = parsePlan(effect, hash([t.id, step.id]))
      if (step.id === 'burn:base' && t.request.source === 'holder') {
        const tx = p.expect.transaction as Hex
        const receipt = await clients.base.getTransactionReceipt({ hash: tx }).catch(() => null)
        if (!receipt) {
          if (await clients.base.getTransaction({ hash: tx }).then(() => true, () => false)) return 'pending'
          throw new LaunchError(404, 'unknown_transaction', 'The Base burn transaction is unknown to the Base RPC.')
        }
        if (receipt.blockNumber > await sender.finalizedBlock('base')) return 'pending'
        return burned(t, receipt, 'holder', p.operation)
      }
      const seen = await sender.observe(p, effect.digest)
      if (seen !== 'absent' && seen !== 'pending') return step.id === 'burn:base' ? burned(t, seen, 'executor', p.operation) : unlocked(t, seen, 'executor', p.operation)
      if (seen === 'pending' || step.id === 'burn:base') return seen
      // Our operation never executed. Someone else may have relayed the same VAA.
      const digest = p.expect.digest as Hex
      const finalized = await sender.finalizedBlock('arc')
      if (await redemption(p, digest, finalized)) {
        const [log] = await clients.arc.getLogs({ address: p.expect.manager as Address, event: nttViewAbi.find((x) => x.type === 'event' && x.name === 'TransferRedeemed')!, args: { digest }, fromBlock: BigInt(p.fromBlock), toBlock: finalized }) as { transactionHash: Hex }[]
        if (!log) throw new Error('The transfer was redeemed before this return prepared its unlock; search from an earlier block')
        return unlocked(t, await clients.arc.getTransactionReceipt({ hash: log.transactionHash }), 'third-party', p.operation)
      }
      if (await redemption(p, digest, await clients.arc.getBlockNumber({ cacheTime: 0 }))) return 'pending'
      return 'absent'
    },
    async broadcast(t, step, effect) {
      const p = parsePlan(effect, hash([t.id, step.id]))
      if (step.id === 'burn:base' && t.request.source === 'holder') throw new Error('A holder burn is the holder\'s own transaction; the operator sends nothing for it')
      // Already redeemed by anyone: sending would only revert.
      if (step.id === 'unlock:arc' && await redemption(p, p.expect.digest as Hex, await clients.arc.getBlockNumber({ cacheTime: 0 }))) return
      await sender.broadcast(p, effect.digest)
    },
    validate(t, step, result) {
      const r = t.request
      if (step.id === 'burn:base' && r.source === 'executor' && result.amount !== r.amount) throw new Error('Burn amount differs from the bound return')
      if (step.id === 'unlock:arc') {
        const burn = stepOf(t, 'burn:base').result!
        // Conservation per transfer: what Arc custody released equals what Base burned.
        if (result.amount !== burn.amount || result.details?.to !== burn.details?.to) throw new Error('Unlocked amount or recipient differs from the finalized burn')
      }
    },
  }
}

/**
 * Supply of one launch at each chain's finalized block. Canonical supply never changes; Arc custody
 * backs the Base representation. `inFlight` is custody not yet matched by Base supply: a finalized
 * burn awaiting its unlock, or a debit awaiting its credit. Base supply above custody would mean
 * unbacked credit and is reported as a violation.
 */
export async function conservation(sender: ExecutorSender, config: Pick<EvmAdapterConfig, 'arc' | 'base'>, job: Job) {
  const L = layout(job, config)
  const [arcBlock, baseBlock] = await Promise.all([sender.finalizedBlock('arc'), sender.finalizedBlock('base')])
  const read = (chain: 'arc' | 'base', address: Address, functionName: 'totalSupply' | 'balanceOf', args: readonly [Address] | [] = [], blockNumber = chain === 'arc' ? arcBlock : baseBlock) =>
    sender.clients[chain].readContract({ address, abi: erc20Abi, functionName, args: args as never, blockNumber }) as Promise<bigint>
  const [issuance, custody, remote] = await Promise.all([read('arc', L.canonical, 'totalSupply'), read('arc', L.canonical, 'balanceOf', [L.hub.proxy]), read('base', L.spoke, 'totalSupply')])
  const expected = BigInt(job.request.canonical.issuance)
  return { arcBlock: arcBlock.toString(), baseBlock: baseBlock.toString(), issuance: issuance.toString(), custody: custody.toString(), remote: remote.toString(),
    inFlight: (custody - remote).toString(), outsideCustody: (issuance - custody).toString(), circulating: (issuance - custody + remote).toString(),
    conserved: issuance === expected && remote <= custody }
}
