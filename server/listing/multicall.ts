import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import type { Rpc } from './rpc.js'

/** Multicall3, at its usual address on both Arc networks (viem's chain definitions list it too). */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])

export interface CallRequest {
  target: Address
  callData: Hex
}

export interface CallResult {
  success: boolean
  returnData: Hex
}

/** Several read calls in one eth_call, each allowed to fail on its own, all at `block`. */
export async function aggregate(rpc: Rpc, calls: readonly CallRequest[], block: bigint): Promise<CallResult[]> {
  if (calls.length === 0) return []
  const data = encodeFunctionData({
    abi: multicallAbi,
    functionName: 'aggregate3',
    args: [calls.map((call) => ({ target: call.target, allowFailure: true, callData: call.callData }))],
  })
  const raw = await rpc.request<Hex>('eth_call', [{ to: MULTICALL3, data }, `0x${block.toString(16)}`])
  const results = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: raw })
  return results.map((result) => ({ success: result.success, returnData: result.returnData }))
}

export interface BlockHeader {
  number: bigint
  timestamp: number
}

export async function readBlock(rpc: Rpc, block: bigint | 'latest'): Promise<BlockHeader> {
  const tag = block === 'latest' ? 'latest' : `0x${block.toString(16)}`
  const header = await rpc.request<{ number?: Hex; timestamp?: Hex } | null>('eth_getBlockByNumber', [tag, false])
  if (!header?.number || !header.timestamp) throw new Error(`Block ${tag} was not found.`)
  return { number: BigInt(header.number), timestamp: Number(BigInt(header.timestamp)) }
}
