import { decodeFunctionResult, encodeFunctionData, isAddress, keccak256, pad, parseAbi, type Abi, type Address, type Hex } from 'viem'
import { NETWORKS } from '../../src/lib/equilibriumNetwork'

export const AUDIT_ABI: Abi = parseAbi([
  'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)', 'function minter() view returns (address)',
  'function supplyCap() view returns (uint64)', 'function token() view returns (address)',
  'function mode() view returns (uint8)', 'function chainId() view returns (uint16)',
  'function owner() view returns (address)', 'function pauser() view returns (address)',
  'function isPaused() view returns (bool)', 'function getThreshold() view returns (uint8)',
  'function getTransceivers() view returns (address[])',
  'function getPeer(uint16) view returns (bytes32 peerAddress, uint8 tokenDecimals)',
  'function getWormholePeer(uint16) view returns (bytes32)',
  'function nttManager() view returns (address)', 'function wormhole() view returns (address)',
  'function consistencyLevel() view returns (uint8)',
])
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
type Chain = 'arc' | 'base'
interface ContractPin { address: Address; codeHash: Hex }
interface ProxyPin extends ContractPin { implementationHash: Hex }
export interface AuditEndpoint {
  chain: Chain; rpc: string; owner: Address; pauser: Address
  token: ContractPin; manager: ProxyPin; transceiver: ProxyPin
}
export interface AuditManifest {
  schema: 1; mode: 'testnet' | 'live'; issuance: string; maxAgeSeconds: number
  endpoints: [AuditEndpoint, AuditEndpoint]
}
export interface AuditReader { request(method: string, params: unknown[]): Promise<unknown> }
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected manifest object')
  return raw as Record<string, unknown>
}
function address(raw: unknown): Address {
  if (typeof raw !== 'string' || !isAddress(raw) || /^0x0+$/.test(raw)) throw new Error('A deployed nonzero address is required')
  return raw.toLowerCase() as Address
}
function digest(raw: unknown): Hex {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw) || /^0x0+$/.test(raw)) throw new Error('An approved nonzero runtime code hash is required')
  return raw.toLowerCase() as Hex
}
function pin(raw: unknown): ContractPin {
  const p = record(raw)
  return { address: address(p.address), codeHash: digest(p.codeHash) }
}
function proxy(raw: unknown): ProxyPin { return { ...pin(raw), implementationHash: digest(record(raw).implementationHash) } }
/** Validate the complete manifest before contacting any endpoint. No env flag creates addresses or approval. */
export function parseAuditManifest(raw: unknown): AuditManifest {
  const m = record(raw)
  if (m.schema !== 1 || (m.mode !== 'testnet' && m.mode !== 'live')) throw new Error('Audit schema 1 and testnet/live mode are required')
  if (typeof m.issuance !== 'string' || !/^[1-9]\d{0,19}$/.test(m.issuance) || BigInt(m.issuance) > 18446744073709551615n) throw new Error('Issuance must be positive uint64 atoms')
  if (!Number.isSafeInteger(m.maxAgeSeconds) || Number(m.maxAgeSeconds) < 1 || Number(m.maxAgeSeconds) > 86400) throw new Error('Finalized block age limit must be 1–86400 seconds')
  if (!Array.isArray(m.endpoints) || m.endpoints.length !== 2) throw new Error('This verifier requires exactly Arc and Base')
  const endpoints = m.endpoints.map((raw): AuditEndpoint => {
    const e = record(raw)
    if (e.chain !== 'arc' && e.chain !== 'base') throw new Error('Only the Arc/Base pilot is supported')
    if (typeof e.rpc !== 'string') throw new Error('RPC URL required')
    const url = new URL(e.rpc)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS RPC without embedded credentials or query secrets')
    return { chain: e.chain, rpc: e.rpc, owner: address(e.owner), pauser: address(e.pauser), token: pin(e.token), manager: proxy(e.manager), transceiver: proxy(e.transceiver) }
  }).sort((a, b) => Number(a.chain === 'base') - Number(b.chain === 'base'))
  if (endpoints[0].chain !== 'arc' || endpoints[1].chain !== 'base') throw new Error('Distinct Arc and Base endpoints are required')
  for (const e of endpoints) if (new Set([e.token.address, e.manager.address, e.transceiver.address]).size !== 3) throw new Error('Token, manager and transceiver must be distinct contracts')
  return { schema: 1, mode: m.mode, issuance: m.issuance, maxAgeSeconds: Number(m.maxAgeSeconds), endpoints: endpoints as [AuditEndpoint, AuditEndpoint] }
}
export function rpcAuditReader(url: string): AuditReader {
  return { async request(method, params) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
    const body = record(await response.json())
    if (body.error || body.result === undefined) throw new Error(`RPC ${method} did not return verifiable evidence`)
    return body.result
  } }
}
function hex(raw: unknown): Hex {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]*$/.test(raw)) throw new Error('Invalid RPC hex evidence')
  return raw.toLowerCase() as Hex
}
function equal(actual: unknown, expected: unknown, label: string) {
  if (JSON.stringify(actual).toLowerCase() !== JSON.stringify(expected).toLowerCase()) throw new Error(`${label} differs from the approved manifest/configuration`)
}
function unsigned(raw: unknown): bigint {
  if (typeof raw !== 'bigint' || raw < 0n) throw new Error('Invalid supply evidence')
  return raw
}
async function completeReads(reads: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(reads)
  const failure = results.find((r) => r.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason instanceof Error ? failure.reason : new Error('RPC evidence read failed')
}
interface Observation {
  chain: Chain; chainId: number; blockNumber: Hex; blockHash: Hex; timestamp: number
  supply: string; custody: string; authoritiesVerified: true; implementationsVerified: true
}
async function observeEndpoint(m: AuditManifest, e: AuditEndpoint, other: AuditEndpoint, reader: AuditReader, now: number): Promise<Observation> {
  const network = NETWORKS.find((n) => n.chain === e.chain)![m.mode === 'live' ? 'mainnet' : 'testnet']
  const peerNetwork = NETWORKS.find((n) => n.chain === other.chain)![m.mode === 'live' ? 'mainnet' : 'testnet']
  equal(Number(BigInt(hex(await reader.request('eth_chainId', [])))), network.id, 'RPC chain ID')
  const block = record(await reader.request('eth_getBlockByNumber', ['finalized', false]))
  const number = hex(block.number); const blockHash = digest(block.hash)
  const timestamp = Number(BigInt(hex(block.timestamp)))
  if (!Number.isSafeInteger(timestamp) || timestamp > now + 30 || now - timestamp > m.maxAgeSeconds) throw new Error('Finalized observation is stale or has a future timestamp')
  const call = async (at: Address, name: string, args: unknown[] = []) => decodeFunctionResult({ abi: AUDIT_ABI, functionName: name,
    data: hex(await reader.request('eth_call', [{ to: at, data: encodeFunctionData({ abi: AUDIT_ABI, functionName: name, args }) }, number])) })
  const code = async (at: Address, expected: Hex) => {
    const bytes = hex(await reader.request('eth_getCode', [at, number]))
    if (bytes === '0x' || bytes.length % 2 !== 0) throw new Error('Deployed contract bytecode is missing')
    equal(keccak256(bytes), expected, 'Runtime bytecode hash')
  }
  await completeReads([code(e.token.address, e.token.codeHash), ...[e.manager, e.transceiver].map(async (p) => {
    await code(p.address, p.codeHash)
    const slot = hex(await reader.request('eth_getStorageAt', [p.address, IMPLEMENTATION_SLOT, number]))
    if (!/^0x0{24}[0-9a-f]{40}$/.test(slot)) throw new Error('Invalid EIP-1967 implementation slot')
    await code(address(`0x${slot.slice(-40)}`), p.implementationHash)
  })])
  const checks: [Address, string, unknown, unknown[]?][] = [
    [e.token.address, 'decimals', 6], [e.manager.address, 'token', e.token.address],
    [e.manager.address, 'mode', e.chain === 'arc' ? 0 : 1], [e.manager.address, 'chainId', network.wormholeId],
    [e.manager.address, 'owner', e.owner], [e.manager.address, 'pauser', e.pauser], [e.manager.address, 'isPaused', false],
    [e.manager.address, 'getThreshold', 1], [e.manager.address, 'getTransceivers', [e.transceiver.address]],
    [e.manager.address, 'getPeer', [pad(other.manager.address), 6], [peerNetwork.wormholeId]],
    [e.transceiver.address, 'owner', e.owner], [e.transceiver.address, 'pauser', e.pauser], [e.transceiver.address, 'isPaused', false],
    [e.transceiver.address, 'nttManager', e.manager.address],
    [e.transceiver.address, 'wormhole', network.core], [e.transceiver.address, 'consistencyLevel', 0],
    [e.transceiver.address, 'getWormholePeer', pad(other.transceiver.address), [peerNetwork.wormholeId]],
  ]
  if (e.chain === 'base') checks.push([e.token.address, 'minter', e.manager.address])
  await completeReads(checks.map(async ([at, name, expected, args]) => equal(await call(at, name, args), expected, `${e.chain} ${name}`)))
  const supply = unsigned(await call(e.token.address, 'totalSupply'))
  const custody = e.chain === 'arc' ? unsigned(await call(e.token.address, 'balanceOf', [e.manager.address])) : 0n
  if (e.chain === 'arc' && supply !== BigInt(m.issuance)) throw new Error('Canonical issuance differs from the fixed approved supply')
  if (e.chain === 'base' && unsigned(await call(e.token.address, 'supplyCap')) !== BigInt(m.issuance)) throw new Error('Spoke supply cap differs from the canonical issuance')
  const sameBlock = record(await reader.request('eth_getBlockByNumber', [number, false]))
  equal(hex(sameBlock.hash), blockHash, 'Finalized block hash after reads')
  return { chain: e.chain, chainId: Number(network.id), blockNumber: number, blockHash, timestamp, supply: supply.toString(), custody: custody.toString(), authoritiesVerified: true, implementationsVerified: true }
}
/** RPC observations prove a pinned two-chain snapshot, not Guardian transfers, pools, payment or release approval. */
export async function auditSupply(raw: unknown, readers: (e: AuditEndpoint) => AuditReader = (e) => rpcAuditReader(e.rpc), now = Math.floor(Date.now() / 1000)) {
  const manifest = parseAuditManifest(raw)
  const results = await Promise.allSettled(manifest.endpoints.map((e, i) => observeEndpoint(manifest, e, manifest.endpoints[1 - i], readers(e), now)))
  const observations = results.flatMap((r) => r.status === 'fulfilled' ? [r.value] : [])
  const failures = results.flatMap((r, i) => r.status === 'rejected' ? [{ chain: manifest.endpoints[i].chain, error: r.reason instanceof Error ? r.reason.message : 'Observation failed' }] : [])
  const hub = observations.find((o) => o.chain === 'arc'); const spoke = observations.find((o) => o.chain === 'base')
  const issuance = BigInt(manifest.issuance)
  let accounting: { canonicalOutsideCustody: string; remote: string; backingGap: string; quiescent: boolean } | null = null
  if (hub && spoke) {
    const custody = BigInt(hub.custody); const remote = BigInt(spoke.supply)
    accounting = { canonicalOutsideCustody: (issuance - custody).toString(), remote: remote.toString(), backingGap: (custody - remote).toString(), quiescent: custody === remote && custody <= issuance }
    if (custody > issuance || remote > custody) failures.push({ chain: 'arc', error: 'Snapshot contains unbacked remote supply or impossible custody' })
    else if (custody !== remote) failures.push({ chain: 'arc', error: 'Custody and remote supply differ. Authenticate pending transfers or surplus deposits; this snapshot cannot reconcile them.' })
  }
  return { schema: 1, observedAt: new Date(now * 1000).toISOString(), mode: manifest.mode, scope: 'Arc/Base quiescent supply and configuration only',
    verified: failures.length === 0 && observations.length === 2, paidLaunchOpen: false, routeTested: false, observations, accounting, failures,
    limitation: 'RPC evidence is not independent Guardian, public round-trip, market or payment proof. Solana and Robinhood are outside this audit. Route opening requires separate verified evidence and approval.' }
}
