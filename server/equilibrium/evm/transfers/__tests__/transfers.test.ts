import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { concat, encodePacked, keccak256, numberToHex, pad, recoverAddress, slice, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hash } from '../../../request'
import { CCTP_TESTNET, STANDARD, assertAttestedFrom, bytes32, iris, localAttester, parseMessage } from '../cctp'
import { TRANSFER_FILES, transferApprovalDigest, transferRoutes } from '../config'
import { CODE_FILES } from '../../approval'
import { managerDigest, parseTransfer } from '../ntt'
import { createTransfer, runTransfer } from '../runner'
import { TransferStore } from '../store'
import type { Transfer } from '../types'
import type { EvmAdapterConfig } from '../../types'
import { localGuardian } from '../../vaa'

const A = (n: number): Hex => `0x${n.toString(16).padStart(40, '0')}`
const u = (n: number) => pad(A(n), { size: 32 })
const failure = async (p: Promise<unknown>) => { try { await p } catch (cause) { return String(cause) } return 'resolved' }

/** An NTT transfer exactly as WormholeTransceiver publishes it. */
function nttPayload(amount: bigint, extra: Hex = '0x') {
  const inner = concat(['0x994e5454', numberToHex(6, { size: 1 }), numberToHex(amount, { size: 8 }), u(3), u(4), numberToHex(71, { size: 2 }), extra])
  const manager = concat([keccak256('0x01'), u(5), numberToHex((inner.length - 2) / 2, { size: 2 }), inner])
  return concat(['0x9945ff10', u(1), u(2), numberToHex((manager.length - 2) / 2, { size: 2 }), manager, numberToHex(0, { size: 2 })])
}
/** A MessageV2 + BurnMessageV2 as the source MessageTransmitterV2 emits it: nonce, finality and fee empty. */
function emitted(amount = 2_000_000n) {
  const header = concat([numberToHex(1, { size: 4 }), numberToHex(26, { size: 4 }), numberToHex(6, { size: 4 }), pad('0x0', { size: 32 }), bytes32(CCTP_TESTNET.arc.tokenMessenger), bytes32(CCTP_TESTNET.base.tokenMessenger), u(9), numberToHex(STANDARD, { size: 4 }), numberToHex(0, { size: 4 })])
  const body = concat([numberToHex(1, { size: 4 }), bytes32(CCTP_TESTNET.arc.usdc), u(9), numberToHex(amount, { size: 32 }), u(8), numberToHex(0, { size: 32 }), numberToHex(0, { size: 32 }), numberToHex(0, { size: 32 })])
  return concat([header, body])
}

describe('NTT transfer payloads', () => {
  test('parse the wire format and derive the manager replay digest', () => {
    const t = parseTransfer(nttPayload(1_500_000_000n))
    expect(t).toMatchObject({ sourceManager: u(1), recipientManager: u(2), sender: u(5), decimals: 6, amount: 1_500_000_000n, sourceToken: u(3), to: u(4), toChain: 71 })
    expect(managerDigest(10004, t)).toBe(keccak256(encodePacked(['uint16', 'bytes'], [10004, t.managerMessage])))
  })
  test('refuse other prefixes, truncation and additional payloads', () => {
    const good = nttPayload(1n)
    expect(() => parseTransfer(`0x00${good.slice(4)}`)).toThrow('Not a Wormhole transceiver message')
    expect(() => parseTransfer(good.slice(0, -2) as Hex)).toThrow()
    expect(() => parseTransfer(nttPayload(1n, '0x0001ff'))).toThrow()
  })
})

