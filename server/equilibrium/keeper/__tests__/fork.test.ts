/**
 * KEEPER FORK REHEARSAL against the real Architex pair on Arc and the real Uniswap v3 pool on Base,
 * at the same pinned blocks the launch rehearsal uses. Opt-in, because it starts two anvil forks from
 * public RPCs:
 *
 *   EQUILIBRIUM_FORK=1 bun test server/equilibrium/keeper/__tests__/fork.test.ts
 *
 * What it proves, all from chain reads: both pools quoted for the same quantity through the vaults'
 * own `probe`, the executed amounts equalling those quotes, every bound refusing what it is meant to
 * refuse, reserved recovery capacity surviving an open position, a repeat or misdirected leg being
 * rejected by the destination chain, and a halted partial cycle being recovered after a restart.
 *
 * What it does not prove: public Arc USDC precompile behaviour, real Base L1 data fees, or anything
 * about a live keeper. Fork substitutions are listed in fork.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { DEV } from '../../evm/fork'
import { keeperAbi, legStruct } from '../contracts'
import { createKeeper, type KeeperHandle } from '../keeper'
import { decide, decideRecovery } from '../policy'
import { readChainQuote } from '../quotes'
import { KeeperStore } from '../store'
import { tick } from '../run'
import type { KeeperChain, LegPlan } from '../types'
import { FORK_BOUNDS, FORK_INVENTORY, forkReader, keeperForkEnvironment, type KeeperFork } from '../fork'

const enabled = process.env.EQUILIBRIUM_FORK === '1'
const suite = enabled ? describe : describe.skip
const test_ = (name: string, fn: () => Promise<void>) => test(name, fn, 600_000)
const ZERO: Hex = `0x${'0'.repeat(64)}`
const TOKENS = 1_000_000_000n
const operator = privateKeyToAccount(DEV.operator)

let env: KeeperFork
let dir: string
let store: KeeperStore
let keeper: KeeperHandle
let read: ReturnType<typeof forkReader>

const client = (chain: KeeperChain) => createPublicClient({ transport: http(env[chain].url) })
const wallet = (chain: KeeperChain) => createWalletClient({ account: operator, transport: http(env[chain].url) })

async function inventory(chain: KeeperChain) {
  return {
    tokens: await read.balance(chain, env.tokens[chain], env.config[chain].keeper),
    quote: await read.balance(chain, env.quotes[chain], env.config[chain].keeper),
  }
}
async function vaultState(chain: KeeperChain) {
  const at = { address: env.config[chain].keeper, abi: keeperAbi } as const
  return {
    spent: await client(chain).readContract({ ...at, functionName: 'spentQuote' }),
    received: await client(chain).readContract({ ...at, functionName: 'receivedQuote' }),
    open: Number(await client(chain).readContract({ ...at, functionName: 'openCycles' })),
    halted: await client(chain).readContract({ ...at, functionName: 'halted' }),
  }
}
async function legRuns(chain: KeeperChain, leg: Hex) {
  const event = keeperAbi.find((item) => item.type === 'event' && item.name === 'LegRun')!
  const logs = await client(chain).getLogs({ address: env.config[chain].keeper, event, args: { leg }, fromBlock: env.config[chain].fromBlock })
  return logs.length
}
/** Await a rejection and match its message. Explicit, so the assertion is always actually awaited. */
async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown
  try { await promise } catch (cause) { error = cause }
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toMatch(pattern)
}

/** Would a withdrawal be accepted right now, and if not, which bound refused it? */
async function canWithdraw(chain: KeeperChain, asset: `0x${string}`, amount: bigint): Promise<{ ok: true } | { error?: string }> {
  try {
    await client(chain).simulateContract({ account: operator, address: env.config[chain].keeper, abi: keeperAbi, functionName: 'withdraw', args: [asset, operator.address, amount] })
    return { ok: true }
  } catch (cause) {
    const revert = cause instanceof BaseError ? cause.walk((e) => e instanceof ContractFunctionRevertedError) : null
    if (revert instanceof ContractFunctionRevertedError) return { error: revert.data?.errorName }
    throw cause
  }
}

