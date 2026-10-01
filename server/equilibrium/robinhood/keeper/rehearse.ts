import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rehearse } from './rehearsal'
import { stringify } from './fork'
import { manifests, sha256 } from './manifest'
import { LABELS, SCOPE } from './fork'

const directory = resolve(process.argv[2] ?? 'docs/evidence/49th-40')
const privateDirectory = resolve(process.argv[3] ?? '.equilibrium/49th-40/rehearsal')
mkdirSync(directory, { recursive: true })
const evidence = await rehearse(privateDirectory)
evidence.sourceRevision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
evidence.sourceManifest = manifests()
writeFileSync(join(directory, 'evidence.json'), stringify(evidence) + '\n')
writeFileSync(join(directory, 'manifests.json'), stringify(manifests()) + '\n')
const keeper = JSON.parse(readFileSync(join(privateDirectory, 'private-keeper.json'), 'utf8')) as Record<string, unknown>
delete keeper.operatorKey
const route = JSON.parse(readFileSync(join(privateDirectory, 'private-route.json'), 'utf8')) as Record<string, unknown>
delete route.operatorKey
writeFileSync(join(directory, 'keeper.json'), stringify(keeper) + '\n')
writeFileSync(join(directory, 'route.json'), stringify(route) + '\n')
const preview = `EQUILIBRIUM 49TH-40 Robinhood keeper — FORK ONLY, public route closed.

${LABELS.map((label) => `- ${label}`).join('\n')}

Vaults, assets, pools, finality, operator powers, valuation expiry, fee inputs and every bound are fixed by keeper.json and the keeper manifest below. The operator owns the vaults and may run legs, halt, resume, attest a remote close and withdraw while the vault permits it. This is not a bridge proof for remote trade closure; the operator attests a finalized receipt.

Recovery: pause new admissions, retain the private journal, reconcile signed transactions and finality, unwind the same position only within the remaining loss limit, then resume. Never delete a pending claim or change an operation to get past a refusal. After a signed-before-send crash, replay the persisted signed bytes. Fixture expiry or unavailable inputs refuse sends; an unresolved journal must be reviewed before changing its bound manifest.

Keeper profit is conservative USDC-reference valuation of receipts. It does not execute USDG→USDC conversion. Leg gas appears once in trading net; controls and maintenance appear once in combined net. Principal and internal volume are not revenue. Pool/treasury income and external customer revenue are not evaluated in this rehearsal.

No owner authorization, deployment, funding or campaign approval is requested by this fixture bundle.
`
const transferPreview = `EQUILIBRIUM 49TH-40 token maintenance — FORK ONLY, public route closed.

Same asset: canonical Arc token locks into its existing NTT hub; the bound Robinhood peer authenticates the published message and mints directly into the keeper vault. Token cap ${SCOPE.maxPerTransfer} per transfer / ${SCOPE.maxTotal} cumulatively, in 6-decimal token atoms. Pending claims count and prevent new trades. This scope permits no issuance, no USDG refill and no nonzero native protocol payment.

Both chains use two local confirmations. The finalized source publication binds managers, chain, source token, precision, amount, sender and recipient. Completion requires the matching finalized redemption, exact mint and supply equation: canonical outside custody + remote supply + authenticated pending claims = fixed issuance; custody = remote supply + pending claims. Keeper/transfer identities and RPCs must match. Source inventory, NTT capacity, operator gas and cumulative operating cost must be available before sending.

Custody: fork development-key executor owns the managers/transceivers, including upgrade, peers, threshold, pause and rate-limit powers. Local Guardian threshold 1 is a fixture. Exact addresses and Guardian set indexes are in route.json. Replays and process restarts use the same operations and signed bytes; costs include control and maintenance calls under the keeper operating cap.

The journal contains signed transactions and must remain private (0600). Stop by ending the foreground run; its exact Anvil children are stopped and awaited. No persistent service is delivered.

${LABELS.map((label) => `- ${label}`).join('\n')}
`
writeFileSync(join(directory, 'keeper-preview.md'), preview)
writeFileSync(join(directory, 'transfer-preview.md'), transferPreview)
const exact = manifests()
writeFileSync(join(directory, 'bundle-digests.json'), stringify({
  keeper: sha256(['49th40-local-keeper-preview-v1', preview, stringify(keeper), exact.keeperDigest].join('\n')),
  transfer: sha256(['49th40-local-transfer-preview-v1', transferPreview, stringify(route), stringify(SCOPE), exact.transferDigest].join('\n')),
  authorization: 'fixture identity only; public sends remain closed',
}) + '\n')
console.log(stringify({ directory, publicRoutes: 'closed', labels: evidence.labels, finalSupply: evidence.finalSupply, processCrashes: (evidence.processCrashes as unknown[]).length, costs: (evidence.costs as Record<string, unknown>).gas }))