describe('CCTP V2 messages', () => {
  test('the local attester fills only what Circle fills and signs keccak256(message) as the real attesters do', async () => {
    const key = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex
    const m = emitted()
    const a = (await localAttester(key).attested({ sourceDomain: 26, transaction: hash('tx'), message: m }))!
    assertAttestedFrom(m, a.message)
    const parsed = parseMessage(a.message)
    expect(parsed.finalityThresholdExecuted).toBe(STANDARD)
    expect(parsed.body.amount).toBe(2_000_000n)
    const signer = await recoverAddress({ hash: keccak256(a.message), signature: a.attestation })
    expect(signer).toBe(privateKeyToAccount(key).address)
  })
  test('an attested message that changes what the burn decided is refused', async () => {
    const m = emitted()
    const a = (await localAttester('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a').attested({ sourceDomain: 26, transaction: hash('tx'), message: m }))!
    const moreAmount = concat([slice(a.message, 0, 148 + 68), numberToHex(3_000_000n, { size: 32 }), slice(a.message, 148 + 100)])
    const otherCaller = concat([slice(a.message, 0, 108), u(7), slice(a.message, 140)])
    const noNonce = concat([slice(a.message, 0, 12), pad('0x0', { size: 32 }), slice(a.message, 44)])
    const fast = concat([slice(a.message, 0, 144), numberToHex(1000, { size: 4 }), slice(a.message, 148)])
    expect(() => assertAttestedFrom(m, moreAmount)).toThrow('differs from the finalized burn')
    expect(() => assertAttestedFrom(m, otherCaller)).toThrow('differs from the finalized burn')
    expect(() => assertAttestedFrom(m, noNonce)).toThrow('no nonce')
    expect(() => assertAttestedFrom(m, fast)).toThrow('hard finality')
  })
  test('Iris: 404 and pending are not attested; a complete attestation of this burn is', async () => {
    const m = emitted()
    const a = (await localAttester('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a').attested({ sourceDomain: 26, transaction: hash('tx'), message: m }))!
    const reply = (status: number, body: unknown) => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch
    const burn = { sourceDomain: 26, transaction: hash('tx'), message: m }
    expect(await iris('https://iris', reply(404, {})).attested(burn)).toBeNull()
    expect(await iris('https://iris', reply(200, { messages: [{ message: '0x', attestation: 'PENDING', status: 'pending_confirmations' }] })).attested(burn)).toBeNull()
    expect(await iris('https://iris', reply(200, { messages: [{ ...a, status: 'complete' }] })).attested(burn)).toEqual(a)
    // Someone else's message in the same response is never taken for this burn.
    const other = (await localAttester('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a').attested({ sourceDomain: 26, transaction: hash('tx'), message: emitted(5n) }))!
    expect(await iris('https://iris', reply(200, { messages: [{ ...other, status: 'complete' }] })).attested(burn)).toBeNull()
    expect(await failure(iris('https://iris', reply(500, {})).attested(burn))).toContain('Iris 500')
  })
})

