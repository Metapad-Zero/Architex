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
import { createPublicClient, getAddress, http, zeroAddress } from 'viem'
import mainnet from '../src/deployments/arc-mainnet.json'
import testnet from '../src/deployments/arc-testnet.json'
import { pinata } from '../server/pinata'
import { launchpadAbi } from '../src/lib/abi'
import { cidOfIpfsUri } from '../src/lib/tokenMetadata'

const DAY_MS = 24 * 60 * 60 * 1000
const RPC: Record<number, string> = { 5042: 'https://rpc.mainnet.arc.io', 5042002: 'https://rpc.testnet.arc.io' }

const jwt = process.env.PINATA_JWT?.trim()
if (!jwt) throw new Error('PINATA_JWT missing. Pass it in the environment for this one command; do not put it in a file in this repository.')
const remove = process.argv.includes('--delete')
const pins = pinata(jwt)

/** Every details file a launched token points to. Throws if any deployed launchpad cannot be read. */
async function filesInUse(): Promise<Set<string>> {
  const inUse = new Set<string>()
  for (const deployment of [testnet, mainnet]) {
    const launchpad = getAddress(deployment.launchpad)
    if (launchpad === zeroAddress) continue
    const client = createPublicClient({ transport: http(RPC[deployment.chainId]) })
    const count = await client.readContract({ address: launchpad, abi: launchpadAbi, functionName: 'tokensLength' })
    for (let start = 0n; start < count; start += 50n) {
      const page = await client.readContract({ address: launchpad, abi: launchpadAbi, functionName: 'curvesPage', args: [start, 50n] })
      for (const curve of page) {
        const cid = cidOfIpfsUri(curve.metadataURI)
        if (cid) inUse.add(cid)
      }
    }
    console.log(`${deployment.network}: ${count} launches read`)
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
