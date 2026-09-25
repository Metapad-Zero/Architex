import { useMemo, useSyncExternalStore } from 'react'
import { isAddress, type Address } from 'viem'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'
import { activeChain } from '../chain'
import { launchHookAbi, launchPairAbi, launchpadAbi, launchpadV14Abi, lensAbi, stateViewAbi } from '../lib/abi'
import {
  builderVersion,
  deployment,
  isDeployed,
  isLaunchpadDeployed,
  isLaunchpadV14Deployed,
  launchSuite,
  launchSuiteV14,
  type LaunchVersion,
} from '../lib/deployment'
import { asLaunchCurve, asLaunchCurveV14, type LaunchRecord } from '../lib/launch'
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

/**
 * USDC allowances a launch trade may need, for the token's own launchpad: to the launchpad (curve buys, launches) and
 * to its router (pool buys: v1.3's launch router, or v1.4's v4 router). With no token, the builder's launchpad.
 */
export interface LaunchAllowances {
  launchpad: bigint
  router: bigint
}

/** The launchpad and router a version trades through. */
function spenders(version: LaunchVersion): { launchpad: Address; router: Address } {
  return version === 'v14'
    ? { launchpad: launchSuiteV14.launchpad, router: launchSuiteV14.router }
    : { launchpad: launchSuite.launchpad, router: launchSuite.launchRouter }
}