describe('transfer records and routes', () => {
  const chain = (name: 'arc' | 'base') => ({ chain: name, rpc: 'http://127.0.0.1:9', chainId: name === 'arc' ? 5042002 : 84532, wormholeChainId: name === 'arc' ? 71 : 10004, core: A(1), executor: A(name === 'arc' ? 2 : 3),
    transceiverStructs: A(4), usdc: CCTP_TESTNET[name].usdc, finality: 0 as const, usdcAtomsPerNative: 1n, venue: { kind: 'architex' as const, factory: A(5) }, fromBlock: 0n })
  const config: EvmAdapterConfig = { mode: 'fork', operatorKey: `0x${'11'.repeat(32)}`, arc: chain('arc'), base: chain('base'), vaa: localGuardian(`0x${'22'.repeat(32)}`, 0),
    limits: { outbound: 1n, inbound: 1n }, budgets: { payment: '1', canonical: '1', manager: '1', debit: '1', credit: '1', pool: '1' } }

  test('a stale worker cannot overwrite newer progress, and a leased transfer cannot be claimed twice', () => {
    const store = new TransferStore(new Database(':memory:'), 1000)
    const t: Transfer = { id: hash('t'), identity: hash('i'), kind: 'refill', version: 'v', request: {}, steps: [], state: 'running', revision: 0, createdAt: 0 }
    store.insert(t)
    const a = store.claim(t.id, 'a', 0)
    expect(() => store.claim(t.id, 'b', 10)).toThrow('Another worker holds')
    // A heartbeat keeps the lease: past the original expiry, b still cannot claim.
    store.renew(t.id, 'a', 900)
    expect(() => store.claim(t.id, 'b', 1500)).toThrow('Another worker holds')
    expect(() => store.renew(t.id, 'b', 1500)).toThrow('lease was lost')
    // Lease expires; b claims and writes; a's late write is refused.
    const b = store.claim(t.id, 'b', 3000)
    store.save({ ...b, error: 'b' }, 'b', 3001)
    expect(() => store.renew(t.id, 'a', 3002)).toThrow('lease was lost')
    expect(() => store.save({ ...a, error: 'a' }, 'a', 3002)).toThrow('lease or revision')
    expect(store.get(t.id)!.error).toBe('b')
    expect(() => store.insert({ ...t, id: hash('other') })).toThrow('different request')
  })

  test('requests are strict, closed rails stay closed, and fork-only attesters refuse a testnet configuration', async () => {
    const db = new Database(':memory:')
    const { returns, refill } = transferRoutes(config, { returns: { maxPerTransfer: '10' }, refill: { attestation: { kind: 'local-attester' }, maxPerTransfer: '10', maxTotal: '10' } }, db, () => undefined, { EQUILIBRIUM_FORK_ATTESTER_KEY: `0x${'33'.repeat(32)}` })
    expect(() => refill!.parse({ kind: 'refill', requestId: 'refill-0001', from: 'arc', to: 'robinhood', amount: '1', maxFee: '0' })).toThrow('stays closed')
    expect(() => refill!.parse({ kind: 'refill', requestId: 'refill-0001', from: 'solana', to: 'base', amount: '1', maxFee: '0' })).toThrow('49TH-26')
    expect(() => refill!.parse({ kind: 'refill', requestId: 'refill-0001', from: 'arc', to: 'arc', amount: '1', maxFee: '0' })).toThrow('between the Arc and Base')
    expect(() => refill!.parse({ kind: 'refill', requestId: 'refill-0001', from: 'arc', to: 'base', amount: '1', maxFee: '5' })).toThrow('zero-fee')
    expect(() => returns.parse({ kind: 'return', source: 'executor', requestId: 'r', launch: hash('l'), amount: '1', recipient: A(1) })).toThrow('requestId')
    expect(() => returns.parse({ kind: 'return', source: 'holder', launch: hash('l'), transaction: '0x12' })).toThrow('transaction')
    // Two requests for one holder burn share an identity whatever else differs.
    expect(returns.identity(returns.parse({ kind: 'return', source: 'holder', launch: hash('l'), transaction: hash('tx') }))).toBe(returns.identity(returns.parse({ kind: 'return', source: 'holder', launch: hash('m'), transaction: hash('tx') })))
    expect(() => transferRoutes({ ...config, mode: 'testnet' }, { returns: { maxPerTransfer: '1' }, operatorGas: { arc: '1', base: '1' }, refill: { attestation: { kind: 'local-attester' }, maxPerTransfer: '1', maxTotal: '1' } }, db, () => undefined, { EQUILIBRIUM_FORK_ATTESTER_KEY: `0x${'33'.repeat(32)}` })).toThrow('fork-only')
    expect(() => transferRoutes({ ...config, mode: 'testnet' }, { returns: { maxPerTransfer: '1' } }, db, () => undefined)).toThrow('operator gas caps')
    // A return against a launch this store does not hold is refused before anything is recorded.
    const store = new TransferStore(db)
    expect(await failure(createTransfer(store, returns, { kind: 'return', source: 'holder', launch: hash('l'), transaction: hash('tx') }, 0))).toContain('completed launch')
    expect(store.list()).toEqual([])
    expect(await failure(runTransfer(store, returns, hash('none')))).toContain('Unknown transfer')
  })

  test('the transfer approval binds the launch configuration, the settings and the code', () => {
    const a = transferApprovalDigest('{"mode":"testnet"}', '{"returns":{}}')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(transferApprovalDigest('{"mode":"testnet"}', '{"returns":{}}')).toBe(a)
    expect(transferApprovalDigest('{"mode":"testnet"}', '{"returns":{"x":1}}')).not.toBe(a)
    expect(transferApprovalDigest('{"mode":"testnet "}', '{"returns":{}}')).not.toBe(a)
  })

  test('editing any shared send-path file invalidates a transfer approval', () => {
    // Everything the launch approval binds is on the transfer path too: ids, request hashing, the store, config parsing, types, the adapter.
    for (const file of CODE_FILES) expect(TRANSFER_FILES as readonly string[]).toContain(file)
    for (const file of ['server/equilibrium/request.ts', 'server/equilibrium/evm/config.ts', 'server/equilibrium/store.ts', 'server/equilibrium/types.ts', 'server/equilibrium/evm/types.ts', 'server/equilibrium/evm/adapter.ts']) {
      expect(TRANSFER_FILES as readonly string[]).toContain(file)
    }
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    const root = mkdtempSync(join(process.cwd(), 'output', 'approval-'))
    try {
      for (const file of TRANSFER_FILES) { mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(file, join(root, file)) }
      const approved = transferApprovalDigest('{"mode":"testnet"}', '{"returns":{}}', root)
      expect(approved).toBe(transferApprovalDigest('{"mode":"testnet"}', '{"returns":{}}'))
      for (const file of ['server/equilibrium/request.ts', 'server/equilibrium/evm/config.ts', 'server/equilibrium/store.ts', 'server/equilibrium/evm/types.ts', 'server/equilibrium/evm/transfers/executor.ts']) {
        const original = readFileSync(join(root, file))
        appendFileSync(join(root, file), '\n// edited\n')
        expect([file, transferApprovalDigest('{"mode":"testnet"}', '{"returns":{}}', root) === approved]).toEqual([file, false])
        cpSync(file, join(root, file))
        expect(readFileSync(join(root, file))).toEqual(original)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('the fork stand-in bundle is built without checkout-dependent remappings and carries its own hash', () => {
    const bundle = JSON.parse(readFileSync('server/equilibrium/evm/transfers/fork-bytecode.json', 'utf8')) as { build: { autoDetectRemappings: boolean; remappings: string[] }; ForkUsdcCctp: { bytecode: string; sha256: string } }
    expect(bundle.build.autoDetectRemappings).toBe(false)
    // Metadata hashes these; an absolute path would make the bytecode depend on where the repository is checked out.
    for (const r of bundle.build.remappings) expect(r).not.toMatch(/(^|[:=])\//)
    expect(createHash('sha256').update(bundle.ForkUsdcCctp.bytecode).digest('hex')).toBe(bundle.ForkUsdcCctp.sha256)
    // The CBOR metadata trailer is part of the bundle and of the check, not stripped.
    expect(bundle.ForkUsdcCctp.bytecode).toMatch(/a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033$/)
  })
})