/** Submit a leg straight to a vault and return the custom error it reverted with. */
async function refusal(chain: KeeperChain, plan: LegPlan): Promise<{ name?: string; args?: readonly unknown[] }> {
  try {
    await client(chain).simulateContract({ account: operator, address: env.config[chain].keeper, abi: keeperAbi, functionName: 'run', args: [legStruct(plan)] })
  } catch (cause) {
    const revert = cause instanceof BaseError ? cause.walk((e) => e instanceof ContractFunctionRevertedError) : null
    if (revert instanceof ContractFunctionRevertedError) return { name: revert.data?.errorName, args: revert.data?.args }
    throw cause
  }
  throw new Error('The vault accepted a leg it should have refused.')
}
const legOf = (cycle: string, kind: LegPlan['kind']) => store.get(cycle)!.legs.find((leg) => leg.kind === kind)!
const transferAbi = [{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const
/** Operator-funded inventory, the only way a vault ever gains tokens. The keeper cannot mint. */
async function fundVault(chain: KeeperChain, amount: bigint) {
  const hash = await wallet(chain).writeContract({ account: operator, chain: null, address: env.tokens[chain], abi: transferAbi, functionName: 'transfer', args: [env.config[chain].keeper, amount] })
  await client(chain).waitForTransactionReceipt({ hash })
}

suite('EQUILIBRIUM keeper on pinned testnet forks', () => {
  beforeAll(async () => {
    env = await keeperForkEnvironment()
    mkdirSync(join(process.cwd(), 'output'), { recursive: true })
    dir = mkdtempSync(join(process.cwd(), 'output', 'keeper-fork-'))
    store = new KeeperStore(join(dir, 'keeper.sqlite'))
    keeper = createKeeper(env.config, store)
    read = forkReader(env)
    await keeper.verify()
  }, 900_000)
  afterAll(() => { store?.close(); env?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }) })

  test_('the vaults are the ones the configuration claims, with the bounds it claims', async () => {
    for (const chain of ['arc', 'base'] as const) {
      const at = { address: env.config[chain].keeper, abi: keeperAbi } as const
      expect((await client(chain).readContract({ ...at, functionName: 'owner' })).toLowerCase()).toBe(operator.address.toLowerCase())
      expect((await client(chain).readContract({ ...at, functionName: 'pool' })).toLowerCase()).toBe(env.pools[chain].toLowerCase())
      expect(await client(chain).readContract({ ...at, functionName: 'maxTokensPerLeg' })).toBe(FORK_BOUNDS.maxTokensPerLeg)
      expect(await client(chain).readContract({ ...at, functionName: 'spendCap' })).toBe(FORK_BOUNDS.spendCap)
      expect(await client(chain).readContract({ ...at, functionName: 'recoveryReserve' })).toBe(FORK_BOUNDS.recoveryReserve)
      expect(Number(await client(chain).readContract({ ...at, functionName: 'maxOpenCycles' }))).toBe(FORK_BOUNDS.maxOpenCycles)
      expect(await inventory(chain)).toEqual({ tokens: FORK_INVENTORY.tokens, quote: FORK_INVENTORY.quote })
    }
  })

  test_('quoting both pools for the same quantity spends nothing and costs the keeper no inventory', async () => {
    const before = { arc: await inventory('arc'), base: await inventory('base') }
    const arc = await readChainQuote(client('arc'), env.config.arc, operator.address, TOKENS)
    const base = await readChainQuote(client('base'), env.config.base, operator.address, TOKENS)
    expect(arc.tokens).toBe(TOKENS.toString())
    expect(base.tokens).toBe(arc.tokens)
    expect(BigInt(arc.buyCost)).toBeGreaterThan(0n)
    expect(BigInt(base.sellProceeds)).toBeGreaterThan(BigInt(arc.buyCost))
    expect({ arc: await inventory('arc'), base: await inventory('base') }).toEqual(before)
  })

  let firstBuyCost: bigint
  let firstProceeds: bigint
  test_('a full cycle executes at exactly the quoted amounts on both real pools', async () => {
    const quoted = await keeper.snapshot(TOKENS)
    expect(decide(quoted, env.config.policy).reason).toBe('ok')
    const before = { arc: await inventory('arc'), base: await inventory('base') }

    const cycle = await keeper.runCycle(TOKENS, { id: 'fork-cycle-1' })
    expect(cycle.state).toBe('closed')
    const buy = cycle.legs.find((leg) => leg.kind === 'buy')!
    const sell = cycle.legs.find((leg) => leg.kind === 'sell')!
    expect([buy.chain, sell.chain]).toEqual(['arc', 'base'])
    // The executed amounts are the quoted amounts: the probe is the pool, not a reimplementation.
    expect(buy.result!.amountIn).toBe(quoted.quotes.arc.buyCost)
    expect(buy.result!.amountOut).toBe(TOKENS.toString())
    expect(sell.result!.amountIn).toBe(TOKENS.toString())
    expect(sell.result!.amountOut).toBe(quoted.quotes.base.sellProceeds)
    firstBuyCost = BigInt(buy.result!.amountIn)
    firstProceeds = BigInt(sell.result!.amountOut)

    // Inventory moved by exactly those amounts, and by nothing else.
    expect(await inventory('arc')).toEqual({ tokens: before.arc.tokens + TOKENS, quote: before.arc.quote - firstBuyCost })
    expect(await inventory('base')).toEqual({ tokens: before.base.tokens - TOKENS, quote: before.base.quote + firstProceeds })
    expect(await vaultState('arc')).toMatchObject({ spent: firstBuyCost, open: 0, halted: false })
    expect(await vaultState('base')).toMatchObject({ received: firstProceeds, open: 0, halted: false })
    // Keeper profit is the cycle's own result, gas included, and nothing else.
    expect(cycle.net).toBe((firstProceeds - firstBuyCost - BigInt(buy.result!.cost) - BigInt(sell.result!.cost)).toString())
    expect(store.totals()).toEqual({ loss: '0', net: cycle.net!, closed: 1 })
    expect(await legRuns('arc', buy.plan.id)).toBe(1)
    expect(await legRuns('base', sell.plan.id)).toBe(1)
  })

  test_('the keeper never mints, and the pools hold what the keeper paid them', async () => {
    // Token supply is untouched by trading: the keeper only moves inventory it already owned.
    const supply = await client('arc').readContract({ address: env.tokens.arc, abi: [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const, functionName: 'totalSupply' })
    expect(supply).toBe(1_000_000_000_000n)
    const pooled = await read.balance('arc', env.quotes.arc, env.pools.arc)
    expect(pooled).toBe(500_000_000_000n + firstBuyCost)
    expect(await read.balance('arc', env.tokens.arc, env.pools.arc)).toBe(500_000_000_000n - TOKENS)
  })

  test_('a close attestation that never lands leaves a finished trade the next reconcile completes', async () => {
    const before = { arc: await inventory('arc'), base: await inventory('base') }
    await rejects(keeper.runCycle(TOKENS, { id: 'fork-cycle-attest', failAttest: true }), /close attestation on the purchase vault did not land/)

    // Both legs traded; only the close is outstanding. Nothing is at risk, but everything is blocked.
    const stuck = store.get('fork-cycle-attest')!
    expect(stuck.state).toBe('open')
    expect(stuck.legs.map((leg) => `${leg.kind}=${leg.state}`)).toEqual(['buy=settled', 'sell=settled'])
    expect(stuck.note).toContain('the next reconcile finishes it')
    expect(store.unresolved()).toHaveLength(0)
    expect(store.untouched()).toHaveLength(0)
    expect(store.unfinished().map((cycle) => cycle.id)).toEqual(['fork-cycle-attest'])
    // The purchase vault is the backstop: it still reports the position, so nothing may trade,
    // resume or withdraw even though the record's own exposure list is empty.
    expect((await vaultState('arc')).open).toBe(1)
    expect(decide(await keeper.snapshot(TOKENS), env.config.policy).reason).toBe('unresolved_exposure')
    const blocked: LegPlan = { ...stuck.legs[0].plan, cycle: 'fork-blocked', id: `0x${'9'.repeat(64)}`, deadline: 2_000_000_000 }
    expect((await refusal('arc', blocked)).name).toBe('TooManyOpenCycles')
    expect(await canWithdraw('arc', env.quotes.arc, 1n)).toEqual({ error: 'OpenExposure' })
    await rejects(keeper.resume(), /Run reconcile first/)

    // One reconcile attests it and closes it. No trade is repeated: inventory is untouched.
    const touched = await keeper.reconcile()
    expect(touched.map((cycle) => cycle.id)).toContain('fork-cycle-attest')
    const closed = store.get('fork-cycle-attest')!
    expect(closed.state).toBe('closed')
    expect(BigInt(closed.net!)).toBeGreaterThan(0n)
    expect(await inventory('arc')).toEqual({ tokens: before.arc.tokens + TOKENS, quote: before.arc.quote - BigInt(closed.legs[0].result!.amountIn) })
    expect(await inventory('base')).toEqual({ tokens: before.base.tokens - TOKENS, quote: before.base.quote + BigInt(closed.legs[1].result!.amountOut) })
    expect(await legRuns('arc', closed.legs[0].plan.id)).toBe(1)
    expect(await legRuns('base', closed.legs[1].plan.id)).toBe(1)

    // The vault is free again, a second reconcile is a no-op, and the keeper may trade.
    expect((await vaultState('arc')).open).toBe(0)
    expect(store.unfinished()).toHaveLength(0)
    expect(await keeper.reconcile()).toHaveLength(0)
    expect(await canWithdraw('arc', env.quotes.arc, 1n)).toEqual({ ok: true })
    expect(decide(await keeper.snapshot(TOKENS), env.config.policy).reason).toBe('ok')
  })

  test_('replaying a settled leg executes nothing, on the chain that ran it', async () => {
    const buy = legOf('fork-cycle-1', 'buy')
    const before = await inventory('arc')
    const refused = await refusal('arc', buy.plan)
    expect(refused.name).toBe('LegDone')
    expect(await inventory('arc')).toEqual(before)
    expect(await legRuns('arc', buy.plan.id)).toBe(1)
  })

  test_('a leg planned for Arc is refused by the Base vault, and the reverse', async () => {
    const buy = legOf('fork-cycle-1', 'buy')
    const sell = legOf('fork-cycle-1', 'sell')
    expect((await refusal('base', buy.plan)).name).toBe('WrongChain')
    expect((await refusal('arc', sell.plan)).name).toBe('WrongChain')
    // Its id never existed on the other chain either, so nothing there can ever be bound to it.
    expect(await client('base').readContract({ address: env.config.base.keeper, abi: keeperAbi, functionName: 'legOf', args: [buy.plan.id] })).toBe(ZERO)
  })

  test_('a leg planned against a stale quote expires on the destination chain', async () => {
    const stale: LegPlan = { ...legOf('fork-cycle-1', 'buy').plan, cycle: 'fork-stale', id: `0x${'5'.repeat(64)}`, deadline: 1 }
    const refused = await refusal('arc', stale)
    expect(refused.name).toBe('LegExpired')
    expect(refused.args?.[0]).toBe(1n)
  })

  test_('a leg aimed at another pool on the right chain is refused', async () => {
    const misdirected: LegPlan = { ...legOf('fork-cycle-1', 'buy').plan, cycle: 'fork-misdirected', id: `0x${'6'.repeat(64)}`, pool: env.pools.base }
    expect((await refusal('arc', misdirected)).name).toBe('WrongPool')
  })

  test_('a failed sale halts both vaults and leaves the position open with its recovery funded', async () => {
    const before = await inventory('arc')
    const cycle = await keeper.runCycle(TOKENS, { id: 'fork-cycle-2', failSell: true })
    expect(cycle.state).toBe('halted')
    expect(cycle.note).toContain('position is open on the purchase market')
    const buy = cycle.legs.find((leg) => leg.kind === 'buy')!
    expect(buy.state).toBe('settled')
    expect(cycle.legs.some((leg) => leg.kind === 'sell')).toBe(false)
    expect(await inventory('arc')).toEqual({ tokens: before.tokens + TOKENS, quote: before.quote - BigInt(buy.result!.amountIn) })
    // Reserved recovery capacity: the unwind is funded before the position exists, and still is.
    expect((await inventory('arc')).quote).toBeGreaterThanOrEqual(FORK_BOUNDS.recoveryReserve)
    for (const chain of ['arc', 'base'] as const) expect((await vaultState(chain)).halted).toBe(true)
    expect(await vaultState('arc')).toMatchObject({ open: 1 })
    expect(store.unresolved().map((c) => c.id)).toEqual(['fork-cycle-2'])
  })

  test_('the deliberate-failure rehearsal device is refused outside fork mode', async () => {
    const testnet = createKeeper({ ...env.config, mode: 'testnet', approval: `0x${'0'.repeat(64)}` }, store)
    await rejects(testnet.runCycle(TOKENS, { id: 'fork-never', failSell: true }), /fork rehearsal device/)
    await rejects(testnet.runCycle(TOKENS, { id: 'fork-never', failAttest: true }), /fork rehearsal device/)
    expect(store.get('fork-never')).toBeUndefined()
  })

  test_('a halted keeper refuses a new cycle from both the record and the chain', async () => {
    const snapshot = await keeper.snapshot(TOKENS)
    const decision = decide(snapshot, env.config.policy)
    expect(decision.candidate).toBeNull()
    expect(decision.reason).toBe('halted')
    await rejects(keeper.runCycle(TOKENS, { id: 'fork-cycle-3' }), /halted/)
    // The vault refuses too, whatever a runner believes.
    const opening: LegPlan = { ...legOf('fork-cycle-2', 'buy').plan, cycle: 'fork-cycle-3', id: `0x${'7'.repeat(64)}`, deadline: 2_000_000_000 }
    expect((await refusal('arc', opening)).name).toBe('Paused')
  })

  test_('a restart re-reads the exposure from the record and stays halted', async () => {
    const path = join(dir, 'keeper.sqlite')
    store.close()
    store = new KeeperStore(path)
    keeper = createKeeper(env.config, store)
    expect(store.unresolved().map((c) => c.id)).toEqual(['fork-cycle-2'])
    const outcome = await tick(keeper, store, TOKENS)
    expect(outcome.cycle).toBeNull()
    expect(outcome.reconciled).toContain('fork-cycle-2')
    expect(outcome.stop).toContain('fork-cycle-2')
    expect(store.get('fork-cycle-2')!.state).toBe('halted')
    expect((await vaultState('arc')).open).toBe(1)
  })

  test_('recovery is refused, and the position stays open, when the unwind would pass the loss cap', async () => {
    const tight = createKeeper({ ...env.config, policy: { ...env.config.policy, lossCap: '1000' } }, store)
    await rejects(tight.recover('fork-cycle-2'), /stays open and the keeper stays halted/)
    expect(store.get('fork-cycle-2')!.state).toBe('halted')
    expect((await vaultState('arc')).open).toBe(1)
    expect(store.get('fork-cycle-2')!.legs.some((leg) => leg.kind === 'recover' && leg.state === 'settled')).toBe(false)
  })

  test_('recovery unwinds on the purchase market inside the loss budget, and only then does resume work', async () => {
    const buy = legOf('fork-cycle-2', 'buy')
    const before = await inventory('arc')
    const snapshot = await keeper.snapshot(TOKENS)
    const planned = decideRecovery(snapshot, env.config.policy, { cycle: 'fork-cycle-2', buy: 'arc', tokens: TOKENS.toString(), spent: buy.result!.amountIn })
    expect(planned).toHaveProperty('floor')

    const cycle = await keeper.recover('fork-cycle-2')
    expect(cycle.state).toBe('recovered')
    const recovery = cycle.legs.find((leg) => leg.kind === 'recover')!
    expect(recovery.chain).toBe('arc')
    expect(recovery.result!.amountIn).toBe(TOKENS.toString())
    expect(BigInt(recovery.result!.amountOut)).toBeGreaterThanOrEqual(BigInt((planned as { floor: string }).floor))
    expect(await inventory('arc')).toEqual({ tokens: before.tokens - TOKENS, quote: before.quote + BigInt(recovery.result!.amountOut) })
    // Unwinding at a worse price than the purchase is a loss, and it is reported as one.
    expect(BigInt(cycle.net!)).toBeLessThan(0n)
    expect(BigInt(store.totals().loss)).toBe(-BigInt(cycle.net!))
    expect(BigInt(store.totals().loss)).toBeLessThan(BigInt(env.config.policy.lossCap))
    expect((await vaultState('arc')).open).toBe(0)

    await keeper.resume()
    for (const chain of ['arc', 'base'] as const) expect((await vaultState(chain)).halted).toBe(false)
    expect(store.unresolved()).toHaveLength(0)
  })

  test_('a recovery whose terminal state never got written is finished by reconcile too', async () => {
    // The recovery transaction clears the position on-chain, then the terminal state is a local
    // write. A stop in between leaves the chain clear and the record halted; rewind to exactly that.
    const before = await inventory('arc')
    store.setCycle('fork-cycle-2', 'halted', Math.floor(Date.now() / 1000), { note: 'Rewound: the recovered state was never written.' })
    expect(store.unresolved()).toHaveLength(0)
    expect(store.unfinished().map((cycle) => cycle.id)).toEqual(['fork-cycle-2'])

    const touched = await keeper.reconcile()
    expect(touched.map((cycle) => cycle.id)).toContain('fork-cycle-2')
    expect(store.get('fork-cycle-2')!.state).toBe('recovered')
    expect(BigInt(store.get('fork-cycle-2')!.net!)).toBeLessThan(0n)
    // Nothing was re-traded: the recovery leg had already run and its id is bound.
    expect(await inventory('arc')).toEqual(before)
    expect(await legRuns('arc', legOf('fork-cycle-2', 'recover').plan.id)).toBe(1)
    expect(store.unfinished()).toHaveLength(0)
  })

  test_('the keeper trades again after recovery, and reports keeper profit separately from the loss', async () => {
    const totalsBefore = store.totals()
    const cycle = await keeper.runCycle(TOKENS, { id: 'fork-cycle-4' })
    expect(cycle.state).toBe('closed')
    expect(BigInt(cycle.net!)).toBeGreaterThan(0n)
    const totals = store.totals()
    expect(totals.closed).toBe(totalsBefore.closed + 1)
    // The loss from the recovered cycle is not netted away by a later profit.
    expect(totals.loss).toBe(totalsBefore.loss)
    expect(BigInt(totals.net)).toBe(BigInt(totalsBefore.net) + BigInt(cycle.net!))
  })

  test_('an exhausted selling inventory stops that direction and names the refill as a separate route', async () => {
    // Two closed cycles have already sold the Base side down; make it explicit and empty it.
    const held = (await inventory('base')).tokens
    if (held > 0n) {
      const hash = await wallet('base').writeContract({
        account: operator, chain: null, address: env.config.base.keeper, abi: keeperAbi,
        functionName: 'withdraw', args: [env.tokens.base, operator.address, held],
      })
      await client('base').waitForTransactionReceipt({ hash })
    }
    expect((await inventory('base')).tokens).toBe(0n)
    const decision = decide(await keeper.snapshot(TOKENS), env.config.policy)
    expect(decision.candidate).toBeNull()
    expect(decision.reason).toBe('inventory')
    expect(decision.detail).toContain('Refill is a separate authorized route')
    await rejects(keeper.runCycle(TOKENS, { id: 'fork-cycle-5' }), /Refill is a separate authorized route/)
    expect(store.get('fork-cycle-5')).toBeUndefined()
  })

  test_('the configured session spending cap stops the keeper, in the runner and in the vault', async () => {
    // Operator-funded refill: the only way a vault regains tokens, and not something the keeper does.
    await fundVault('base', FORK_INVENTORY.tokens)
    const snapshot = await keeper.snapshot(TOKENS)
    const spent = BigInt(snapshot.quotes.arc.spentQuote)
    const need = BigInt(snapshot.quotes.arc.buyCost) + BigInt(snapshot.quotes.arc.legCost)
    // Four purchases in, a fifth would pass the cap the vault was deployed with.
    expect(spent + need).toBeGreaterThan(BigInt(env.config.policy.spendCap))
    expect(decide(snapshot, env.config.policy).reason).toBe('spend_cap')
    await rejects(keeper.runCycle(TOKENS, { id: 'fork-cycle-6' }), /session spending cap/)
    expect(store.get('fork-cycle-6')).toBeUndefined()
    // The same snapshot under a wider cap is executable, so the cap is what refused it and nothing else.
    expect(decide(snapshot, { ...env.config.policy, spendCap: (spent + need + 1n).toString() }).reason).toBe('ok')
    // And the vault refuses the purchase itself, whatever policy a runner were configured with.
    const overspend: LegPlan = {
      ...legOf('fork-cycle-4', 'buy').plan, cycle: 'fork-overspend', id: `0x${'8'.repeat(64)}`,
      limit: ((BigInt(snapshot.quotes.arc.buyCost) * 10_050n) / 10_000n).toString(), deadline: snapshot.quotes.arc.observedAt + 600,
    }
    const refused = await refusal('arc', overspend)
    expect(refused.name).toBe('SpendCapExceeded')
    expect(refused.args?.[1]).toBe(FORK_BOUNDS.spendCap)
  })

  test_('a quote left behind by its own chain is refused as stale', async () => {
    const snapshot = await keeper.snapshot(TOKENS)
    await read.mine('arc', env.config.policy.maxBlockLag + 5, env.config.policy.maxQuoteAgeSeconds)
    const lagged = { ...snapshot, lag: await (async () => {
      const head = await client('arc').getBlock({ blockTag: 'latest' })
      return { ...snapshot.lag, arc: { blocks: Number((head.number ?? 0n) - BigInt(snapshot.quotes.arc.blockNumber)), seconds: Number(head.timestamp) - snapshot.quotes.arc.observedAt } }
    })() }
    expect(lagged.lag.arc.blocks).toBeGreaterThan(env.config.policy.maxBlockLag)
    const decision = decide(lagged, env.config.policy)
    expect(decision.candidate).toBeNull()
    expect(decision.reason).toBe('stale_quote')
  })

  test_('a size no pool can fill is refused rather than partially executed', async () => {
    await rejects(readChainQuote(client('arc'), env.config.arc, operator.address, 10_000_000_000_000n), /cannot quote|could only fill/)
  })
})
