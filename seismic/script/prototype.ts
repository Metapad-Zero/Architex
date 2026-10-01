/**
 * LOCAL SEISMIC PROTOTYPE (49TH-44): the curve hub on `sanvil`, driven with real encrypted type-0x4A
 * transactions from seismic-viem. Deposits from Arc, Base, Solana and Robinhood arrive through the
 * LocalTestEndpoint — a labelled local stand-in for a messaging endpoint that authenticates nothing on
 * any source chain. Nothing here touches a public network.
 *
 *   cd seismic && sforge build && bun run prototype
 *
 * Writes ../output/equilibrium/seismic-prototype.json.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createPublicClient, createWalletClient, decodeAbiParameters, toFunctionSelector, encodeAbiParameters, encodePacked, http, keccak256, pad, parseEventLogs, toHex,
  type Abi, type Address, type Hex, type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createShieldedWalletClient, sanvil, shieldedWriteContractDebug, transparentWriteContract } from 'seismic-viem'

const ROOT = resolve(import.meta.dir, '..')
const OUT = resolve(ROOT, '../output/equilibrium')
const PORT = Number(process.env.SEISMIC_PROTOTYPE_PORT ?? 18960)
const RPC = `http://127.0.0.1:${PORT}`
const HUB_EID = 40456 // seismic-testnet EID as listed in LayerZero metadata; used here only as a label
const EIDS = { arc: 40434, base: 40245, solana: 40168, robinhood: 40451 } as const
type Spoke = keyof typeof EIDS
const PEERS = Object.fromEntries(Object.keys(EIDS).map((s) => [s, keccak256(toHex(`local-test-peer:${s}`))])) as Record<Spoke, Hex>
const USDC = keccak256(toHex('USDC'))
const ASSET = keccak256(toHex('EQL'))
const CURVE = { virtualQuote: 30_000_000_000n, virtualToken: 1_073_000_000_000_000n, allocation: 800_000_000_000_000n, graduationQuote: 85_000_000_000n }
const KEYS = {
  operator: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  bob: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  carol: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  dave: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
} as const satisfies Record<string, Hex>
type Who = keyof typeof KEYS

const artifact = (name: string) => JSON.parse(readFileSync(join(ROOT, 'out', `${name}.sol`, `${name}.json`), 'utf8')) as { abi: Abi; bytecode: { object: Hex } }
const hubArtifact = artifact('SeismicCurveHub')
const endpointArtifact = artifact('LocalTestEndpoint')
const hubAbi = hubArtifact.abi
const endpointAbi = endpointArtifact.abi
/**
 * How an observer decodes plaintext buy calldata: the selector is keccak of `buy(bytes32,suint256,suint256,uint256)`
 * (shielded type names are part of the signature), and the arguments are ordinary 32-byte words.
 */
function decodeBuy(data: Hex) {
  return { selector: data.slice(0, 10), args: decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], `0x${data.slice(10)}`) as unknown[] }
}

