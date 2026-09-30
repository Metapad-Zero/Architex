/**
 * Arc testnet + Base Sepolia release gate for the EQUILIBRIUM Arc–Base pilot.
 *
 *   bun run equilibrium:infra plan --operator <0x> --payer <0x> --recipient <0x>   read-only; writes the config once
 *   bun run equilibrium:infra deploy        EQUILIBRIUM_OPERATOR_KEY + EQUILIBRIUM_APPROVAL; library + executor per chain
 *   bun run equilibrium:infra check         read-only, after deploy: deployment, Base inventory, payer, operator gas
 *   bun run equilibrium:infra request [--out request.json]   the one approved pilot request, fresh expiry
 *
 * `plan` predicts the NTT library and executor addresses from the operator's next nonces and
 * writes deployments/equilibrium-testnet.json with the pilot scope the adapter enforces: one
 * launch, this payer and recipient, this exact allocation, a 219 USDC total and fixed operator gas
 * caps. It prints the approval digest over (release preview, that config, code manifest). Do not
 * re-run `plan` after approval: `deploy`, `check`, `request` and `equilibrium:evm-serve` all read
 * the approved file, and a rewritten file needs a new approval.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, formatEther, formatUnits, getContractAddress, http, isAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CODE, linked, withArgs } from '../server/equilibrium/evm/contracts'
import { approvalDigest, codeManifest } from '../server/equilibrium/evm/approval'
import type { EvmFileConfig } from '../server/equilibrium/evm/config'

const CONFIG = 'deployments/equilibrium-testnet.json'
const PREVIEW = 'public/equilibrium-release-preview.md'
const NETWORKS = {
  arc: { rpc: 'https://rpc.testnet.arc.io', chainId: 5042002, wormholeChainId: 71, core: '0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd', usdc: '0x3600000000000000000000000000000000000000', factory: '0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a', v3: null },
  base: { rpc: 'https://sepolia.base.org', chainId: 84532, wormholeChainId: 10004, core: '0x79A1027a6A159502049F10906D333EC57E95F083', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', factory: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', v3: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' },
} as const
/** Gas per launch, measured on the pinned forks (fork suite, 2026-09-30), before any margin. */
const LAUNCH_GAS = { arc: 11_413_227n, base: 14_297_484n }
const MARGIN = 3n
/** Base charges an L1 data fee the gas estimate omits. Funding allowance only; the adapter bounds it per send. */
const BASE_L1_ALLOWANCE = 1_000_000_000_000_000n
/**
 * The release preview's caps, in native wei. Arc gas is native USDC with 18 decimals, so 2e18 is 2 USDC.
 * Launch caps are enforced by the adapter across every send; deploy caps by `deploy` before each send.
 * Total: arc 2 USDC, base 0.01 ETH.
 */
const CAPS = {
  launch: { arc: 1_500_000_000_000_000_000n, base: 8_000_000_000_000_000n },
  deploy: { arc: 500_000_000_000_000_000n, base: 2_000_000_000_000_000n },
}
/** The approved allocation: 1,000,000 EQL; 990,000 on Arc and 10,000 on Base; 5,000 EQL and 100 USDC per pool. */
const ALLOCATION = {
  issuance: '1000000000000',
  destinations: [
    { chain: 'arc' as const, amount: '990000000000', poolTokens: '5000000000', poolQuote: '100000000' },
    { chain: 'base' as const, amount: '10000000000', poolTokens: '5000000000', poolQuote: '100000000' },
  ],
}
const BUDGETS = { payment: '1000000', canonical: '2000000', manager: '5000000', debit: '1000000', credit: '1000000', pool: '2000000' }
/** 19 USDC of step budgets (payment 1, issuance 2, managers 5+5, pools 2+2, debit 1, credit 1) plus 200 USDC pool quote. */
const MAX_TOTAL = ([BUDGETS.payment, BUDGETS.canonical, BUDGETS.manager, BUDGETS.manager, BUDGETS.pool, BUDGETS.pool, BUDGETS.debit, BUDGETS.credit].reduce((n, x) => n + BigInt(x), 0n)
  + ALLOCATION.destinations.reduce((n, d) => n + BigInt(d.poolQuote), 0n)).toString()

