import { writeFileSync } from 'node:fs'
import { keccak256, type Hex } from 'viem'
import { BRIDGE, NETWORKS } from '../src/lib/equilibriumNetwork'

/** Public, read-only RPC inspection. Records infrastructure only, never opens a route. */
async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json() as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  return body.result
}
const observations = await Promise.all(NETWORKS.flatMap((chain) => (['mainnet', 'testnet'] as const).map(async (network) => {
  const n = chain[network]; const mode = network === 'mainnet' ? 'live' : 'testnet'
  try {
    if (chain.chain === 'solana') {
      const genesis = String(await rpc(n.rpc, 'getGenesisHash', []))
      // CAIP-2 uses the first 32 chars of the cluster genesis hash.
      if (genesis.slice(0, 32) !== n.id) throw new Error('Genesis hash differs from pinned cluster')
      const slot = await rpc(n.rpc, 'getSlot', [{ commitment: 'finalized' }])
      const contracts = await Promise.all([['core', n.core], ['market', n.market]].map(async ([kind, address]) => {
        if (!address) return { kind, address: null, state: 'not_documented' }
        const account = await rpc(n.rpc, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]) as { context: { slot: number }; value: { executable: boolean; owner: string; data: [string, string] } | null }
        return { kind, address, state: account.value?.executable ? 'executable_program_observed' : 'missing_or_not_executable', owner: account.value?.owner, slot: account.context.slot, byteHash: account.value ? keccak256(`0x${Buffer.from(account.value.data[0], 'base64').toString('hex')}`) : null }
      }))
      return { chain: chain.chain, network, mode, cluster: network === 'testnet' ? 'devnet' : 'mainnet-beta', rpc: n.rpc, genesis, finalizedSlot: slot, contracts, routeTested: false }
    }
    const actualId = Number(BigInt(String(await rpc(n.rpc, 'eth_chainId', []))))
    if (actualId !== n.id) throw new Error(`Chain ID mismatch: expected ${n.id}, observed ${actualId}`)
    let block: { number: string; hash: string }; let finality: string
    try {
      block = await rpc(n.rpc, 'eth_getBlockByNumber', ['finalized', false]) as typeof block
      if (!block?.number) throw new Error('No finalized block')
      finality = 'rpc_finalized'
    } catch {
      block = await rpc(n.rpc, 'eth_getBlockByNumber', ['latest', false]) as typeof block
      finality = 'latest_only_finality_unverified'
    }
    const contracts = await Promise.all([['core', n.core], ['market', n.market]].map(async ([kind, address]) => {
      if (!address) return { kind, address: null, state: 'not_documented' }
      try {
        const code = String(await rpc(n.rpc, 'eth_getCode', [address, block.number])) as Hex
        return { kind, address, state: code === '0x' ? 'no_code' : 'bytecode_observed', byteHash: code === '0x' ? null : keccak256(code), bytes: (code.length - 2) / 2 }
      } catch (error) { return { kind, address, state: 'unverified', error: error instanceof Error ? error.message : 'RPC error' } }
    }))
    return { chain: chain.chain, network, mode, rpc: n.rpc, actualId, finality, blockNumber: block.number, blockHash: block.hash, contracts, routeTested: false }
  } catch (error) { return { chain: chain.chain, network, mode, rpc: n.rpc, state: 'unverified', error: error instanceof Error ? error.message : 'RPC error', routeTested: false } }
})))
const result = { observedAt: new Date().toISOString(), purpose: 'Read-only infrastructure evidence. Not a token deployment or bridge/pool route test.', bridge: BRIDGE, paidLaunchOpen: false, observations }
writeFileSync('./public/equilibrium-infrastructure.json', JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