const evidence: Record<string, unknown> = { checkpoints: [] as unknown[] }
const checkpoint = (name: string, detail: unknown) => {
  (evidence.checkpoints as unknown[]).push({ name, detail: JSON.parse(JSON.stringify(detail, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) })
  console.log(`  ${name}`)
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

let node: ChildProcess
const state = join(mkdtempSync(join(tmpdir(), 'seismic-prototype-')), 'sanvil-state.json')
async function startNode(load: boolean) {
  node = spawn(join(process.env.HOME!, '.seismic/bin/sanvil'), ['--port', String(PORT), '--dump-state', state, ...(load ? ['--load-state', state] : []), '--silent'], { stdio: 'ignore' })
  const probe = createPublicClient({ transport: http(RPC) })
  for (let i = 0; i < 120; i++) {
    try { await probe.getChainId(); return } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  throw new Error('sanvil did not start')
}
async function stopNode() {
  const exited = new Promise((r) => node.once('exit', r))
  node.kill('SIGTERM')
  await exited
}

const chain = { ...sanvil, rpcUrls: { default: { http: [RPC] } } }
let pub: PublicClient
const plain = (who: Who) => createWalletClient({ account: privateKeyToAccount(KEYS[who]), chain, transport: http(RPC) })
const shielded: Partial<Record<Who, Awaited<ReturnType<typeof createShieldedWalletClient>>>> = {}
async function wallet(who: Who) {
  shielded[who] ??= await createShieldedWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(KEYS[who]) })
  return shielded[who]!
}
const addr = (who: Who) => privateKeyToAccount(KEYS[who]).address
const ERRORS = ['NotEndpoint', 'UnknownPeer', 'GuidMismatch', 'Replayed', 'BadMessage', 'UnknownCurve', 'CurveClosed', 'Expired', 'Insufficient', 'Slippage', 'SoldOut', 'AlreadySent', 'NotOwner']
const SELECTORS = Object.fromEntries(ERRORS.map((e) => [toFunctionSelector(`${e}()`), e]))
/** The custom error a mined transaction reverted with, from the node's call trace. */
async function revertOf(tx: Hex): Promise<string> {
  const trace = await pub.request({ method: 'debug_traceTransaction', params: [tx, { tracer: 'callTracer' }] } as never) as { output?: Hex; error?: string }
  const deepest = JSON.stringify(trace).match(/"output":"(0x[0-9a-f]{8})/g)?.map((m) => m.slice(-10)) ?? []
  for (const selector of deepest) if (SELECTORS[selector]) return SELECTORS[selector]
  return trace.error ?? 'reverted'
}
/**
 * A plain (non-0x4A) write with explicit gas, mined whether it succeeds or not. On Seismic an
 * unsigned eth_call or estimate runs with msg.sender = 0, so simulating as the caller is not
 * available; a refusal is a reverted transaction whose error is read from the node's trace.
 */
async function attempt(who: Who, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const receipt = await pub.waitForTransactionReceipt({ hash: await plain(who).writeContract({ address, abi, functionName, args, gas: 1_000_000n } as never) })
  return { receipt, error: receipt.status === 'success' ? null : await revertOf(receipt.transactionHash) }
}
async function send(who: Who, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const { receipt, error } = await attempt(who, address, abi, functionName, args)
  assert(!error, `${functionName} reverted (${error}) in ${receipt.transactionHash}`)
  return receipt
}

let hub: Address
let endpoint: Address
let curveId: Hex
/** The relayer's own journal of what it delivered. Lost on restart, on purpose. */
let relayed: { origin: { srcEid: number; sender: Hex; nonce: bigint }; guid: Hex; message: Hex }[] = []
const nonces: Record<Spoke, bigint> = { arc: 0n, base: 0n, solana: 0n, robinhood: 0n }

const guidOf = (origin: { srcEid: number; sender: Hex; nonce: bigint }) =>
  keccak256(encodePacked(['uint64', 'uint32', 'bytes32', 'uint32', 'bytes32'], [origin.nonce, origin.srcEid, origin.sender, HUB_EID, pad(hub)]))
const depositMessage = (depositId: string, amount: bigint, decimals: number, to: Address) =>
  encodeAbiParameters([{ type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'address' }], [1, keccak256(toHex(depositId)), USDC, amount, decimals, to])

/** Submit a relayer delivery, simulated first so a refusal is recorded with its custom error and nothing is sent. */
async function deliver(origin: { srcEid: number; sender: Hex; nonce: bigint }, guid: Hex, message: Hex): Promise<{ ok: true; tx: Hex; gas: bigint } | { ok: false; error: string; tx: Hex }> {
  const { receipt, error } = await attempt('operator', endpoint, endpointAbi, 'deliver', [hub, origin, guid, message])
  if (error) return { ok: false, error, tx: receipt.transactionHash }
  relayed.push({ origin, guid, message })
  return { ok: true, tx: receipt.transactionHash, gas: receipt.gasUsed }
}
async function deposit(spoke: Spoke, depositId: string, amount: bigint, decimals: number, to: Who, nonce?: bigint) {
  const origin = { srcEid: EIDS[spoke], sender: PEERS[spoke], nonce: nonce ?? ++nonces[spoke] }
  return { origin, ...(await deliver(origin, guidOf(origin), depositMessage(depositId, amount, decimals, addr(to)))) }
}

/** An encrypted buy. Explicit gas, so a failing check lands on chain as a reverted 0x4A transaction instead of failing estimation. */
async function buy(who: Who, quoteIn: bigint, minOut = 0n, deadline?: bigint) {
  const client = await wallet(who)
  const block = await pub.getBlock()
  const args = [curveId, quoteIn, minOut, deadline ?? block.timestamp + 600n] as const
  const { plaintextTx, txHash } = await shieldedWriteContractDebug(client, { address: hub, abi: hubAbi, functionName: 'buy', args, gas: 600_000n })
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  const raw = await pub.request({ method: 'eth_getTransactionByHash', params: [txHash] }) as { type: Hex; input: Hex }
  // sanvil leaves `type` off the transaction object; the receipt carries it.
  const rawReceipt = await pub.request({ method: 'eth_getTransactionReceipt', params: [txHash] }) as { type: Hex }
  return { raw, txHash, status: receipt.status, gasUsed: receipt.gasUsed, type: rawReceipt.type.toLowerCase(), encryptionFields: { nonce: (raw as Record<string, unknown>).encryptionNonce, pubkey: (raw as Record<string, unknown>).encryptionPubkey, expiresAtBlock: (raw as Record<string, unknown>).expiresAtBlock }, input: raw?.input, plaintext: plaintextTx.data, block: receipt.blockNumber, logs: receipt.logs }
}
/**
 * The curve as an observer who knows every trade would compute it. Used to know each buyer's exact
 * output, because signed reads are unavailable with this client/node pair (see the evidence).
 * Every figure it produces is then proved on chain: a withdrawal of exactly that amount succeeds and
 * one atom more is refused.
 */
const mirror = { reserve: 0n, sold: 0n }
function expectOut(q: bigint) { return (CURVE.virtualToken - mirror.sold) * q / (CURVE.virtualQuote + mirror.reserve + q) }
function record(q: bigint) { const out = expectOut(q); mirror.reserve += q; mirror.sold += out; return out }
const conserved = () => pub.readContract({ address: hub, abi: hubAbi, functionName: 'conserved', args: [curveId] }) as Promise<boolean>
const word = (value: bigint) => pad(toHex(value)).slice(2)

/** Solve two consecutive full-spend trades for the state before the first: o1 = A q1/(B+q1), o2 = (A-o1) q2/(B+q1+q2). */
function solveFromHistory(q1: bigint, o1: bigint, q2: bigint, o2: bigint) {
  const [Q1, O1, Q2, O2] = [q1, o1, q2, o2].map(Number)
  const B = (O2 * (Q1 + Q2)) / ((O1 * Q2) / Q1 - O2)
  return { A: (O1 * (B + Q1)) / Q1, B }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  await startNode(false)
  pub = createPublicClient({ chain, transport: http(RPC) }) as PublicClient
  try {
    const versions = { sanvil: 'anvil 1.3.5-v0.4.1 (15c65c8e7a87671ad7340d78001f3c68a597246f)', sforge: '1.3.5-v0.4.1 (15c65c8e7a87671ad7340d78001f3c68a597246f)', ssolc: '0.8.31-develop.2026.9.16+commit.98e187b6', seismicViem: '3.0.1', viem: '2.38.0' }
    Object.assign(evidence, { label: 'LOCAL ONLY: sanvil + LocalTestEndpoint. No public route, no LayerZero endpoint, no TEE attestation.', versions, rpc: RPC, eids: { hub: HUB_EID, ...EIDS }, peers: PEERS, curve: CURVE })

    // ---------------------------------------------------------------- deploy and wire
    const op = plain('operator')
    const deploy = async (abi: Abi, bytecode: Hex, args: unknown[]) => (await pub.waitForTransactionReceipt({ hash: await op.deployContract({ abi, bytecode, args } as never) })).contractAddress!
    endpoint = await deploy(endpointAbi, endpointArtifact.bytecode.object, [HUB_EID, addr('operator')])
    hub = await deploy(hubAbi, hubArtifact.bytecode.object, [endpoint, HUB_EID])
    for (const spoke of Object.keys(EIDS) as Spoke[]) await send('operator', hub, hubAbi, 'setPeer', [EIDS[spoke], PEERS[spoke]])
    await send('operator', hub, hubAbi, 'openCurve', [ASSET, USDC, CURVE.virtualQuote, CURVE.virtualToken, CURVE.allocation, CURVE.graduationQuote])
    curveId = await pub.readContract({ address: hub, abi: hubAbi, functionName: 'curveIdOf', args: [ASSET, USDC, CURVE.virtualQuote, CURVE.virtualToken, CURVE.allocation, CURVE.graduationQuote] }) as Hex
    checkpoint('deployed', { hub, endpoint, curveId })

    // ---------------------------------------------------------------- authenticated deposits from all four spokes
    const arc = await deposit('arc', 'arc-usdc-0001', 20_000_000_000n, 6, 'alice')
    const base = await deposit('base', 'base-usdc-0001', 100_000_000_000n, 6, 'bob')
    const solana = await deposit('solana', 'sol-usdc-0001', 5_000_000_000n, 6, 'carol')
    // Robinhood: two deposits for Dave, delivered out of order, the second in 18-decimal source units.
    const rh2 = await deposit('robinhood', 'rh-usdg-0002', 1_000_000_000_000_000_000_000n, 18, 'dave', 2n)
    const rh1 = await deposit('robinhood', 'rh-usdg-0001', 2_000_000_000n, 6, 'dave', 1n)
    nonces.robinhood = 2n
    assert([arc, base, solana, rh1, rh2].every((d) => d.ok), `a valid deposit was refused: ${JSON.stringify([arc, base, solana, rh1, rh2], (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`)
    const credited = await pub.readContract({ address: hub, abi: hubAbi, functionName: 'totalCredited', args: [USDC] }) as bigint
    assert(credited === 128_000_000_000n, `credited ${credited}, not 128,000 USDC`)
    checkpoint('deposits from Arc, Base, Solana, Robinhood (Robinhood reordered, 18-decimal source normalised)', { arc, base, solana, robinhood: [rh2, rh1], totalCredited: credited })

    // ---------------------------------------------------------------- refusals
    const replayPacket = await deliver(arc.origin, guidOf(arc.origin), depositMessage('arc-usdc-0001', 20_000_000_000n, 6, addr('alice')))
    const replayDeposit = await deposit('arc', 'arc-usdc-0001', 20_000_000_000n, 6, 'alice')
    const forgedPeer = await deliver({ srcEid: EIDS.arc, sender: PEERS.base, nonce: 50n }, guidOf({ srcEid: EIDS.arc, sender: PEERS.base, nonce: 50n }), depositMessage('forged-1', 1n, 6, addr('bob')))
    const unknownDomain = await deliver({ srcEid: 30101, sender: PEERS.arc, nonce: 1n }, guidOf({ srcEid: 30101, sender: PEERS.arc, nonce: 1n }), depositMessage('eth-1', 1n, 6, addr('bob')))
    const forgedGuid = await deliver({ srcEid: EIDS.arc, sender: PEERS.arc, nonce: 77n }, keccak256(toHex('forged')), depositMessage('arc-77', 1n, 6, addr('bob')))
    const dust = await deposit('robinhood', 'rh-dust', 1_000_000_000_000_000_001n, 18, 'dave')
    const directCall = (await attempt('bob', hub, hubAbi, 'lzReceive', [{ srcEid: EIDS.arc, sender: PEERS.arc, nonce: 99n }, guidOf({ srcEid: EIDS.arc, sender: PEERS.arc, nonce: 99n }), depositMessage('bob-self', 1_000_000_000_000n, 6, addr('bob')), addr('bob'), '0x'])).error ?? 'accepted'
    const refusals = { replayPacket, replayDeposit, forgedPeer, unknownDomain, forgedGuid, dust, directCallByNonEndpoint: directCall }
    assert(!replayPacket.ok && !replayDeposit.ok && !forgedPeer.ok && !unknownDomain.ok && !forgedGuid.ok && !dust.ok && directCall !== 'accepted', `a forged, replayed or malformed credit was accepted: ${JSON.stringify(refusals, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`)
    assert(await pub.readContract({ address: hub, abi: hubAbi, functionName: 'totalCredited', args: [USDC] }) === credited, 'a refused delivery changed the credited total')
    checkpoint('forged, replayed and malformed credits refused', refusals)

    // ---------------------------------------------------------------- encrypted buys (0x4A)
    const first = await buy('alice', 1_000_000_000n)
    assert(first.status === 'success', 'encrypted buy reverted')
    const aliceOut1 = record(1_000_000_000n)
    const plainArgs = decodeBuy(first.plaintext).args
    const leaksAmount = first.input.toLowerCase().includes(word(1_000_000_000n))
    const leaksPlaintext = first.input.toLowerCase().includes(first.plaintext.slice(10).toLowerCase())
    assert(first.type === '0x4a', `buy was sent as type ${first.type}, not 0x4a: ${JSON.stringify(first.raw)?.slice(0, 600)}`)
    assert(!leaksAmount && !leaksPlaintext, 'the encrypted calldata carries the plaintext amount')
    const unsigned = await pub.readContract({ address: hub, abi: hubAbi, functionName: 'myTokenBalance', args: [curveId], account: addr('alice') }) as bigint
    // What a node operator sees: sanvil is not a TEE, so its debug trace of the encrypted transaction is checked too.
    const trace = await pub.request({ method: 'debug_traceTransaction', params: [first.txHash, { tracer: 'callTracer' }] } as never) as { input?: Hex }
    const traceShowsPlaintext = String(trace.input ?? '').toLowerCase().includes(word(1_000_000_000n))
    checkpoint('encrypted buy on sanvil', { tx: first.txHash, type: first.type, encryptionFields: first.encryptionFields, inputBytes: (first.input.length - 2) / 2, plaintextBytes: (first.plaintext.length - 2) / 2,
      plaintextArgs: plainArgs, inputContainsAmountWord: leaksAmount, inputContainsPlaintext: leaksPlaintext, gasUsed: first.gasUsed, aliceTokensByCurve: aliceOut1,
      sameGetterUnsignedEthCall: unsigned, unsignedNote: 'Seismic runs an unsigned eth_call as msg.sender = 0, so the caller-scoped getter returns the zero address balance',
      localNodeDebugTraceShowsPlaintextAmount: traceShowsPlaintext, traceNote: 'sanvil exposes debug_traceTransaction with decrypted calldata; a TEE node must not expose this namespace' })

    // Public input footgun: the same function called with an ordinary transaction.
    const bobClient = await wallet('bob')
    const bobPlainTx = await transparentWriteContract(bobClient, { address: hub, abi: hubAbi, functionName: 'buy', args: [curveId, 2_000_000_000n, 0n, (await pub.getBlock()).timestamp + 600n], gas: 600_000n } as never)
    const bobPlainRaw = { ...(await pub.request({ method: 'eth_getTransactionByHash', params: [bobPlainTx] }) as { input: Hex }), type: ((await pub.request({ method: 'eth_getTransactionReceipt', params: [bobPlainTx] })) as { type: Hex }).type }
    const bobPlainReceipt = await pub.waitForTransactionReceipt({ hash: bobPlainTx })
    const exposed = decodeBuy(bobPlainRaw.input).args
    assert(exposed[1] === 2_000_000_000n, 'the plaintext call did not expose its amount, so this case is not showing the footgun')
    assert(bobPlainReceipt.status === 'success', 'the plaintext buy failed')
    record(2_000_000_000n)
    checkpoint('shielded parameters sent in a non-0x4A transaction are public', { tx: bobPlainTx, type: bobPlainRaw.type, status: bobPlainReceipt.status, decodedByObserver: exposed, gasUsed: bobPlainReceipt.gasUsed })

    // Repeated buys of different sizes: is gas a function of the amount?
    const repeated = []
    for (const q of [500_000_000n, 1_500_000_000n, 3_000_000_000n, 7_000_000n]) {
      const r = await buy('alice', q)
      assert(r.status === 'success' && r.type === '0x4a', 'repeated encrypted buy failed')
      repeated.push({ quoteIn: q, tokensOut: record(q), tx: r.txHash, gasUsed: r.gasUsed })
    }
    const gasValues = new Set(repeated.map((r) => r.gasUsed))
    checkpoint('repeated encrypted buys', { buys: repeated, distinctGasValues: [...gasValues], firstBuyGas: first.gasUsed })

    // Slippage and expiry: refused on chain as reverted 0x4A transactions.
    const highMin = await buy('alice', 100_000_000n, expectOut(100_000_000n) + 1n)
    const expired = await buy('alice', 100_000_000n, 0n, 1n)
    const overspend = await buy('alice', 20_000_000_000n)
    assert(highMin.status === 'reverted' && expired.status === 'reverted' && overspend.status === 'reverted', 'a slippage, expiry or overspend buy succeeded')
    const reasons = { slippage: await revertOf(highMin.txHash), expiry: await revertOf(expired.txHash), overspend: await revertOf(overspend.txHash) }
    assert(reasons.slippage === 'Slippage' && reasons.expiry === 'Expired' && reasons.overspend === 'Insufficient', `unexpected refusals ${JSON.stringify(reasons)}`)
    checkpoint('slippage (minimum one atom above the exact output), expiry and overspend refused', { slippage: { tx: highMin.txHash, gasUsed: highMin.gasUsed }, expiry: { tx: expired.txHash, gasUsed: expired.gasUsed },
      overspend: { tx: overspend.txHash, gasUsed: overspend.gasUsed }, reasons, note: 'Each revert is public, and its gas differs by which check failed: one bit per failed check is disclosed to everyone, and the error name to anyone who can trace.' })

    // Shielded storage is not readable over RPC.
    const reserveSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [curveId, 7n]))
    let storageRead: string
    try { storageRead = String(await pub.getStorageAt({ address: hub, slot: reserveSlot })) } catch (cause) { storageRead = `refused: ${String((cause as Error).message).split('\n')[0].slice(0, 160)}` }
    const storageMatchesReserve = storageRead.startsWith('0x') && BigInt(storageRead) === mirror.reserve
    checkpoint('eth_getStorageAt on the shielded reserve slot', { slot: reserveSlot, result: storageRead, matchesTheShieldedReserve: storageMatchesReserve,
      note: storageMatchesReserve ? 'sanvil returns the plaintext of a shielded slot: local evidence cannot show storage confidentiality, which rests on a TEE node blocking this read' : 'the read did not return the shielded value' })

    // ---------------------------------------------------------------- observer reconstruction from public history
    // Two consecutive full-spend trades with public deposits and public withdrawals reveal the state.
    const reserveBeforeHistory = mirror.reserve
    const soldBeforeHistory = mirror.sold
    const carolBuy = await buy('carol', 5_000_000_000n)
    const carolTokens = record(5_000_000_000n)
    const daveBuy = await buy('dave', 3_000_000_000n)
    const daveTokens = record(3_000_000_000n)
    assert(carolBuy.status === 'success' && daveBuy.status === 'success', 'history buys failed')
    const daveAgain = await buy('dave', 1n)
    assert(daveAgain.status === 'reverted' && await revertOf(daveAgain.txHash) === 'Insufficient', 'Dave holds quote beyond his two deposits (reordered and normalised to exactly 3,000 USDC)')
    assert(await conserved(), 'not conserved after the buys')
    return { carolTokens, daveTokens, reserveBeforeHistory, soldBeforeHistory, aliceTokens: aliceOut1 + repeated.reduce((n, r) => n + r.tokensOut, 0n) }
  } catch (cause) {
    await stopNode().catch(() => undefined)
    throw cause
  }
}

