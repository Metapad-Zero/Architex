import { useMemo } from 'react'
import { isAddress, zeroAddress, type Address } from 'viem'
import { useReadContracts } from 'wagmi'
import { FEE_PLUGIN_INTERFACE_ID, launchFeePluginAbi, launchpadAbi, launchpadV14Abi } from '../lib/abi'
import { builderVersion, deployment, isLaunchpadDeployed, isLaunchpadV14Deployed, launchSuiteV14 } from '../lib/deployment'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import type { DestinationFacts } from '../lib/plugins/plan'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'
const ERC165_ID = '0x01ffc9a7'
const INVALID_ID = '0xffffffff'

/** The launchpads live here, each asked about every address: v1.3's, then v1.4's. */
const LAUNCHPADS = [
  ...(isLaunchpadDeployed ? [{ address: deployment.launchpad, abi: launchpadAbi }] : []),
  ...(isLaunchpadV14Deployed ? [{ address: launchSuiteV14.launchpad, abi: launchpadV14Abi }] : []),
] as const
/** The launchpad a new launch goes to: its own router() and pairFactory() are refused as destinations. */
const BUILDER = builderVersion === 'v14' ? LAUNCHPADS[LAUNCHPADS.length - 1] : LAUNCHPADS[0]
/** Reads per address: three ERC-165 probes on the address, then isLaunchPair and pluginOf on each launchpad. */
const PER_ADDRESS = 3 + 2 * LAUNCHPADS.length

function lowerAddresses(addresses: readonly string[]): Address[] {
  return [...new Set(addresses.map((address) => address.trim()).filter((address) => isAddress(address)).map((address) => address.toLowerCase()))] as Address[]
}

/**
 * What the chain says about every address typed into the builder, so a launch the builder allows is not refused on
 * chain (V13-SPEC §2.1): whether it declares IArchitexFeePlugin (asked the way the launchpad asks, OpenZeppelin
 * ERC165Checker: supports ERC-165, not 0xffffffff, supports the plugin interface), whether any launchpad here knows it
 * as a launch pool (`isLaunchPair`: v1.3's launch pairs, v1.4's PoolManager and hook) or a launch token (`pluginOf`
 * is not zero), and the builder's launchpad's own router and pair factory. An address stays `unchecked` until its
 * answers are in, and the builder waits for them.
 */
export function useDestinationProbe(addresses: readonly string[]): DestinationFacts {
  const unique = useMemo(() => lowerAddresses(addresses), [addresses])
  const enabled = !fixtureOn && BUILDER !== undefined

  const wiring = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: BUILDER?.address, abi: launchpadAbi, functionName: 'router' },
      { address: BUILDER?.address, abi: launchpadAbi, functionName: 'pairFactory' },
    ],
    query: { enabled, staleTime: Number.POSITIVE_INFINITY },
  })

  const query = useReadContracts({
    allowFailure: true,
    contracts: unique.flatMap((address) => [
      ...[ERC165_ID, INVALID_ID, FEE_PLUGIN_INTERFACE_ID].map((id) => ({
        address,
        abi: launchFeePluginAbi,
        functionName: 'supportsInterface' as const,
        args: [id] as const,
      })),
      ...LAUNCHPADS.flatMap((launchpad) => [
        { address: launchpad.address, abi: launchpadAbi, functionName: 'isLaunchPair' as const, args: [address] as const },
        { address: launchpad.address, abi: launchpadAbi, functionName: 'pluginOf' as const, args: [address] as const },
      ]),
    ]),
    query: { enabled: enabled && unique.length > 0, staleTime: 60_000, placeholderData: (previous) => previous },
  })

  return useMemo<DestinationFacts>(() => {
    if (fixtureOn) {
      // The dev fixture's launches are the only launch tokens and pairs there are.
      const launches = launchFixtureApi()?.list() ?? []
      return {
        plugins: new Set(),
        launchTokens: new Set(launches.map((launch) => launch.token.toLowerCase())),
        launchPairs: new Set(launches.map((launch) => launch.pair.toLowerCase()).filter((pair) => pair !== zeroAddress)),
        unchecked: new Set(),
      }
    }
    const plugins = new Set<string>()
    const launchPairs = new Set<string>()
    const launchTokens = new Set<string>()
    const unchecked = new Set<string>()
    unique.forEach((address, index) => {
      const results = query.data?.slice(index * PER_ADDRESS, (index + 1) * PER_ADDRESS)
      const [erc165, invalid, plugin, ...launchpads] = results ?? []
      // The launchpads' answers never revert; without them the address has not been checked yet.
      if (!results || launchpads.length < 2 * LAUNCHPADS.length || launchpads.some((result) => result?.status !== 'success')) {
        unchecked.add(address)
        return
      }
      const yes = (result: typeof erc165) => result?.status === 'success' && result.result === true
      if (yes(erc165) && !yes(invalid) && yes(plugin)) plugins.add(address)
      for (let at = 0; at < launchpads.length; at += 2) {
        const [pair, pluginOf] = [launchpads[at], launchpads[at + 1]]
        if (pair?.status === 'success' && pair.result === true) launchPairs.add(address)
        if (pluginOf?.status === 'success' && typeof pluginOf.result === 'string' && pluginOf.result !== zeroAddress) launchTokens.add(address)
      }
    })
    const [router, pairFactory] = wiring.data ?? []
    if (enabled && !wiring.data) unique.forEach((address) => unchecked.add(address))
    return { plugins, launchPairs, launchTokens, unchecked, router, pairFactory }
  }, [enabled, query.data, unique, wiring.data])
}
