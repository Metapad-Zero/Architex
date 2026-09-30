import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { encodeAbiParameters, keccak256 } from 'viem'
import { KEEPER_CODE, LEG_TUPLE, cycleId, keeperInit, legDigest, legId, legStruct } from '../contracts'
import type { LegPlan } from '../types'

const plan: LegPlan = {
  chain: 'arc', chainId: 5042002, keeper: '0x00000000000000000000000000000000000000c1', cycle: 'cycle-1', kind: 'buy',
  id: `0x${'0'.repeat(64)}`, digest: `0x${'0'.repeat(64)}`,
  pool: '0x00000000000000000000000000000000000000a1', tokens: '1000000000', limit: '1010000000', deadline: 1_800_000_600, fromBlock: '1000',
}
const parts = { cycle: plan.cycle, kind: plan.kind, chainId: plan.chainId, keeper: plan.keeper, pool: plan.pool, tokens: plan.tokens, limit: plan.limit, deadline: plan.deadline }

describe('keeper leg binding', () => {
  test('the pinned keeper code matches its recorded hash', () => {
    expect(createHash('sha256').update(KEEPER_CODE.bytecode).digest('hex')).toBe(KEEPER_CODE.sha256)
    expect(KEEPER_CODE.bytecode.startsWith('0x')).toBe(true)
  })

  test('the keeper manifest is disjoint from the launch manifest, so approvals stay independent', async () => {
    const { KEEPER_FILES } = await import('../approval')
    const { CODE_FILES } = await import('../../evm/approval')
    expect(KEEPER_FILES.filter((file) => (CODE_FILES as readonly string[]).includes(file))).toEqual([])
    expect(readFileSync('server/equilibrium/evm/bytecode.json', 'utf8')).not.toContain('EquilibriumKeeper')
  })

  test('receipt accounting is pinned by the separate keeper approval gate', async () => {
    const { keeperManifest, keeperApprovalDigest, assertKeeperApproved } = await import('../approval')
    const manifest = keeperManifest()
    const feeFile = 'server/equilibrium/keeper/fees.ts'
    const fee = manifest.find((entry) => entry.file === feeFile)!
    expect(fee.sha256).toBe(createHash('sha256').update(readFileSync(feeFile)).digest('hex'))
    const old = keeperApprovalDigest('preview', 'config', manifest.filter((entry) => entry.file !== feeFile))
    const current = keeperApprovalDigest('preview', 'config', manifest)
    expect(current).not.toBe(old)
    expect(() => assertKeeperApproved('testnet', 'preview', 'config', old, [], manifest)).toThrow('without owner approval')
    expect(() => assertKeeperApproved('testnet', 'preview', 'config', current, [], manifest)).not.toThrow()
    expect(() => assertKeeperApproved('fork', 'preview', 'config', undefined, ['https://sepolia.base.org'], manifest)).toThrow('local anvil forks only')
  })

  test('every leg id field changes the id: chain, keeper, pool, size, limit, deadline and kind', () => {
    const base = legId(parts)
    const variants = [
      { ...parts, chainId: 84532 }, { ...parts, keeper: '0x00000000000000000000000000000000000000c2' as const },
      { ...parts, pool: '0x00000000000000000000000000000000000000a2' as const }, { ...parts, tokens: '999999999' },
      { ...parts, limit: '1010000001' }, { ...parts, deadline: parts.deadline + 1 }, { ...parts, kind: 'sell' },
      { ...parts, cycle: 'cycle-2' },
    ]
    const ids = variants.map(legId)
    expect(new Set([base, ...ids]).size).toBe(variants.length + 1)
  })

  test('the digest is keccak256 over the exact struct the contract receives', () => {
    expect(legDigest(plan)).toBe(keccak256(encodeAbiParameters(LEG_TUPLE, [legStruct(plan)])))
    expect(legStruct(plan).cycle).toBe(cycleId('cycle-1'))
    expect(legStruct(plan).kind).toBe(0)
  })

  test('changing any leg field changes the digest the vault will hold', () => {
    const digests = new Set([
      legDigest(plan), legDigest({ ...plan, tokens: '1' }), legDigest({ ...plan, limit: '1' }),
      legDigest({ ...plan, deadline: 1 }), legDigest({ ...plan, kind: 'recover' }), legDigest({ ...plan, chainId: 1 }),
    ])
    expect(digests.size).toBe(6)
  })

  test('the constructor arguments are appended to the pinned creation code', () => {
    const init = keeperInit({
      owner: '0x00000000000000000000000000000000000000d1', token: '0x00000000000000000000000000000000000000e1',
      quote: '0x00000000000000000000000000000000000000f1', pool: plan.pool, venue: 'architex-pair',
      maxTokensPerLeg: 1n, maxQuotePerLeg: 2n, spendCap: 3n, recoveryReserve: 4n, drainCap: 5n, maxOpenCycles: 1,
    })
    expect(init.startsWith(KEEPER_CODE.bytecode)).toBe(true)
    expect(init.length).toBe(KEEPER_CODE.bytecode.length + 11 * 64)
  })
})
