import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { manifests, sha256 } from './manifest'
import { DEV } from '../../evm/fork'
import { CODE_FILES } from '../../evm/approval'
import { KEEPER_FILES } from '../../keeper/approval'
import { TRANSFER_FILES } from '../../evm/transfers/config'
import { stringify, SCOPE } from './fork'

const directory = process.argv[2] ?? 'docs/evidence/49th-40'
const read = (file: string) => readFileSync(join(directory, file), 'utf8')
const exact = manifests()
assert.deepEqual(JSON.parse(read('manifests.json')), exact)
const evidence = JSON.parse(read('evidence.json')) as { sourceManifest: unknown; sourceRevision: string; finalSupply: { reconciled: boolean }; processCrashes: unknown[] }
assert.deepEqual(evidence.sourceManifest, exact)
assert(evidence.finalSupply.reconciled)
assert.equal(evidence.processCrashes.length, 13)
const digests = JSON.parse(read('bundle-digests.json')) as { keeper: string; transfer: string }
assert.equal(digests.keeper, sha256(['49th40-local-keeper-preview-v1', read('keeper-preview.md'), stringify(JSON.parse(read('keeper.json')) as unknown), exact.keeperDigest].join('\n')))
assert.equal(digests.transfer, sha256(['49th40-local-transfer-preview-v1', read('transfer-preview.md'), stringify(JSON.parse(read('route.json')) as unknown), stringify(SCOPE), exact.transferDigest].join('\n')))
const base = '27678047f248b9fdfcf1ac79d7947540c5e8f799'
for (const file of new Set([...CODE_FILES, ...KEEPER_FILES, ...TRANSFER_FILES])) {
  const source = spawnSync('git', ['show', `${base}:${file}`])
  assert.equal(source.status, 0)
  assert.equal(sha256(readFileSync(file)), sha256(source.stdout), `Existing approval dependency changed: ${file}`)
}
for (const path of ['public', 'deployments', 'scripts', 'contracts', 'docs/evidence/49th-38']) {
  const diff = spawnSync('git', ['diff', base, '--', path], { encoding: 'utf8' })
  assert.equal(diff.status, 0); assert.equal(diff.stdout, '', `Preserved bundle/path changed: ${path}`)
}
// Every source file hashed by the evidence must also be exactly the tested source revision.
for (const row of exact.keeper) {
  const source = spawnSync('git', ['show', `${evidence.sourceRevision}:${row.file}`])
  assert.equal(source.status, 0, `Evidence source revision lacks ${row.file}`)
  assert.equal(sha256(source.stdout), row.sha256, `Source revision differs: ${row.file}`)
}
for (const file of readdirSync(directory)) {
  const text = read(file)
  for (const key of Object.values(DEV)) assert(!text.toLowerCase().includes(key.toLowerCase()), `Private development key appears in ${file}`)
  assert(!text.includes('private-keeper.json') || file.endsWith('.md'), 'Private configuration exposed')
}
console.log(stringify({ exactKeeperAndTransferManifests: true, testedSourceRevision: evidence.sourceRevision, exactFixtureDigests: true, existingApprovalsPreserved: true, keyless: true, publicRoutes: 'closed' }))