const flags = process.argv.slice(2)
const flag = (name: string) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined)
const command = flags[0] ?? 'plan'
const clients = { arc: createPublicClient({ transport: http(NETWORKS.arc.rpc) }), base: createPublicClient({ transport: http(NETWORKS.base.rpc) }) }
const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const
const address = (name: string): Address => {
  const value = flag(name)
  if (!value || !isAddress(value)) throw new Error(`Pass ${name} <address>.`)
  return value
}
const readConfig = () => {
  if (!existsSync(CONFIG)) throw new Error(`${CONFIG} does not exist. Run plan first.`)
  const text = readFileSync(CONFIG, 'utf8')
  return { text, config: JSON.parse(text) as EvmFileConfig }
}
const digest = (text: string) => approvalDigest(readFileSync(PREVIEW, 'utf8'), text, codeManifest())

async function predictions(operator: Address) {
  const out = {} as Record<'arc' | 'base', { nonce: number; library: Address; executor: Address; executorInit: Hex; libraryInit: Hex }>
  for (const chain of ['arc', 'base'] as const) {
    const nonce = await clients[chain].getTransactionCount({ address: operator })
    const libraryInit = linked(CODE.TransceiverStructs)
    const executorInit = withArgs(linked(CODE.EquilibriumExecutor), [{ type: 'address' }, { type: 'address' }], [operator, NETWORKS[chain].v3 ?? '0x0000000000000000000000000000000000000000'])
    out[chain] = { nonce, libraryInit, executorInit,
      library: getContractAddress({ from: operator, nonce: BigInt(nonce) }), executor: getContractAddress({ from: operator, nonce: BigInt(nonce + 1) }) }
  }
  return out
}

function configFor(p: Awaited<ReturnType<typeof predictions>>, fromBlocks: Record<'arc' | 'base', bigint>, payer: Address, recipient: Address): EvmFileConfig {
  const chain = (name: 'arc' | 'base') => {
    const n = NETWORKS[name]
    return { chain: name, rpc: n.rpc, chainId: n.chainId, wormholeChainId: n.wormholeChainId, core: n.core as Address, executor: p[name].executor, transceiverStructs: p[name].library,
      usdc: n.usdc as Address, finality: 'finalized' as const, fromBlock: fromBlocks[name].toString(), opStackL1Fee: name === 'base',
      // Arc gas is native USDC (18 decimals). Base ETH is charged at a deliberately high 5,000 USDC.
      usdcAtomsPerNative: name === 'arc' ? '1000000' : '5000000000',
      venue: name === 'arc' ? { kind: 'architex' as const, factory: n.factory as Address } : { kind: 'uniswap-v3' as const, factory: n.factory as Address, fee: 3000, tickSpacing: 60 } }
  }
  const base = ALLOCATION.destinations[1].amount
  return { mode: 'testnet', arc: chain('arc'), base: chain('base'), vaa: { kind: 'wormholescan', api: 'https://api.testnet.wormholescan.io' },
    limits: { outbound: base, inbound: base }, budgets: BUDGETS, receiptTimeoutMs: 300_000,
    scope: { launches: 1, payer: payer.toLowerCase() as Address, recipient: recipient.toLowerCase() as Address, issuance: ALLOCATION.issuance, destinations: ALLOCATION.destinations,
      maxTotal: MAX_TOTAL, operatorGas: { arc: CAPS.launch.arc.toString(), base: CAPS.launch.base.toString() } } }
}

async function balances(operator: Address, payer: Address) {
  return {
    arcGas: await clients.arc.getBalance({ address: operator }),
    baseGas: await clients.base.getBalance({ address: operator }),
    payerUsdc: await clients.arc.readContract({ address: NETWORKS.arc.usdc, abi: erc20, functionName: 'balanceOf', args: [payer] }),
  }
}

