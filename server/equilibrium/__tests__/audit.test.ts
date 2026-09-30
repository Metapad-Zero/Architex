import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, keccak256, pad, type Address, type Hex } from 'viem'
import { AUDIT_ABI, EIP1967_SLOTS, WORMHOLE_PEER_INVENTORY, auditSupply, parseAuditManifest, type AuditEndpoint, type AuditManifest, type AuditReader } from '../audit'
import { NETWORKS } from '../../../src/lib/equilibriumNetwork'

const now = 1_800_000_000
const bytecode = '0x60006000' as Hex
const codeHash = keccak256(bytecode)
const blockHash = pad('0x1234', { size: 32 })
const addr = (n: number): Address => pad(`0x${n.toString(16)}`, { size: 20 })
const zeroWord = pad('0x0', { size: 32 })
function fixture(): AuditManifest {
  const endpoint = (chain: AuditEndpoint['chain'], n: number): AuditEndpoint => ({ chain, rpc: `https://${chain}.example.test`, owner: addr(100), pauser: addr(101),
    token: { address: addr(n), codeHash }, manager: { address: addr(n + 1), codeHash, implementationHash: codeHash },
    transceiver: { address: addr(n + 2), codeHash, implementationHash: codeHash } })
  return { schema: 1, mode: 'testnet', issuance: '1000000000000', maxAgeSeconds: 1800, endpoints: [endpoint('arc', 10), endpoint('base', 20)] }
}
type Override = (e: AuditEndpoint, method: string, params: unknown[], value: unknown) => unknown
function readers(m: AuditManifest, override?: Override) {
  const requests: { chain: string; method: string; params: unknown[] }[] = []
  return { requests, read: (e: AuditEndpoint): AuditReader => {
    const other = m.endpoints.find((x) => x.chain !== e.chain)!
    const network = NETWORKS.find((n) => n.chain === e.chain)![m.mode === 'live' ? 'mainnet' : 'testnet']
    const peerId = NETWORKS.find((n) => n.chain === other.chain)![m.mode === 'live' ? 'mainnet' : 'testnet'].wormholeId
    return { request(method, params) {
      requests.push({ chain: e.chain, method, params })
      let value: unknown
      if (method === 'eth_chainId') value = `0x${Number(network.id).toString(16)}`
      else if (method === 'eth_getBlockByNumber') value = { number: '0x123', hash: blockHash, timestamp: `0x${(now - 60).toString(16)}` }
      else if (method === 'eth_getCode') value = bytecode
      else if (method === 'eth_getStorageAt') value = params[1] === EIP1967_SLOTS.implementation && params[0] !== e.token.address ? pad(addr(200)) : zeroWord
      else if (method === 'eth_call') {
        const p = params[0] as { to: Address; data: Hex }
        const { functionName: name, args } = decodeFunctionData({ abi: AUDIT_ABI, data: p.data })
        const paired = args?.[0] === peerId
        const values: Record<string, unknown> = {
          decimals: 6, totalSupply: e.chain === 'arc' ? BigInt(m.issuance) : 10000000000n, balanceOf: 10000000000n,
          minter: e.manager.address, supplyCap: BigInt(m.issuance), token: e.token.address, mode: e.chain === 'arc' ? 0 : 1,
          chainId: network.wormholeId, owner: e.owner, pauser: e.pauser, isPaused: false, getThreshold: 1,
          getTransceivers: [e.transceiver.address], getPeer: paired ? [pad(other.manager.address), 6] : [zeroWord, 0], getWormholePeer: paired ? pad(other.transceiver.address) : zeroWord,
          nttManager: e.manager.address, wormhole: network.core, consistencyLevel: 0,
        }
        value = encodeFunctionResult({ abi: AUDIT_ABI, functionName: name, result: values[name] })
      } else throw new Error(`Unexpected non-read RPC: ${method}`)
      return Promise.resolve(override ? override(e, method, params, value) : value)
    } }
  } }
}
function replaceCall(name: string, result: unknown, chain: AuditEndpoint['chain'] = 'base'): Override {
  return (e, method, params, value) => {
    if (e.chain !== chain || method !== 'eth_call') return value
    const data = (params[0] as { data: Hex }).data
    if (decodeFunctionData({ abi: AUDIT_ABI, data }).functionName !== name) return value
    return encodeFunctionResult({ abi: AUDIT_ABI, functionName: name, result })
  }
}

