import { useMemo, useSyncExternalStore } from 'react'
import { isAddress, type Address } from 'viem'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'
import { activeChain } from '../chain'
import { launchPairAbi, launchpadAbi, lensAbi } from '../lib/abi'
import { deployment, isDeployed, isLaunchpadDeployed, launchSuite } from '../lib/deployment'
import { asLaunchCurve, type LaunchRecord } from '../lib/launch'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { rememberToken, type Token, type TokenMetaResult } from '../lib/tokens'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

function noopSubscribe(): () => void {
  return () => undefined
}
function zero(): number {
  return 0
}

export function usdcToken(): Token {
  const listed = deployment.tokens.find((token) => token.address.toLowerCase() === activeChain.usdc.toLowerCase())
  return listed ?? { address: activeChain.usdc, symbol: 'USDC', name: 'USD Coin', decimals: 6, faucet: false }
}

/** USDC allowances a launch trade may need: to the launchpad (curve buys, launches) and the launch router (pool buys). */
export interface LaunchAllowances {
  launchpad: bigint
  router: bigint
}

export function useLaunch(token: Address | undefined) {
  const { address: owner } = useAccount()
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)
  const valid = Boolean(token && isAddress(token))
  const usdc = usdcToken()

  const curveQuery = useReadContract({
    address: deployment.launchpad,
    abi: launchpadAbi,
    functionName: 'curves',
    args: [token!],
    query: {
      enabled: !fixtureOn && isLaunchpadDeployed && valid,
      refetchInterval: 4_000,
    },
  })

  const metaQuery = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'tokenMeta',
    args: [[token!]],
    query: {
      enabled: !fixtureOn && isDeployed && valid,
      staleTime: Number.POSITIVE_INFINITY,
    },
  })

  const balanceTokens = valid && token ? [token, usdc.address] : [usdc.address]

  const balancesQuery = useReadContract({
    address: deployment.lens,
    abi: lensAbi,
    functionName: 'balances',
    args: [owner!, balanceTokens],
    query: {
      enabled: !fixtureOn && isDeployed && Boolean(owner),
      refetchInterval: 4_000,
    },
  })

  const allowancesQuery = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: deployment.lens, abi: lensAbi, functionName: 'allowances', args: [owner!, deployment.launchpad, [usdc.address]] },
      { address: deployment.lens, abi: lensAbi, functionName: 'allowances', args: [owner!, deployment.launchRouter, [usdc.address]] },
    ],
    query: {
      enabled: !fixtureOn && isLaunchpadDeployed && Boolean(owner),
      refetchInterval: 4_000,
    },
  })

  const curve = useMemo(() => (curveQuery.data ? asLaunchCurve(curveQuery.data) : undefined), [curveQuery.data])

  // A graduated token trades in its launch pool: its reserves price it and quote every pool trade.
  const reservesQuery = useReadContract({
    address: curve?.pair,
    abi: launchPairAbi,
    functionName: 'getReserves',
    query: {
      enabled: !fixtureOn && Boolean(curve?.graduated),
      refetchInterval: 4_000,
    },
  })

  const launch = useMemo<LaunchRecord | undefined>(() => {
    if (!token) return undefined
    if (fixtureOn) {
      void fixtureVersion
      return api?.get(token)
    }
    if (!curve) return undefined
    const meta = ((metaQuery.data ?? []) as readonly TokenMetaResult[])[0]
    const reserves = reservesQuery.data
    const record: LaunchRecord = {
      ...curve,
      name: meta?.name || 'Launch token',
      symbol: meta?.symbol || 'TOKEN',
      pool: curve.graduated && reserves ? { reserveToken: reserves[0], reserveUsdc: reserves[1] } : undefined,
    }
    rememberToken({
      address: record.token,
      name: record.name,
      symbol: record.symbol,
      decimals: 18,
      faucet: false,
      isLaunch: true,
    })
    return record
  }, [api, curve, fixtureVersion, metaQuery.data, reservesQuery.data, token])

  const launchToken = useMemo<Token | undefined>(
    () =>
      launch
        ? { address: launch.token, name: launch.name, symbol: launch.symbol, decimals: 18, faucet: false, isLaunch: true }
        : undefined,
    [launch],
  )

  const tokenBalance = token
    ? fixtureOn
      ? (api?.balance(owner, token) ?? 0n)
      : (balancesQuery.data?.[0] ?? 0n)
    : 0n
  const usdcBalance = fixtureOn
    ? (api?.balance(owner, usdc.address) ?? 0n)
    : (balancesQuery.data?.[valid ? 1 : 0] ?? 0n)
  const usdcAllowance: LaunchAllowances = fixtureOn
    ? {
        launchpad: api?.allowance(owner, usdc.address, launchSuite.launchpad) ?? 0n,
        router: api?.allowance(owner, usdc.address, launchSuite.launchRouter) ?? 0n,
      }
    : { launchpad: allowancesQuery.data?.[0]?.[0] ?? 0n, router: allowancesQuery.data?.[1]?.[0] ?? 0n }

  const refetch = async () => {
    if (fixtureOn) return
    await Promise.all([curveQuery.refetch(), metaQuery.refetch(), balancesQuery.refetch(), allowancesQuery.refetch(), reservesQuery.refetch()])
  }

  return {
    launch,
    token: launchToken,
    usdc,
    tokenBalance: token ? tokenBalance : 0n,
    usdcBalance,
    usdcAllowance,
    isLoading: !fixtureOn && valid && curveQuery.isLoading,
    unknown: Boolean(valid && !curveQuery.isLoading && !launch && (fixtureOn || curveQuery.isError)),
    error: fixtureOn ? null : curveQuery.error,
    refetch,
  }
}
