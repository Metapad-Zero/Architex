import type { Database } from 'bun:sqlite'
import { decodeEventLog, encodeFunctionData, isAddress, isHex, parseAbi, type Address, type Hex, type TransactionReceipt } from 'viem'
import { hash } from '../../request'
import { LaunchError, type Job } from '../../types'
import { layout } from '../adapter'
import { NTT_COMMIT, coreAbi, erc20Abi, nttAbi, transceiverAbi, universal } from '../contracts'
import type { EvmAdapterConfig } from '../types'
import { publishedFrom } from '../vaa'
import { call, parsePlan, prepared, type ExecutorSender } from './executor'
import { evmAddress, managerDigest, parseTransfer } from './ntt'
import { nttViewAbi } from './returns'
import type { TokenRefillRequest, Transfer, TransferResult, TransferRoute } from './types'

export interface TokenRefillConfig { maxPerTransfer: string; maxTotal: string }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const bad = (message: string): never => { throw new LaunchError(400, 'invalid_request', message) }
const zero = '0x0000000000000000000000000000000000000000'
const capacityAbi = parseAbi(['function getCurrentOutboundCapacity() view returns (uint256)'])

/** Canonical lock on Arc → Guardian-authenticated mint on Base, using the completed launch's peers. */
export function tokenRefillRoute(config: Pick<EvmAdapterConfig, 'arc' | 'base' | 'vaa' | 'limits' | 'mode'>, limits: TokenRefillConfig, sender: ExecutorSender, db: Database, launchOf: (id: Hex) => Job | undefined): TransferRoute<TokenRefillRequest> {
  for (const key of ['maxPerTransfer', 'maxTotal'] as const) {
    if (typeof limits[key] !== 'string' || !/^[1-9]\d*$/.test(limits[key])) bad(`tokenRefill.${key} must be positive decimal atoms.`)
  }
  if (BigInt(limits.maxTotal) < BigInt(limits.maxPerTransfer)) bad('Token refill total must cover one transfer.')
  db.exec(`CREATE TABLE IF NOT EXISTS evm_token_refill_vaas (transfer TEXT PRIMARY KEY, vaa TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS evm_token_refill_reservations (identity TEXT PRIMARY KEY, request TEXT NOT NULL, amount TEXT NOT NULL);`)
  const { clients } = sender
  const version = `evm-token-refill-v1:${hash({ ntt: NTT_COMMIT, mode: config.mode, limits, outbound: config.limits.outbound.toString(), inbound: config.limits.inbound.toString(), vaa: config.vaa.kind,
    chains: [config.arc, config.base].map((c) => ({ chainId: c.chainId, wormholeChainId: c.wormholeChainId, core: c.core, executor: c.executor, finality: c.finality })) }).slice(2, 18)}`
  function launch(id: Hex) {
    const job = launchOf(id)
    if (!job || job.state !== 'complete') throw new LaunchError(409, 'launch_incomplete', 'Token refill requires a completed launch.')
    const L = layout(job, config)
    for (const [step, address] of [['manager:arc', L.hub.proxy], ['manager:base', L.spokeManager.proxy]] as const) {
      if (!same(job.steps.find((s) => s.id === step)?.result?.address ?? '', address)) throw new LaunchError(409, 'adapter_conflict', 'Launch managers differ from this executor configuration.')
    }
    return L
  }
  const debitOf = (t: Transfer<TokenRefillRequest>) => t.steps.find((s) => s.id === 'lock:arc')!.result!
  function moved(receipt: TransactionReceipt, token: Address, from: Address, to: Address) {
    return receipt.logs.filter((l) => same(l.address, token)).reduce((sum, l) => {
      try { const e = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics }); return e.eventName === 'Transfer' && same(e.args.from, from) && same(e.args.to, to) ? sum + e.args.value : sum } catch { return sum }
    }, 0n)
  }
  async function locked(t: Transfer<TokenRefillRequest>, receipt: TransactionReceipt, operation: Hex): Promise<TransferResult | 'pending'> {
    const L = launch(t.request.launch)
    if (receipt.status !== 'success') throw new Error('Canonical lock reverted.')
    const block = await clients.arc.getBlock({ blockNumber: receipt.blockNumber })
    const messages = publishedFrom(receipt.logs, config.arc.core, config.arc.wormholeChainId, Number(block.timestamp)).filter((m) => same(m.emitter, universal(L.hub.transceiver)))
    if (messages.length !== 1) throw new Error('Lock must publish exactly one message from this launch transceiver.')
    const message = messages[0]; const x = parseTransfer(message.payload)
    if (!same(x.sourceManager, universal(L.hub.proxy)) || !same(x.recipientManager, universal(L.spokeManager.proxy))
      || x.toChain !== config.base.wormholeChainId || !same(x.sourceToken, universal(L.canonical)) || x.decimals !== 6
      || !same(x.sender, universal(config.arc.executor)) || !same(x.to, universal(t.request.recipient)) || x.amount !== BigInt(t.request.amount)) throw new Error('NTT message differs from the bound canonical refill.')
    if (moved(receipt, L.canonical, config.arc.executor, L.hub.proxy) !== x.amount) throw new Error('Canonical debit differs from the authenticated claim.')
    const vaa = await config.vaa.signed(message)
    if (!vaa) return 'pending'
    db.query('INSERT OR IGNORE INTO evm_token_refill_vaas(transfer,vaa) VALUES(?,?)').run(t.id, vaa)
    return { operation, transaction: receipt.transactionHash, finalized: true, cost: sender.cost('arc', receipt), amount: x.amount.toString(), by: 'executor',
      details: { to: evmAddress(x.to), digest: managerDigest(config.arc.wormholeChainId, x), sequence: message.sequence.toString() } }
  }
  function credited(t: Transfer<TokenRefillRequest>, receipt: TransactionReceipt, operation: Hex, by: TransferResult['by']): TransferResult {
    const L = launch(t.request.launch); const debit = debitOf(t)
    const redeemed = receipt.logs.some((l) => same(l.address, L.spokeManager.proxy) && (() => {
      try { const e = decodeEventLog({ abi: nttViewAbi, data: l.data, topics: l.topics }); return e.eventName === 'TransferRedeemed' && same(e.args.digest, debit.details!.digest) } catch { return false }
    })())
    if (receipt.status !== 'success' || !redeemed) throw new LaunchError(409, 'queued', 'Base has not redeemed the authenticated refill; maintenance stays pending.')
    return { operation, transaction: receipt.transactionHash, finalized: true, cost: by === 'executor' ? sender.cost('base', receipt) : '0',
      amount: moved(receipt, L.spoke, zero, t.request.recipient).toString(), by, details: { to: t.request.recipient, digest: debit.details!.digest } }
  }
  async function executed(t: Transfer<TokenRefillRequest>, blockNumber: bigint) {
    return clients.base.readContract({ address: launch(t.request.launch).spokeManager.proxy, abi: nttViewAbi, functionName: 'isMessageExecuted', args: [debitOf(t).details!.digest as Hex], blockNumber })
  }
  function zeroFee(effect: { bytes: string }) {
    const plan = JSON.parse(effect.bytes) as { value: string; calls: { value: string }[] }
    if (plan.value !== '0' || plan.calls.some((c) => c.value !== '0')) throw new LaunchError(409, 'protocol_fee', 'Token refill accepts only zero-message-fee NTT; native protocol fees require separate accounting and approval.')
  }
  return {
    kind: 'token-refill', version,
    parse(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Expected a token refill object.')
      const r = raw as Record<string, unknown>
      if (Object.keys(r).some((k) => !['kind','requestId','launch','amount','recipient'].includes(k)) || r.kind !== 'token-refill') return bad('Unknown token refill field or kind.')
      if (typeof r.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(r.requestId)) return bad('Invalid requestId.')
      if (typeof r.launch !== 'string' || !isHex(r.launch) || r.launch.length !== 66) return bad('Invalid launch.')
      if (typeof r.amount !== 'string' || !/^[1-9]\d{0,19}$/.test(r.amount) || BigInt(r.amount) > 18446744073709551615n) return bad('amount must be positive uint64 decimal atoms.')
      if (typeof r.recipient !== 'string' || !isAddress(r.recipient) || /^0x0+$/.test(r.recipient)) return bad('A nonzero Base recipient is required.')
      return { kind: 'token-refill', requestId: r.requestId, launch: r.launch.toLowerCase() as Hex, amount: r.amount, recipient: r.recipient.toLowerCase() as Address }
    },
    identity: (r) => hash(['token-refill', r.requestId]),
    steps: () => [{ id: 'lock:arc', chain: 'arc' }, { id: 'mint:base', chain: 'base' }],
    async assertAllowed(r, existing) {
      const L = launch(r.launch)
      if (existing?.steps[0].prepared) return // debit may already be mined; recover its persisted operation
      const amount = BigInt(r.amount)
      if (amount > BigInt(limits.maxPerTransfer)) throw new LaunchError(409, 'refill_cap', 'Token refill exceeds its per-transfer cap.')
      if (amount > config.limits.outbound || amount > config.limits.inbound) throw new LaunchError(409, 'rate_limit', 'Token refill exceeds approved NTT limits.')
      const held = await clients.arc.readContract({ address: L.canonical, abi: erc20Abi, functionName: 'balanceOf', args: [config.arc.executor] })
      if (held < amount) throw new LaunchError(409, 'inventory', `Arc executor holds ${held} atoms, below the ${amount} to refill.`)
      // Reserve synchronously after chain reads: concurrent admissions cannot both take the last cap.
      db.transaction(() => {
        const identity = hash(['token-refill', r.requestId]); const request = JSON.stringify([version, r])
        const prior = db.query<{ request: string }, [string]>('SELECT request FROM evm_token_refill_reservations WHERE identity=?').get(identity)
        if (prior) { if (prior.request !== request) throw new LaunchError(409, 'identity_conflict', 'Token refill reservation is bound to different bytes.'); return }
        const reserved = db.query<{ amount: string }, []>('SELECT amount FROM evm_token_refill_reservations').all().reduce((sum, row) => sum + BigInt(row.amount), 0n)
        if (reserved + amount > BigInt(limits.maxTotal)) throw new LaunchError(409, 'refill_cap', 'Token refill exceeds its cumulative cap; pending transfers still count.')
        db.query('INSERT INTO evm_token_refill_reservations(identity,request,amount) VALUES(?,?,?)').run(identity, request, r.amount)
      }).immediate()
    },
    async prepare(t, step) {
      const L = launch(t.request.launch); const operation = hash([t.id, step.id])
      const chain = step.chain; const c = config[chain]
      const fromBlock = (await clients[chain].getBlockNumber({ cacheTime: 0 })).toString()
      if (step.id === 'lock:arc') {
        const fee = await clients.arc.readContract({ address: config.arc.core, abi: coreAbi, functionName: 'messageFee' })
        if (fee !== 0n) throw new LaunchError(409, 'protocol_fee', 'Token refill accepts only zero-message-fee NTT.')
        const capacity = await clients.arc.readContract({ address: L.hub.proxy, abi: capacityAbi, functionName: 'getCurrentOutboundCapacity' })
        if (capacity < BigInt(t.request.amount)) throw new LaunchError(409, 'rate_limit', 'Arc outbound capacity would queue the token refill.')
        return prepared({ chain, chainId: c.chainId, executor: c.executor, operation, value: '0', fromBlock,
          calls: [call(L.canonical, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [L.hub.proxy, BigInt(t.request.amount)] })),
            call(L.hub.proxy, encodeFunctionData({ abi: nttAbi, functionName: 'transfer', args: [BigInt(t.request.amount), config.base.wormholeChainId, universal(t.request.recipient)] }))], expect: {} })
      }
      const vaa = db.query<{ vaa: string }, [string]>('SELECT vaa FROM evm_token_refill_vaas WHERE transfer=?').get(t.id)?.vaa
      if (!vaa) throw new Error('No authenticated finalized debit VAA is recorded.')
      const capacity = await clients.base.readContract({ address: L.spokeManager.proxy, abi: nttViewAbi, functionName: 'getCurrentInboundCapacity', args: [config.arc.wormholeChainId] })
      if (capacity < BigInt(t.request.amount)) throw new LaunchError(409, 'rate_limit', 'Base inbound capacity would queue the token refill.')
      return prepared({ chain, chainId: c.chainId, executor: c.executor, operation, value: '0', fromBlock,
        calls: [call(L.spokeManager.transceiver, encodeFunctionData({ abi: transceiverAbi, functionName: 'receiveMessage', args: [vaa as Hex] }))], expect: {} })
    },
    async observe(t, step, effect) {
      const p = parsePlan(effect, hash([t.id, step.id])); zeroFee(effect)
      const receipt = await sender.observe(p, effect.digest)
      if (receipt !== 'absent' && receipt !== 'pending') return step.id === 'lock:arc' ? locked(t, receipt, p.operation) : credited(t, receipt, p.operation, 'executor')
      if (receipt === 'pending' || step.id === 'lock:arc') return receipt
      const finalized = await sender.finalizedBlock('base')
      if (await executed(t, finalized)) {
        const [log] = await clients.base.getLogs({ address: launch(t.request.launch).spokeManager.proxy, event: nttViewAbi.find((e) => e.type === 'event' && e.name === 'TransferRedeemed')!,
          args: { digest: debitOf(t).details!.digest as Hex }, fromBlock: config.base.fromBlock, toBlock: finalized })
        if (!log) throw new Error('Finalized redemption has no matching log.')
        return credited(t, await clients.base.getTransactionReceipt({ hash: log.transactionHash }), p.operation, 'third-party')
      }
      return await executed(t, await clients.base.getBlockNumber({ cacheTime: 0 })) ? 'pending' : 'absent'
    },
    async broadcast(t, step, effect) {
      const p = parsePlan(effect, hash([t.id, step.id])); zeroFee(effect)
      if (step.id === 'mint:base' && await executed(t, await clients.base.getBlockNumber({ cacheTime: 0 }))) return
      await sender.broadcast(p, effect.digest)
    },
    validate(t, step, result) {
      if (result.amount !== t.request.amount || !same(result.details?.to ?? '', t.request.recipient)) throw new Error('Finalized refill amount or recipient differs from its request.')
      if (step.id === 'mint:base' && !same(result.details?.digest ?? '', debitOf(t).details!.digest)) throw new Error('Credit differs from the finalized canonical claim.')
    },
  }
}