async function second({ carolTokens, daveTokens, reserveBeforeHistory, soldBeforeHistory, aliceTokens }: { carolTokens: bigint; daveTokens: bigint; reserveBeforeHistory: bigint; soldBeforeHistory: bigint; aliceTokens: bigint }) {
  // ---------------------------------------------------------------- withdrawals: public amounts, unavailable destination, retry
  await send('operator', endpoint, endpointAbi, 'setAvailable', [false])
  const queued = await send('carol', hub, hubAbi, 'withdraw', [curveId, carolTokens, EIDS.base, pad(addr('carol'))])
  const [queuedLog] = parseEventLogs({ abi: hubAbi, logs: queued.logs, eventName: 'WithdrawalQueued' }) as unknown as { args: { id: Hex; amount: bigint } }[]
  const id = queuedLog.args.id
  const pendingWhileDown = await pub.readContract({ address: hub, abi: hubAbi, functionName: 'pendingOutbound', args: [curveId] }) as bigint
  const retryWhileDown = (await attempt('carol', hub, hubAbi, 'retry', [id])).error ?? 'accepted'
  assert(pendingWhileDown === carolTokens && retryWhileDown !== 'accepted' && await conserved(), 'the unavailable destination lost or double-counted the pending claim')
  await send('operator', endpoint, endpointAbi, 'setAvailable', [true])
  const retried = await send('carol', hub, hubAbi, 'retry', [id])
  const packets = parseEventLogs({ abi: endpointAbi, logs: retried.logs, eventName: 'PacketSent' }) as unknown as { args: { message: Hex } }[]
  const retryAgain = (await attempt('carol', hub, hubAbi, 'retry', [id])).error ?? 'accepted'
  assert(packets.length === 1 && retryAgain === 'AlreadySent', 'the retry did not send exactly once')
  const daveOver = await attempt('dave', hub, hubAbi, 'withdraw', [curveId, daveTokens + 1n, EIDS.solana, pad(addr('dave'))])
  assert(daveOver.error === 'Insufficient', 'Dave could withdraw one atom more than the curve gave him')
  const daveOut = await send('dave', hub, hubAbi, 'withdraw', [curveId, daveTokens, EIDS.solana, pad(addr('dave'))])
  checkpoint('unavailable destination: pending claim kept, retried once', { id, pendingWhileDown, retryWhileDown, retryTx: retried.transactionHash, packetPayload: packets[0].args.message, retryAgain, conserved: await conserved() })

  // (b) continued: the observer sees Carol's and Dave's public deposits and public withdrawals, and nothing else.
  const fromHistory = solveFromHistory(5_000_000_000n, carolTokens, 3_000_000_000n, daveTokens)
  const historyError = Math.abs(fromHistory.B - Number(CURVE.virtualQuote) - Number(reserveBeforeHistory))
  checkpoint('observer reconstruction from public deposits and withdrawals', { publicInputs: { carol: { deposit: 5_000_000_000n, withdrawn: carolTokens }, dave: { deposit: 3_000_000_000n, withdrawn: daveTokens, tx: daveOut.transactionHash } },
    assumption: 'both buyers spent their whole deposit in one buy, which the observer cannot verify but can guess from timing',
    recoveredReserveBeforeCarol: Math.round(fromHistory.B - Number(CURVE.virtualQuote)), trueReserveBeforeCarol: reserveBeforeHistory, absoluteErrorAtoms: historyError,
    recoveredSoldBeforeCarol: Math.round(Number(CURVE.virtualToken) - fromHistory.A), trueSoldBeforeCarol: soldBeforeHistory,
    exactAmountsProved: 'each withdrawal of the curve output succeeded and one atom more was refused' })
  assert(historyError / Number(reserveBeforeHistory) < 0.001, 'the public history did not reconstruct the shielded reserve')

  // ---------------------------------------------------------------- graduation
  const before = await pub.getBlockNumber()
  // One buy past the allocation is refused: the curve never sells more than the inventory it holds.
  const tooBig = await buy('bob', 90_000_000_000n)
  assert(tooBig.status === 'reverted' && await revertOf(tooBig.txHash) === 'SoldOut', 'a buy beyond the curve allocation was accepted')
  const big = await buy('bob', 69_000_000_000n)
  record(69_000_000_000n)
  const graduated = parseEventLogs({ abi: hubAbi, logs: big.logs, eventName: 'Graduated' })
  const after = await buy('alice', 1_000_000n)
  const curveState = await pub.readContract({ address: hub, abi: hubAbi, functionName: 'curves', args: [curveId] }) as unknown[]
  assert(big.status === 'success' && graduated.length === 1 && after.status === 'reverted' && curveState[7] === true, 'graduation did not fire once and close the curve')
  checkpoint('allocation cap, then graduation once, keyed by curve id', { beyondAllocation: { tx: tooBig.txHash, quoteIn: 90_000_000_000n, refusal: 'SoldOut' }, quoteIn: 69_000_000_000n, reserveAfter: mirror.reserve, soldAfter: mirror.sold, allocation: CURVE.allocation, tx: big.txHash, gasUsed: big.gasUsed, graduatedEvents: graduated.length, fromBlock: before, buyAfterGraduation: { tx: after.txHash, status: after.status }, conserved: await conserved() })

  // ---------------------------------------------------------------- node and relayer restart
  const before2 = { credited: await pub.readContract({ address: hub, abi: hubAbi, functionName: 'totalCredited', args: [USDC] }) as bigint, block: await pub.getBlockNumber() }
  const journal = relayed
  await stopNode()
  await startNode(true)
  relayed = []
  for (const who of Object.keys(shielded) as Who[]) delete shielded[who]
  const replays = []
  for (const packet of journal) replays.push(await deliver(packet.origin, packet.guid, packet.message))
  const after2 = { credited: await pub.readContract({ address: hub, abi: hubAbi, functionName: 'totalCredited', args: [USDC] }) as bigint, block: await pub.getBlockNumber() }
  assert(replays.every((r) => !r.ok && r.error === 'Replayed'), `a delivery was credited again after restart: ${JSON.stringify(replays.map((r) => (r.ok ? 'ACCEPTED' : r.error)))}`)
  assert(after2.credited === before2.credited && await conserved(), 'state changed across the restart')
  // Shielded balances survived the restart exactly: Alice can withdraw everything the curve gave her, and not one atom more.
  const aliceOver = await attempt('alice', hub, hubAbi, 'withdraw', [curveId, aliceTokens + 1n, EIDS.arc, pad(addr('alice'))])
  const aliceAll = await attempt('alice', hub, hubAbi, 'withdraw', [curveId, aliceTokens, EIDS.arc, pad(addr('alice'))])
  assert(aliceOver.error === 'Insufficient' && aliceAll.error === null && await conserved(), 'Alice\'s shielded balance did not survive the restart exactly')
  checkpoint('sanvil restarted from dumped state; relayer restarted with an empty journal and redelivered everything', { before: before2, after: after2, redelivered: journal.length, refused: replays.map((r) => (r.ok ? 'ACCEPTED' : r.error)),
    aliceWithdrawsExactBalanceAfterRestart: { amount: aliceTokens, tx: aliceAll.receipt.transactionHash, oneAtomMore: aliceOver.error } })

  // ---------------------------------------------------------------- the observer table, from logs
  const logs = await pub.getLogs({ address: [hub, endpoint], fromBlock: 0n })
  const decoded = parseEventLogs({ abi: [...hubAbi, ...endpointAbi], logs }) as unknown as { eventName: string; args: Record<string, unknown> }[]
  const byEvent: Record<string, { count: number; fields: string[] }> = {}
  for (const log of decoded) {
    byEvent[log.eventName] ??= { count: 0, fields: Object.keys(log.args) }
    byEvent[log.eventName].count++
  }
  evidence.logs = byEvent
}

const result = await main()
try { await second(result) } finally { await stopNode().catch(() => undefined) }
writeFileSync(join(OUT, 'seismic-prototype.json'), JSON.stringify(evidence, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n')
console.log('All checks passed. Evidence written to output/equilibrium/seismic-prototype.json')
