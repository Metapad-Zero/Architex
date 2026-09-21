import { useMemo } from 'react'
import { isAddress, type Address } from 'viem'
import { useReadContracts } from 'wagmi'
import { FEE_PLUGIN_INTERFACE_ID, launchFeePluginAbi } from '../lib/abi'
import { isDeployed } from '../lib/deployment'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'
const ERC165_ID = '0x01ffc9a7'
const INVALID_ID = '0xffffffff'

/**
 * Which of `addresses` declare IArchitexFeePlugin, asked the way the launchpad asks (OpenZeppelin ERC165Checker):
 * supports ERC-165, does not claim 0xffffffff, and supports the plugin interface. A wallet has no code, so its
 * calls fail and it counts as no plugin. Returns lowercased addresses.
 */
export function useFeePluginProbe(addresses: readonly string[]): ReadonlySet<string> {
  const unique = useMemo(
    () => [...new Set(addresses.map((address) => address.trim()).filter((address) => isAddress(address)).map((address) => address.toLowerCase()))] as Address[],
    [addresses],
  )
  const query = useReadContracts({
    allowFailure: true,
    contracts: unique.flatMap((address) =>
      [ERC165_ID, INVALID_ID, FEE_PLUGIN_INTERFACE_ID].map((id) => ({
        address,
        abi: launchFeePluginAbi,
        functionName: 'supportsInterface' as const,
        args: [id] as const,
      })),
    ),
    query: { enabled: !fixtureOn && isDeployed && unique.length > 0, staleTime: 60_000 },
  })
  return useMemo(() => {
    const plugins = new Set<string>()
    unique.forEach((address, index) => {
      const [erc165, invalid, plugin] = [0, 1, 2].map((offset) => query.data?.[index * 3 + offset])
      const yes = (result: typeof erc165) => result?.status === 'success' && result.result === true
      if (yes(erc165) && !yes(invalid) && yes(plugin)) plugins.add(address)
    })
    return plugins
  }, [query.data, unique])
}