if (command === 'plan') {
  const operator = address('--operator'); const payer = address('--payer'); const recipient = address('--recipient')
  if (existsSync(CONFIG) && !flags.includes('--replace')) throw new Error(`${CONFIG} exists and may already be approved. Pass --replace to write a new plan that needs a new approval.`)
  const p = await predictions(operator)
  for (const chain of ['arc', 'base'] as const) if (await clients[chain].getCode({ address: p[chain].executor })) throw new Error(`${chain}: the predicted executor already has code; the operator nonce was reused.`)
  const config = configFor(p, { arc: await clients.arc.getBlockNumber(), base: await clients.base.getBlockNumber() }, payer, recipient)
  const text = JSON.stringify(config, null, 2) + '\n'
  const funds = await balances(operator, payer)
  const beforeDeploy: string[] = []
  const chains: Record<string, unknown> = {}
  for (const chain of ['arc', 'base'] as const) {
    const c = clients[chain]
    const price = await c.getGasPrice()
    const infraGas = (await c.estimateGas({ account: operator, data: p[chain].libraryInit })) + (await c.estimateGas({ account: operator, data: p[chain].executorInit }))
    const infraWorst = infraGas * price * MARGIN
    const launchWorst = LAUNCH_GAS[chain] * price * MARGIN + (chain === 'base' ? BASE_L1_ALLOWANCE : 0n)
    const unit = chain === 'arc' ? 'native USDC' : 'ETH'
    // A gas spike that pushes either estimate past an approved cap makes this plan unapprovable.
    if (infraWorst > CAPS.deploy[chain] || launchWorst > CAPS.launch[chain]) throw new Error(`${chain}: current gas prices exceed the preview caps; re-plan later.`)
    const need = infraWorst + launchWorst
    const have = chain === 'arc' ? funds.arcGas : funds.baseGas
    chains[chain] = { chainId: NETWORKS[chain].chainId, nonce: p[chain].nonce, library: p[chain].library, executor: p[chain].executor, gasPriceGwei: formatUnits(price, 9),
      operatorGas: { fund: `${formatEther(need)} ${unit}`, have: `${formatEther(have)} ${unit}`, deployCap: `${formatEther(CAPS.deploy[chain])} ${unit}`, launchCap: `${formatEther(CAPS.launch[chain])} ${unit}` } }
    if (have < need) beforeDeploy.push(`${chain}: operator ${operator} needs ${formatEther(need - have)} more ${unit} for gas (${MARGIN}x current price)`)
  }
  if (funds.payerUsdc < BigInt(MAX_TOTAL)) beforeDeploy.push(`arc: payer ${payer} needs ${formatUnits(BigInt(MAX_TOTAL) - funds.payerUsdc, 6)} more Arc testnet USDC (quoted total ${formatUnits(BigInt(MAX_TOTAL), 6)})`)
  mkdirSync('deployments', { recursive: true })
  writeFileSync(CONFIG, text)
  console.log(JSON.stringify({
    operator, payer, recipient, config: CONFIG, chains,
    scope: config.scope, ceiling: 'payer 219 + Base inventory 100 + operator gas caps (Arc 2 native USDC, Base 0.01 ETH) = 321 test USDC + 0.01 test ETH',
    beforeDeploy: { missing: beforeDeploy },
    afterDeploy: [`send 100 Base Sepolia USDC to the Base executor ${p.base.executor}, then run check`],
    approval: { EQUILIBRIUM_APPROVAL: digest(text), binds: [PREVIEW, CONFIG, ...codeManifest().map((m) => `${m.file} ${m.sha256.slice(0, 12)}`)] },
    next: beforeDeploy.length ? 'Fund the listed wallets (balances are rechecked by check); approval can be given on this plan as is.' : 'Approve the digest, then run deploy.',
  }, null, 2))
} else if (command === 'deploy') {
  const key = process.env.EQUILIBRIUM_OPERATOR_KEY as Hex | undefined
  if (!key) throw new Error('EQUILIBRIUM_OPERATOR_KEY is required to deploy.')
  const { text, config } = readConfig()
  const required = digest(text)
  if (process.env.EQUILIBRIUM_APPROVAL !== required) throw new Error(`Not approved. Deploying ${CONFIG} requires EQUILIBRIUM_APPROVAL=${required}`)
  const account = privateKeyToAccount(key)
  const p = await predictions(account.address)
  for (const chain of ['arc', 'base'] as const) {
    if (p[chain].executor.toLowerCase() !== config[chain].executor.toLowerCase()) throw new Error(`${chain}: operator nonce moved since the plan; re-plan and re-approve.`)
    const wallet = createWalletClient({ account, transport: http(NETWORKS[chain].rpc) })
    const { maxFeePerGas, maxPriorityFeePerGas } = await clients[chain].estimateFeesPerGas()
    const steps = [['library', p[chain].libraryInit, p[chain].library], ['executor', p[chain].executorInit, p[chain].executor]] as const
    const limits = await Promise.all(steps.map(async ([, data]) => ((await clients[chain].estimateGas({ account: account.address, data })) * 12n) / 10n))
    const worst = limits.reduce((n, g) => n + g * maxFeePerGas, 0n) + (chain === 'base' ? BASE_L1_ALLOWANCE : 0n)
    if (worst > CAPS.deploy[chain]) throw new Error(`${chain}: deployment could cost ${formatEther(worst)}, above the approved deploy cap. Nothing was sent.`)
    for (const [i, [label, data, expected]] of steps.entries()) {
      const hash = await wallet.sendTransaction({ account, chain: null, data, gas: limits[i], maxFeePerGas, maxPriorityFeePerGas })
      const receipt = await clients[chain].waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== expected.toLowerCase()) throw new Error(`${chain} ${label} deployment ${hash} did not produce ${expected}`)
      console.log(`${chain} ${label} ${expected} in ${hash}`)
    }
  }
  console.log(`Deployed as planned. Next: send 100 Base Sepolia USDC to ${config.base.executor}, then run check.`)
} else if (command === 'check') {
  const { text, config } = readConfig()
  const scope = config.scope!
  const operatorOwner = await clients.arc.readContract({ address: config.arc.executor, abi: [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const, functionName: 'owner' }).catch(() => null)
  const problems: string[] = []
  for (const chain of ['arc', 'base'] as const) {
    for (const [label, target] of [['library', config[chain].transceiverStructs], ['executor', config[chain].executor]] as const) {
      if (!(await clients[chain].getCode({ address: target }))) problems.push(`${chain}: ${label} ${target} is not deployed`)
    }
  }
  const baseQuote = BigInt(scope.destinations.find((d) => d.chain === 'base')!.poolQuote)
  const inventory = await clients.base.readContract({ address: NETWORKS.base.usdc, abi: erc20, functionName: 'balanceOf', args: [config.base.executor] })
  if (inventory < baseQuote) problems.push(`base: executor ${config.base.executor} holds ${formatUnits(inventory, 6)} USDC; the pilot pool needs ${formatUnits(baseQuote, 6)}`)
  const payerUsdc = await clients.arc.readContract({ address: NETWORKS.arc.usdc, abi: erc20, functionName: 'balanceOf', args: [scope.payer] })
  if (payerUsdc < BigInt(scope.maxTotal)) problems.push(`arc: payer ${scope.payer} holds ${formatUnits(payerUsdc, 6)} USDC; the pilot charges ${formatUnits(BigInt(scope.maxTotal), 6)}`)
  if (operatorOwner) {
    const arcGas = await clients.arc.getBalance({ address: operatorOwner }); const baseGas = await clients.base.getBalance({ address: operatorOwner })
    if (arcGas < BigInt(scope.operatorGas.arc)) problems.push(`arc: operator holds ${formatEther(arcGas)} native USDC; the launch cap is ${formatEther(BigInt(scope.operatorGas.arc))}`)
    if (baseGas < BigInt(scope.operatorGas.base) / 4n) problems.push(`base: operator holds ${formatEther(baseGas)} ETH; fund at least a quarter of the ${formatEther(BigInt(scope.operatorGas.base))} launch cap`)
  }
  console.log(JSON.stringify({ config: CONFIG, approvalDigest: digest(text), ready: problems.length === 0, problems }, null, 2))
  if (problems.length) process.exitCode = 1
} else if (command === 'request') {
  const { config } = readConfig()
  const scope = config.scope!
  const expires = Math.floor(Date.now() / 1000) + 240
  const request = { requestId: `pilot-${expires}`, payer: scope.payer,
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: scope.issuance, recipient: scope.recipient },
    destinations: scope.destinations.map((d) => ({ chain: d.chain, recipient: scope.recipient, amount: d.amount, poolTokens: d.poolTokens, poolQuote: d.poolQuote })),
    quote: { expires, costCap: scope.maxTotal } }
  const out = flag('--out') ?? 'request.json'
  writeFileSync(out, JSON.stringify(request, null, 2) + '\n')
  console.log(`Wrote ${out}; the quote expires in 240 s. Launch next with equilibrium:evm-launch --max-total ${scope.maxTotal}.`)
} else throw new Error('Use plan, deploy, check or request.')
