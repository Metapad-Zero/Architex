import { useMemo } from 'react'
import { isAddress, zeroAddress, type Address } from 'viem'
import { useReadContracts } from 'wagmi'
import { FEE_PLUGIN_INTERFACE_ID, launchFeePluginAbi, launchpadAbi } from '../lib/abi'
import { deployment, isLaunchpadDeployed } from '../lib/deployment'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import type { DestinationFacts } from '../lib/plugins/plan'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'
const ERC165_ID = '0x01ffc9a7'
const INVALID_ID = '0xffffffff'
/** Reads per address: three ERC-165 probes on the address, then isLaunchPair and pluginOf on the launchpad. */
const PER_ADDRESS = 5

function lowerAddresses(addresses: readonly string[]): Address[] {
  return [...new Set(addresses.map((address) => address.trim()).filter((address) => isAddress(address)).map((address) => address.toLowerCase()))] as Address[]
}

/**
 * What the chain says about every address typed into the builder, so a launch the builder allows is not refused on
 * chain (V13-SPEC §2.1): whether it declares IArchitexFeePlugin (asked the way the launchpad asks, OpenZeppelin
 * ERC165Checker: supports ERC-165, not 0xffffffff, supports the plugin interface), whether the launchpad knows it as
 * a launch pair (`isLaunchPair`) or a launch token (`pluginOf` is not zero), and the launchpad's own router and pair
 * factory. An address stays `unchecked` until its answers are in, and the builder waits for them.
 */
export function useDestinationProbe(addresses: readonly string[]): DestinationFacts {
  const unique = useMemo(() => lowerAddresses(addresses), [addresses])
  const enabled = !fixtureOn && isLaunchpadDeployed

  const wiring = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: deployment.launchpad, abi: launchpadAbi, functionName: 'router' },
      { address: deployment.launchpad, abi: launchpadAbi, functionName: 'pairFactory' },
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
      { address: deployment.launchpad, abi: launchpadAbi, functionName: 'isLaunchPair' as const, args: [address] as const },
      { address: deployment.launchpad, abi: launchpadAbi, functionName: 'pluginOf' as const, args: [address] as const },
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
        launchPairs: new Set(launches.map((launch) => launch.pair.toLowerCase())),
        unchecked: new Set(),
      }
    }
    const plugins = new Set<string>()
    const launchPairs = new Set<string>()
    const launchTokens = new Set<string>()
    const unchecked = new Set<string>()
    unique.forEach((address, index) => {
      const results = query.data?.slice(index * PER_ADDRESS, (index + 1) * PER_ADDRESS)
      const [erc165, invalid, plugin, pair, pluginOf] = results ?? []
      // The launchpad's answers never revert; without them the address has not been checked yet.
      if (!results || pair?.status !== 'success' || pluginOf?.status !== 'success') {
        unchecked.add(address)
        return
      }
      const yes = (result: typeof erc165) => result?.status === 'success' && result.result === true
      if (yes(erc165) && !yes(invalid) && yes(plugin)) plugins.add(address)
      if (pair.result === true) launchPairs.add(address)
      if (typeof pluginOf.result === 'string' && pluginOf.result !== zeroAddress) launchTokens.add(address)
    })
    const [router, pairFactory] = wiring.data ?? []
    if (enabled && !wiring.data) unique.forEach((address) => unchecked.add(address))
    return { plugins, launchPairs, launchTokens, unchecked, router, pairFactory }
  }, [enabled, query.data, unique, wiring.data])
}
