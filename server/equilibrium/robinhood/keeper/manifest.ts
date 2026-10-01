import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { CODE_FILES } from '../../evm/approval'
import { KEEPER_FILES } from '../../keeper/approval'
import { TRANSFER_FILES } from '../../evm/transfers/config'

const root = 'server/equilibrium/robinhood'
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const list = (files: string[]) => [...new Set(files)].sort().map((file) => ({ file, sha256: sha256(readFileSync(file)) }))
export function manifests() {
  const local = readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).map((f) => `${root}/${f}`)
  // Include frozen dependencies too: a local approval is never reinterpreted as public authorization.
  const dependencies = [...CODE_FILES, ...KEEPER_FILES, ...TRANSFER_FILES, 'server/equilibrium/keeper/fork.ts', 'server/equilibrium/evm/fork.ts']
  const keeper = list([...dependencies, ...local])
  const transfer = list([...dependencies, ...local])
  return { mode: 'fork-only; no public approval', sourceHeads: { stacked: '27678047f248b9fdfcf1ac79d7947540c5e8f799', composed: '22adede0b82f59cb7624af788d7ef482b244bb18' }, keeper, transfer, keeperDigest: sha256('49th40-keeper-v1\n' + JSON.stringify(keeper)), transferDigest: sha256('49th40-transfer-v1\n' + JSON.stringify(transfer)) }
}
