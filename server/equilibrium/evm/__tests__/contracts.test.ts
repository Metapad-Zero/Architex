import { describe, expect, test } from 'bun:test'
import { CODE, linked, predict } from '../contracts'
import { CODE_FILES, approvalDigest, assertApproved } from '../approval'
import { l1FeeOf, layout, weiOf } from '../adapter'

const LIB = '0x00000000000000000000000000000000000000aa'
describe('pinned EVM bytecode and address layout', () => {
  test('NTT code links the library everywhere and fits EIP-170 once deployed', () => {
    for (const entry of [CODE.NttManager, CODE.WormholeTransceiver]) {
      expect(() => linked(entry)).toThrow('must be deployed and linked first')
      const code = linked(entry, { TransceiverStructs: LIB })
      expect(code.includes('__$')).toBe(false)
      expect(code.split(LIB.slice(2)).length - 1).toBe(entry.links[0].starts.length)
    }
    // Creation code is an upper bound on runtime size here; NttManager must stay deployable.
    expect((CODE.NttManager.bytecode.length - 2) / 2).toBeLessThan(24_576 + 8_000)
  })
  test('every address a job creates is fixed by the job id and the executors before anything is sent', () => {
    const chain = (executor: string) => ({ executor, transceiverStructs: LIB, core: '0x00000000000000000000000000000000000000c0', wormholeChainId: 71 }) as never
    const job = { id: `0x${'1'.repeat(64)}`, request: { canonical: { name: 'Equilibrium', symbol: 'EQL', issuance: '1000000000000' } } } as never
    const a = layout(job, { arc: chain('0x00000000000000000000000000000000000000e1'), base: chain('0x00000000000000000000000000000000000000e2') })
    const b = layout(job, { arc: chain('0x00000000000000000000000000000000000000e1'), base: chain('0x00000000000000000000000000000000000000e2') })
    expect(a.canonical).toBe(b.canonical)
    expect(new Set([a.canonical, a.spoke, a.hub.proxy, a.hub.transceiver, a.spokeManager.proxy, a.spokeManager.transceiver]).size).toBe(6)
    expect(predict('0x00000000000000000000000000000000000000e1', a.op('canonical:arc'), 0, a.canonicalInit)).toBe(a.canonical)
  })
  test('testnet broadcasting needs approval of this exact preview and configuration; forks stay local', () => {
    const digest = approvalDigest('preview', 'config', [])
    expect(() => assertApproved('testnet', 'preview', 'config', undefined, [], [])).toThrow(digest)
    expect(() => assertApproved('testnet', 'preview', 'config!', digest, [], [])).toThrow('Required EQUILIBRIUM_APPROVAL')
    expect(() => assertApproved('testnet', 'preview', 'config', digest, [], [])).not.toThrow()
    expect(() => assertApproved('fork', '', '', undefined, ['https://sepolia.base.org'])).toThrow('local anvil forks only')
    expect(() => assertApproved('fork', '', '', undefined, ['http://127.0.0.1:18545'])).not.toThrow()
  })
})

describe('the approval binds code as well as preview and configuration', () => {
  test('changing any manifest entry changes the digest and refuses the old approval', () => {
    const manifest = [{ file: 'server/equilibrium/evm/adapter.ts', sha256: 'a'.repeat(64) }]
    const approved = approvalDigest('preview', 'config', manifest)
    const edited = [{ file: 'server/equilibrium/evm/adapter.ts', sha256: 'b'.repeat(64) }]
    expect(approvalDigest('preview', 'config', edited)).not.toBe(approved)
    expect(() => assertApproved('testnet', 'preview', 'config', approved, [], edited)).toThrow('Required EQUILIBRIUM_APPROVAL')
    expect(() => assertApproved('testnet', 'preview', 'config', approved, [], manifest)).not.toThrow()
  })
})

describe('OP Stack receipt fees', () => {
  const receipt = (l1Fee: unknown) => ({ gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n, transactionHash: '0x01', l1Fee }) as never
  test('a hex l1Fee, including 0x0, is added as a number, never concatenated', () => {
    expect(l1FeeOf(receipt('0x0'))).toBe(0n)
    expect(l1FeeOf(receipt('0x10'))).toBe(16n)
    expect(weiOf(receipt('0x10'))).toBe(21_000_000_000_016n)
    expect(weiOf(receipt(16n))).toBe(21_000_000_000_016n)
    expect(weiOf(receipt(undefined))).toBe(21_000_000_000_000n)
  })
  test('an unreadable l1Fee stops accounting instead of corrupting it', () => {
    expect(() => l1FeeOf(receipt('not-a-fee'))).toThrow('Unreadable l1Fee')
  })
  test('the payer-side signer is part of the approved code', () => {
    expect(CODE_FILES).toContain('scripts/equilibrium-evm-launch.ts')
  })
})
