/** Read-only: verify the exact fork bundle against this checkout and its frozen source revision. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_FILES } from '../evm/approval'
import { DEV } from '../evm/fork'
import { FORK_ATTESTER_KEY } from '../evm/transfers/fork'
import { TRANSFER_FILES, transferApprovalDigest } from '../evm/transfers/config'
import { keeperManifest, keeperApprovalDigest } from './approval'

const dir = process.argv[2] ?? 'docs/evidence/49th-38'
const read = (file: string) => readFileSync(join(dir, file), 'utf8')
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const manifests = JSON.parse(read('approval-manifests.json')) as { keeper: ReturnType<typeof keeperManifest>; transfer: ReturnType<typeof keeperManifest>; keeperApproval: string; transferApproval: string }
assert.deepEqual(manifests.keeper, keeperManifest())
assert.deepEqual(manifests.transfer, TRANSFER_FILES.map((file) => ({ file, sha256: digest(readFileSync(file)) })))
assert.equal(manifests.keeperApproval, keeperApprovalDigest(read('keeper-preview.md'), read('keeper.json')))
assert.equal(manifests.transferApproval, transferApprovalDigest(read('adapter.json'), read('transfer-settings.json')))
const base = '4f48dfa6953d105d175ba15e9aa2af25628dfb34'
for (const file of CODE_FILES) {
  const source = spawnSync('git', ['show', `${base}:${file}`])
  assert.equal(source.status, 0)
  assert.equal(digest(readFileSync(file)), digest(source.stdout), `Frozen launch dependency changed: ${file}`)
}
const publicDiff = spawnSync('git', ['diff', base, '--', 'public'], { encoding: 'utf8' })
assert.equal(publicDiff.status, 0); assert.equal(publicDiff.stdout, '', 'An existing public preview/approval artifact changed.')
for (const file of readdirSync(dir)) {
  const text = read(file)
  for (const key of [...Object.values(DEV), FORK_ATTESTER_KEY]) assert(!text.toLowerCase().includes(key.toLowerCase()), `Development private key leaked into ${file}`)
}
console.log(JSON.stringify({ exactManifests: true, exactApprovalDigests: true, frozenLaunchCodeUnchanged: true, existingPublicBundlesUnchanged: true, keyless: true }, null, 2))