export function useLaunch(token: Address | undefined) {
  const { address: owner } = useAccount()
  const api = launchFixtureApi()
  const fixtureVersion = useSyncExternalStore(api ? api.subscribe : noopSubscribe, api ? api.version : zero, zero)
  const valid = Boolean(token && isAddress(token))
  const usdc = usdcToken()

  // A token belongs to one launchpad: both are asked, and the one that knows it answers (the other reverts).
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
  const curveV14Query = useReadContract({
    address: launchSuiteV14.launchpad,
    abi: launchpadV14Abi,
    functionName: 'curves',
    args: [token!],
    query: {
      enabled: !fixtureOn && isLaunchpadV14Deployed && valid,
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

  const curve = useMemo(
    () => (curveV14Query.data ? asLaunchCurveV14(curveV14Query.data) : curveQuery.data ? asLaunchCurve(curveQuery.data) : undefined),
    [curveQuery.data, curveV14Query.data],
  )
  // A page with no token (the builder) spends through the launchpad new launches go to.
  const version: LaunchVersion = fixtureOn ? (token ? (api?.get(token)?.version ?? 'v13') : builderVersion) : (curve?.version ?? (token ? 'v13' : builderVersion))

  // Every spender either launchpad may need, in one read: v1.3's launchpad and launch router, then v1.4's.
  const allowanceSpenders = useMemo(
    () => [...(isLaunchpadDeployed ? [spenders('v13')] : []), ...(isLaunchpadV14Deployed ? [spenders('v14')] : [])],
    [],
  )
  const allowancesQuery = useReadContracts({
    allowFailure: false,
    contracts: allowanceSpenders.flatMap((pair) => [
      { address: deployment.lens, abi: lensAbi, functionName: 'allowances' as const, args: [owner!, pair.launchpad, [usdc.address]] as const },
      { address: deployment.lens, abi: lensAbi, functionName: 'allowances' as const, args: [owner!, pair.router, [usdc.address]] as const },
    ]),
    query: {
      enabled: !fixtureOn && allowanceSpenders.length > 0 && Boolean(owner),
      refetchInterval: 4_000,
    },
  })

  // A graduated v1.3 token trades in its launch pool: its reserves price it and quote every pool trade.
  const reservesQuery = useReadContract({
    address: curve?.pair,
    abi: launchPairAbi,
    functionName: 'getReserves',
    query: {
      enabled: !fixtureOn && Boolean(curve?.graduated) && curve?.version !== 'v14',
      refetchInterval: 4_000,
    },
  })

  // A graduated v1.4 token trades in its Uniswap pool: the hook names it (and when it opened), StateView prices it.
  const graduatedV14 = !fixtureOn && curve?.version === 'v14' && curve.graduated
  const launchOfQuery = useReadContract({
    address: launchSuiteV14.hook,
    abi: launchHookAbi,
    functionName: 'launchOf',
    args: [token!],
    query: { enabled: graduatedV14, staleTime: Number.POSITIVE_INFINITY },
  })
  const poolId = launchOfQuery.data?.[0]
  const poolQuery = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: launchSuiteV14.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId!] },
      { address: launchSuiteV14.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId!] },
      { address: launchSuiteV14.hook, abi: launchHookAbi, functionName: 'lockHeld', args: [token!] },
    ],
    query: { enabled: graduatedV14 && Boolean(poolId), refetchInterval: 4_000 },
  })
  // Before graduation the launchpad holds the curve's snipe fees for the pool.
  const pendingSnipeQuery = useReadContract({
    address: launchSuiteV14.launchpad,
    abi: launchpadV14Abi,
    functionName: 'pendingSnipe',
    args: [token!],
    query: { enabled: !fixtureOn && curve?.version === 'v14' && !curve.graduated, refetchInterval: 4_000 },
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
    const launchOf = launchOfQuery.data
    const pool = poolQuery.data
    const record: LaunchRecord = {
      ...curve,
      name: meta?.name || 'Launch token',
      symbol: meta?.symbol || 'TOKEN',
      pool: curve.graduated && curve.version !== 'v14' && reserves ? { reserveToken: reserves[0], reserveUsdc: reserves[1] } : undefined,
      v4:
        curve.graduated && launchOf && pool && pool[0][0] > 0n
          ? {
              poolId: launchOf[0],
              sqrtPriceX96: pool[0][0],
              tick: pool[0][1],
              graduationTick: launchOf[1].graduationTick,
              usdcIs0: launchOf[1].usdcIs0,
              openBlock: launchOf[1].openBlock,
              liquidity: pool[1],
              lockHeld: pool[2],
            }
          : undefined,
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
  }, [api, curve, fixtureVersion, launchOfQuery.data, metaQuery.data, poolQuery.data, reservesQuery.data, token])

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
  const mine = spenders(version)
  const at = allowanceSpenders.findIndex((pair) => pair.launchpad === mine.launchpad)
  const usdcAllowance: LaunchAllowances = fixtureOn
    ? {
        launchpad: api?.allowance(owner, usdc.address, mine.launchpad) ?? 0n,
        router: api?.allowance(owner, usdc.address, mine.router) ?? 0n,
      }
    : { launchpad: allowancesQuery.data?.[at * 2]?.[0] ?? 0n, router: allowancesQuery.data?.[at * 2 + 1]?.[0] ?? 0n }
  /** USDC of anti-sniping fees held for the token's pool: by the launchpad on the curve, by the hook once it graduates. */
  const snipeHeld = fixtureOn
    ? (token ? api?.snipeHeld(token) : undefined)
    : launch?.version === 'v14'
      ? launch.graduated
        ? launch.v4?.lockHeld
        : pendingSnipeQuery.data
      : undefined

  // A manual refetch runs even a disabled query, so only the reads that apply to this token and network are asked for.
  const refetch = async () => {
    if (fixtureOn) return
    const v14Token = curve?.version === 'v14'
    await Promise.all([
      isLaunchpadDeployed && valid ? curveQuery.refetch() : undefined,
      isLaunchpadV14Deployed && valid ? curveV14Query.refetch() : undefined,
      isDeployed && valid ? metaQuery.refetch() : undefined,
      isDeployed && owner ? balancesQuery.refetch() : undefined,
      allowanceSpenders.length > 0 && owner ? allowancesQuery.refetch() : undefined,
      curve?.graduated && !v14Token ? reservesQuery.refetch() : undefined,
      graduatedV14 && poolId ? poolQuery.refetch() : undefined,
      v14Token && !curve.graduated ? pendingSnipeQuery.refetch() : undefined,
    ])
  }

  const searching = (isLaunchpadDeployed && curveQuery.isLoading) || (isLaunchpadV14Deployed && curveV14Query.isLoading)
  const refused = (!isLaunchpadDeployed || curveQuery.isError) && (!isLaunchpadV14Deployed || curveV14Query.isError)

  return {
    launch,
    /** The launchpad the page's token (or, with none, the next launch) belongs to. */
    version,
    token: launchToken,
    usdc,
    tokenBalance: token ? tokenBalance : 0n,
    usdcBalance,
    usdcAllowance,
    snipeHeld,
    isLoading: !fixtureOn && valid && !curve && searching,
    unknown: Boolean(valid && !launch && (fixtureOn || (!searching && refused))),
    error: fixtureOn ? null : curve ? null : (curveQuery.error ?? curveV14Query.error),
    refetch,
  }
}
