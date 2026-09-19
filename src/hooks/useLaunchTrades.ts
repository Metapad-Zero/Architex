import { useQuery } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { decodeEventLog, pad, parseAbiItem, toEventSelector, type Address, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { activeChain } from '../chain'
import { deployment, isLaunchpadDeployed } from '../lib/deployment'
import type { LaunchTrade } from '../lib/launch'
import { launchFixtureApi } from '../lib/launchFixtureApi'

export type { LaunchTrade }

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

function noopSubscribe(): () => void {
  return () => undefined
}
function zero(): number {
  return 0
}
const TRADE_EVENT = parseAbiItem(
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 usdcAmount, uint256 tokenAmount, uint256 fee, uint256 virtualUsdc, uint256 virtualTokens)',
)
const TRADE_TOPIC = toEventSelector(TRADE_EVENT)
const RPC_FALLBACK_SPAN = 1_900n
const MAX_TRADES = 50

interface ExplorerLog {
  transactionHash: string
  blockNumber: string
  timeStamp: string
  data: string
  topics: string[]
}

function topicForToken(token: Address): Hex {
  return pad(token, { size: 32 })
}

async function fromExplorer(token: Address, signal: AbortSignal | undefined): Promise<LaunchTrade[]> {
  const topic1 = topicForToken(token)
  const url = `${activeChain.explorerBase}/api?module=logs&action=getLogs&address=${deployment.launchpad}&fromBlock=0&toBlock=latest&topic0=${TRADE_TOPIC}&topic1=${topic1}&topic0_1_opr=and`
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Explorer ${response.status}`)
  const body = (await response.json()) as { result?: ExplorerLog[] | string | null; message?: string }
  // "No logs found" still carries an empty array. Anything else is an error inside a 200, and
  // throwing sends the caller to its RPC fallback instead of showing an empty history.
  if (!Array.isArray(body.result)) throw new Error(body.message ?? 'Explorer returned no result')
  const trades: LaunchTrade[] = []
  for (const log of body.result) {
    try {
      const decoded = decodeEventLog({ abi: [TRADE_EVENT], data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] })
      if (decoded.eventName !== 'Trade') continue
      trades.push({
        trader: decoded.args.trader,
        isBuy: decoded.args.isBuy,
        usdcAmount: decoded.args.usdcAmount,
        tokenAmount: decoded.args.tokenAmount,
        fee: decoded.args.fee,
        time: Number(log.timeStamp),
        txHash: log.transactionHash as Hex,
        block: Number(log.blockNumber),
      })
    } catch {
      // skip undecodable explorer rows
    }
  }
  trades.sort((a, b) => b.block - a.block || b.time - a.time)
  return trades.slice(0, MAX_TRADES)
}

export function useLaunchTrades(token: Address | undefined) {
  const publicClient = usePublicClient()
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)

  const query = useQuery<LaunchTrade[], Error>({
    queryKey: ['launchTrades', activeChain.id, token],
    enabled: !fixtureOn && isLaunchpadDeployed && Boolean(token),
    staleTime: 8_000,
    refetchInterval: 12_000,
    placeholderData: (previous) => previous,
    queryFn: async ({ signal }): Promise<LaunchTrade[]> => {
      if (!token) return []
      try {
        return await fromExplorer(token, signal)
      } catch {
        if (!publicClient) return []
        const head = await publicClient.getBlockNumber()
        const logs = await publicClient.getLogs({
          address: deployment.launchpad,
          event: TRADE_EVENT,
          args: { token },
          fromBlock: head > RPC_FALLBACK_SPAN ? head - RPC_FALLBACK_SPAN : 0n,
          toBlock: head,
        })
        const blocks = new Map<bigint, number>()
        const wanted = [...new Set(logs.map((log) => log.blockNumber))].filter((block): block is bigint => block !== null)
        await Promise.all(
          wanted.slice(0, 40).map(async (blockNumber) => {
            const block = await publicClient.getBlock({ blockNumber })
            blocks.set(blockNumber, Number(block.timestamp))
          }),
        )
        return logs
          .filter((log) => log.blockNumber !== null && log.args.trader && log.args.tokenAmount !== undefined)
          .map((log) => ({
            trader: log.args.trader!,
            isBuy: Boolean(log.args.isBuy),
            usdcAmount: log.args.usdcAmount ?? 0n,
            tokenAmount: log.args.tokenAmount ?? 0n,
            fee: log.args.fee ?? 0n,
            time: blocks.get(log.blockNumber) ?? 0,
            txHash: log.transactionHash,
            block: Number(log.blockNumber),
          }))
          .sort((a, b) => b.block - a.block || b.time - a.time)
          .slice(0, MAX_TRADES)
      }
    },
  })

  if (fixtureOn) {
    return { trades: token && api ? api.trades(token) : [], isLoading: false, error: null, version: fixtureVersion }
  }

  return { trades: query.data ?? [], isLoading: query.isLoading, error: query.error, version: 0 }
}
