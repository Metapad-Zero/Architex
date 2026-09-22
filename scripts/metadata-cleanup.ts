/**
 * Finds pinned files that never became part of a launch, and removes them when asked.
 *
 *   PINATA_JWT=… bun run scripts/metadata-cleanup.ts            # report only
 *   PINATA_JWT=… bun run scripts/metadata-cleanup.ts --delete   # unpin what the report listed
 *
 * Saving a launch's details happens just before the create transaction, so a cancelled wallet prompt,
 * a failed transaction or someone poking the endpoint leaves files pinned that no token points to.
 * They cost pinning quota and nothing else. A file is only ever considered when all of these hold:
 *   - it carries our label (`app: architex`), so nothing else in the account is touched;
 *   - it is more than a day old, so a launch in progress is never raced;
 *   - no token on any deployed launchpad names it, directly or as the image of its details file;
 *   - every launchpad could be read. If a single chain read fails, nothing is deleted.
 *
 * The key is read from the environment and never printed. Run it yourself; it is not scheduled.
 */
import { BaseError, ContractFunctionRevertedError, createPublicClient, getAddress, http, parseAbi, zeroAddress, type Address, type PublicClient } from 'viem'
import mainnet from '../src/deployments/arc-mainnet.json'
import testnet from '../src/deployments/arc-testnet.json'
import { pinata } from '../server/pinata'
import { launchpadAbi } from '../src/lib/abi'
import { cidOfIpfsUri } from '../src/lib/tokenMetadata'

/** What a retired v1.2 launchpad answers with: its Curve struct predates creator fees and plugins. */
const v12LaunchpadAbi = parseAbi([
  'struct Curve { address token; address creator; address pair; uint128 virtualUsdc; uint128 virtualTokens; uint128 tokensSold; uint64 createdAt; bool graduated; string metadataURI; }',
  'function tokensLength() view returns (uint256)',
  'function curvesPage(uint256 start, uint256 count) view returns (Curve[])',
])

const DAY_MS = 24 * 60 * 60 * 1000
const RPC: Record<number, string> = { 5042: 'https://rpc.mainnet.arc.io', 5042002: 'https://rpc.testnet.arc.io' }

const jwt = process.env.PINATA_JWT?.trim()
if (!jwt) throw new Error('PINATA_JWT missing. Pass it in the environment for this one command; do not put it in a file in this repository.')
const remove = process.argv.includes('--delete')
const pins = pinata(jwt)

/**
 * Retired launchpads are v1.2 or replaced v1.3 ones (testnet rehearsals), and their Curve structs differ, so each is
 * asked MAX_CREATOR_FEE_BPS(), which only v1.3 has: an answer means v1.3, a revert means v1.2, and anything else (the
 * RPC failing) throws, so nothing is deleted.
 */
async function isV13(client: PublicClient, address: Address): Promise<boolean> {
  try {
    await client.readContract({ address, abi: launchpadAbi, functionName: 'MAX_CREATOR_FEE_BPS' })
    return true
  } catch (error) {
    if (error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError)) return false
    throw error
  }
}

/**
 * Every details file a launched token points to, on the current launchpad and on every retired one (their tokens
 * still exist and still name their files). Throws if any launchpad cannot be read.
 */
async function filesInUse(): Promise<Set<string>> {
  const inUse = new Set<string>()
  for (const deployment of [testnet, mainnet]) {
    const client = createPublicClient({ transport: http(RPC[deployment.chainId]) })
    const launchpads: { address: Address; retired: boolean }[] = [
      { address: getAddress(deployment.launchpad), retired: false },
      ...deployment.retiredLaunchpads.map((address) => ({ address: getAddress(address), retired: true })),
    ]
    for (const { address, retired } of launchpads) {
      if (address === zeroAddress) continue
      const abi = !retired || (await isV13(client, address)) ? launchpadAbi : v12LaunchpadAbi
      const count = await client.readContract({ address, abi, functionName: 'tokensLength' })
      for (let start = 0n; start < count; start += 50n) {
        const page = await client.readContract({ address, abi, functionName: 'curvesPage', args: [start, 50n] })
        for (const curve of page) {
          const cid = cidOfIpfsUri(curve.metadataURI)
          if (cid) inUse.add(cid)
        }
      }
      console.log(`${deployment.network}${retired ? ` (retired ${address})` : ''}: ${count} launches read`)
    }
  }
  return inUse
}

const inUse = await filesInUse()
const files = await pins.list({ app: 'architex' }, 5_000)
const cutoff = Date.now() - DAY_MS

// An image is in use when the details file that names it is.
const imagesInUse = new Set(files.filter((file) => inUse.has(file.cid)).map((file) => file.keyvalues?.image).filter((cid): cid is string => Boolean(cid)))
const orphans = files.filter((file) => Date.parse(file.created_at) < cutoff && !inUse.has(file.cid) && !imagesInUse.has(file.cid))

console.log(`${files.length} files carry our label; ${inUse.size} details files and ${imagesInUse.size} images are in use; ${orphans.length} are orphans older than a day`)
for (const file of orphans) console.log(`  ${file.created_at}  ${String(file.size).padStart(7)} B  ${file.keyvalues?.kind ?? '?'}  ${file.cid}`)

if (!remove) {
  if (orphans.length > 0) console.log('\nNothing was deleted. Run again with --delete to unpin these.')
} else {
  for (const file of orphans) await pins.unpin(file.id)
  console.log(`\nUnpinned ${orphans.length} files.`)
}