describe('deployed Arc/Base supply and authority audit', () => {
  test('uses finalized block-pinned reads and exact backing without opening a route', async () => {
    const m = fixture(); const r = readers(m)
    const result = await auditSupply(m, r.read, now)
    expect(result).toMatchObject({ verified: true, mode: 'testnet', paidLaunchOpen: false, routeTested: false,
      accounting: { canonicalOutsideCustody: '990000000000', remote: '10000000000', backingGap: '0', quiescent: true } })
    expect(result.observations).toHaveLength(2)
    expect(result.limitation).toContain('Solana and Robinhood are outside')
    for (const request of r.requests.filter((x) => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(x.method))) expect(request.params[request.params.length - 1]).toBe('0x123')
    expect(r.requests.filter((x) => x.method === 'eth_getStorageAt')).toHaveLength(12)
    expect(result.peerCoverage).toMatchObject({ chainIds: WORMHOLE_PEER_INVENTORY.length })
    expect(result.peerCoverage.unlisted).toContain('not read')
    for (const chain of ['arc', 'base']) for (const name of ['getPeer', 'getWormholePeer']) {
      const ids = r.requests.filter((x) => x.chain === chain && x.method === 'eth_call')
        .map((x) => decodeFunctionData({ abi: AUDIT_ABI, data: (x.params[0] as { data: Hex }).data }))
        .filter((d) => d.functionName === name).map((d) => Number(d.args![0]))
      expect(new Set(ids)).toEqual(new Set(WORMHOLE_PEER_INVENTORY))
    }
  })
  test('pins a Wormhole inventory that covers the paired, retired and pilot chain IDs', () => {
    expect(new Set(WORMHOLE_PEER_INVENTORY).size).toBe(WORMHOLE_PEER_INVENTORY.length)
    expect(WORMHOLE_PEER_INVENTORY).not.toContain(0)
    for (const id of [1, 2, 3, 30, 71, 72, 3104, 10002, 10004, 65000]) expect(WORMHOLE_PEER_INVENTORY).toContain(id)
    for (const n of NETWORKS) for (const id of [n.mainnet.wormholeId, n.testnet.wormholeId]) if (id !== null) expect(WORMHOLE_PEER_INVENTORY).toContain(id)
  })
  for (const [label, name, result] of [
    ['manager', 'getPeer', [pad(addr(999)), 6]], ['transceiver', 'getWormholePeer', pad(addr(999))],
  ] as const) test(`rejects an extra ${label} peer on Wormhole chain 2 alongside the approved pair`, async () => {
    for (const chain of ['arc', 'base'] as const) {
      const m = fixture(); const r = readers(m, (e, method, params, value) => {
        if (e.chain !== chain || method !== 'eth_call') return value
        const d = decodeFunctionData({ abi: AUDIT_ABI, data: (params[0] as { data: Hex }).data })
        return d.functionName === name && d.args![0] === 2 ? encodeFunctionResult({ abi: AUDIT_ABI, functionName: name, result }) : value
      })
      const audit = await auditSupply(m, r.read, now)
      expect(audit.verified).toBe(false)
      expect(audit.failures).toHaveLength(1)
      expect(audit.failures[0]).toMatchObject({ chain })
      expect(audit.failures[0].error).toContain(`${name} has an unapproved`)
      expect(audit.failures[0].error).toContain('Wormhole chain 2')
    }
  })
  test('rejects a leftover peer decimals entry even when the peer address is zero', async () => {
    const m = fixture(); const r = readers(m, (e, method, params, value) => {
      if (e.chain !== 'arc' || method !== 'eth_call') return value
      const d = decodeFunctionData({ abi: AUDIT_ABI, data: (params[0] as { data: Hex }).data })
      return d.functionName === 'getPeer' && d.args![0] === 65000 ? encodeFunctionResult({ abi: AUDIT_ABI, functionName: 'getPeer', result: [zeroWord, 6] }) : value
    })
    const audit = await auditSupply(m, r.read, now)
    expect(audit.verified).toBe(false); expect(audit.failures[0].error).toContain('Wormhole chain 65000')
  })
  test('validates both deployments before any RPC and rejects duplicate/missing contracts', async () => {
    const m = fixture(); m.endpoints[1].token.address = addr(0)
    const r = readers(m)
    const failure = await auditSupply(m, r.read, now).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('nonzero address')
    expect(r.requests).toHaveLength(0)
    const duplicates = fixture(); duplicates.endpoints[1].chain = 'arc'
    expect(() => parseAuditManifest(duplicates)).toThrow('Distinct Arc and Base')
    const same = fixture(); same.endpoints[0].manager.address = same.endpoints[0].token.address
    expect(() => parseAuditManifest(same)).toThrow('distinct contracts')
  })
  test('rejects an unknown mode, embedded secrets and unknown chain expansion', () => {
    expect(() => parseAuditManifest({ ...fixture(), mode: 'fork' })).toThrow('testnet/live')
    const credentials = fixture(); credentials.endpoints[0].rpc = 'https://rpc.example.test/?key=secret'
    expect(() => parseAuditManifest(credentials)).toThrow('embedded credentials')
    const unknown = { ...fixture(), endpoints: [{ ...fixture().endpoints[0], chain: 'solana' }, fixture().endpoints[1]] }
    expect(() => parseAuditManifest(unknown)).toThrow('Arc/Base')
  })
  test('fails on a wrong RPC network and retains independently verified chain evidence', async () => {
    const m = fixture(); const r = readers(m, (e, method, _params, value) => e.chain === 'base' && method === 'eth_chainId' ? '0x2105' : value)
    const result = await auditSupply(m, r.read, now)
    expect(result.verified).toBe(false); expect(result.failures[0].error).toContain('chain ID')
    expect(result.observations).toHaveLength(1); expect(result.accounting).toBeNull()
  })
  test('never falls back to latest when finalized RPC evidence is unavailable', async () => {
    const m = fixture(); const r = readers(m, (_e, method, _params, value) => {
      if (method === 'eth_getBlockByNumber') throw new Error('Finalized unsupported')
      return value
    })
    const result = await auditSupply(m, r.read, now)
    expect(result.verified).toBe(false)
    expect(r.requests.some((x) => x.params.includes('latest'))).toBe(false)
  })
  test('rejects stale or future finalized blocks', async () => {
    for (const time of [now - 1801, now + 31]) {
      const m = fixture(); const r = readers(m, (_e, method, _params, value) => method === 'eth_getBlockByNumber' ? { ...(value as object), timestamp: `0x${time.toString(16)}` } : value)
      const result = await auditSupply(m, r.read, now)
      expect(result.verified).toBe(false); expect(result.failures[0].error).toContain('timestamp')
    }
  })
  test('checks the proxy implementation bytecode, not just its unchanged proxy shell', async () => {
    const m = fixture(); const r = readers(m, (_e, method, params, value) => method === 'eth_getCode' && params[0] === addr(200) ? '0x60006001' : value)
    const result = await auditSupply(m, r.read, now)
    expect(result.verified).toBe(false); expect(result.failures[0].error).toContain('bytecode hash')
  })
  test('fails closed on a token proxy whose implementation is not pinned', async () => {
    const m = fixture(); const r = readers(m, (e, method, params, value) =>
      method === 'eth_getStorageAt' && params[0] === e.token.address && params[1] === EIP1967_SLOTS.implementation ? pad(addr(300)) : value)
    const audit = await auditSupply(m, r.read, now)
    expect(audit.verified).toBe(false); expect(audit.failures).toHaveLength(2)
    for (const f of audit.failures) expect(f.error).toContain('without an approved implementation hash')
  })
  test('detects a token upgrade behind an unchanged proxy shell', async () => {
    const m = fixture(); m.endpoints[1].token.implementationHash = codeHash
    expect(parseAuditManifest(m).endpoints[1].token.implementationHash).toBe(codeHash)
    const proxied: Override = (e, method, params, value) =>
      method === 'eth_getStorageAt' && e.chain === 'base' && params[0] === e.token.address && params[1] === EIP1967_SLOTS.implementation ? pad(addr(300)) : value
    expect((await auditSupply(m, readers(m, proxied).read, now)).verified).toBe(true)
    const upgraded: Override = (e, method, params, value) => {
      if (method === 'eth_getStorageAt' && e.chain === 'base' && params[0] === e.token.address && params[1] === EIP1967_SLOTS.implementation) return pad(addr(301))
      if (method === 'eth_getCode' && params[0] === addr(301)) return '0x60006002'
      return value
    }
    const audit = await auditSupply(m, readers(m, upgraded).read, now)
    expect(audit.verified).toBe(false); expect(audit.failures[0]).toMatchObject({ chain: 'base' })
    expect(audit.failures[0].error).toContain('bytecode hash')
    const unset = await auditSupply(m, readers(m).read, now)
    expect(unset.verified).toBe(false); expect(unset.failures[0].error).toContain('implementation slot')
  })
  test('rejects beacon proxies on any pinned contract and an empty token implementation hash', async () => {
    const m = fixture(); const r = readers(m, (e, method, params, value) =>
      method === 'eth_getStorageAt' && params[0] === e.manager.address && params[1] === EIP1967_SLOTS.beacon ? pad(addr(400)) : value)
    const audit = await auditSupply(m, r.read, now)
    expect(audit.verified).toBe(false); expect(audit.failures[0].error).toContain('beacon')
    const empty = fixture() as unknown as { endpoints: { token: Record<string, unknown> }[] }
    empty.endpoints[0].token.implementationHash = ''
    expect(() => parseAuditManifest(empty)).toThrow('runtime code hash')
  })
  test('rejects an empty deployment and a block hash that changes during observation', async () => {
    for (const override of [
      ((_e, method, _params, value) => method === 'eth_getCode' ? '0x' : value) as Override,
      ((_e, method, params, value) => method === 'eth_getBlockByNumber' && params[0] === '0x123' ? { ...(value as object), hash: pad('0x5678') } : value) as Override,
    ]) {
      const m = fixture(); const r = readers(m, override)
      expect((await auditSupply(m, r.read, now)).verified).toBe(false)
    }
  })
  for (const [name, result] of [
    ['minter', addr(999)], ['owner', addr(999)], ['pauser', addr(999)], ['isPaused', true], ['token', addr(999)],
    ['mode', 0], ['chainId', 30], ['getThreshold', 2], ['getTransceivers', [addr(999)]],
    ['getPeer', [pad(addr(999)), 6]], ['getWormholePeer', pad(addr(999))], ['nttManager', addr(999)],
    ['wormhole', addr(999)], ['consistencyLevel', 1],
  ] as [string, unknown][]) {
    test(`rejects mismatched ${name} before marking the snapshot verified`, async () => {
      const m = fixture(); const r = readers(m, replaceCall(name, result))
      const audit = await auditSupply(m, r.read, now)
      expect(audit.verified).toBe(false); expect(audit.failures[0].error).toContain(name)
    })
  }
  test('detects remote inflation and refuses to authenticate a backing gap as a pending claim', async () => {
    for (const supply of [10000000001n, 9999999999n]) {
      const m = fixture(); const r = readers(m, replaceCall('totalSupply', supply))
      const audit = await auditSupply(m, r.read, now)
      expect(audit.verified).toBe(false); expect(audit.accounting?.quiescent).toBe(false)
      expect(audit.failures[0].error).toContain(supply > 10000000000n ? 'unbacked' : 'pending transfers')
    }
  })
  test('rejects a changed canonical issuance and a spoke cap mismatch', async () => {
    for (const [name, chain] of [['totalSupply', 'arc'], ['supplyCap', 'base']] as const) {
      const m = fixture(); const r = readers(m, replaceCall(name, 999n, chain))
      expect((await auditSupply(m, r.read, now)).verified).toBe(false)
    }
  })
  test('collects all started reads even when another configuration check fails', async () => {
    const m = fixture(); const r = readers(m, replaceCall('minter', addr(999)))
    let completed = 0
    const audit = await auditSupply(m, (e) => {
      const base = r.read(e)
      return { async request(method, params) {
        const value = await base.request(method, params)
        if (method === 'eth_call') {
          await new Promise<void>((resolve) => setTimeout(resolve, 5))
          completed++
        }
        return value
      } }
    }, now)
    expect(audit.verified).toBe(false)
    expect(completed).toBe(r.requests.filter((x) => x.method === 'eth_call').length)
  })
})
