/**
 * Arc testnet + Base Sepolia infrastructure for the EQUILIBRIUM Arc–Base pilot.
 *
 *   bun run equilibrium:infra plan   --operator <0xaddress> [--payer <0xaddress>] [--launches 1]
 *   bun run equilibrium:infra deploy                      (EQUILIBRIUM_OPERATOR_KEY + EQUILIBRIUM_APPROVAL)
 *   bun run equilibrium:infra request --payer <0x> --recipient <0x> [--out request.json]
 *
 * `plan` is read-only. It reads both public testnets, predicts the NTT library and executor
 * addresses from the operator's next nonces, writes the exact adapter configuration to
 * deployments/equilibrium-testnet.json, and prints every missing wallet, balance and the approval
 * digest over (release preview, configuration). `deploy` sends the two deployments per chain only
 * when EQUILIBRIUM_APPROVAL equals that digest and the nonces still match the plan.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, formatEther, formatUnits, getContractAddress, http, isAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CODE, linked, withArgs } from '../server/equilibrium/evm/contracts'
import { approvalDigest } from '../server/equilibrium/evm/approval'
import type { EvmFileConfig } from '../server/equilibrium/evm/config'

const CONFIG = 'deployments/equilibrium-testnet.json'
const PREVIEW = 'public/equilibrium-release-preview.md'
const NETWORKS = {
  arc: { rpc: 'https://rpc.testnet.arc.io', chainId: 5042002, wormholeChainId: 71, core: '0xBB73cB66C26740F31d1FabDC6b7A46a038A300dd', usdc: '0x3600000000000000000000000000000000000000', factory: '0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a', v3: null },
  base: { rpc: 'https://sepolia.base.org', chainId: 84532, wormholeChainId: 10004, core: '0x79A1027a6A159502049F10906D333EC57E95F083', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', factory: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', v3: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' },
} as const
/** Gas per launch, measured on the pinned forks (fork suite, 2026-09-30), before any safety margin. */
const LAUNCH_GAS = { arc: 11_413_227n, base: 14_297_484n }
/** The release preview's pilot allocation: 10,000 EQL on Base, 5,000 EQL and 100 test USDC per pool. */
const PILOT = { baseAmount: 10_000_000_000n, poolQuote: 100_000_000n }
const MARGIN = 3n
/** Base charges an L1 data fee the gas estimate omits; large init code makes it material. */
const BASE_L1_ALLOWANCE = 5_000_000_000_000_000n

const flags = process.argv.slice(2)
const flag = (name: string) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined)
const command = flags[0] ?? 'plan'
const clients = { arc: createPublicClient({ transport: http(NETWORKS.arc.rpc) }), base: createPublicClient({ transport: http(NETWORKS.base.rpc) }) }
const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const

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

function configFor(p: Awaited<ReturnType<typeof predictions>>, fromBlocks: Record<'arc' | 'base', bigint>): EvmFileConfig {
  const chain = (name: 'arc' | 'base') => {
    const n = NETWORKS[name]
    return { chain: name, rpc: n.rpc, chainId: n.chainId, wormholeChainId: n.wormholeChainId, core: n.core as Address, executor: p[name].executor, transceiverStructs: p[name].library,
      usdc: n.usdc as Address, finality: 'finalized' as const, fromBlock: fromBlocks[name].toString(),
      // Arc gas is native USDC (18 decimals). Base ETH is charged at a deliberately high 5,000 USDC.
      usdcAtomsPerNative: name === 'arc' ? '1000000' : '5000000000',
      venue: name === 'arc' ? { kind: 'architex' as const, factory: n.factory as Address } : { kind: 'uniswap-v3' as const, factory: n.factory as Address, fee: 3000, tickSpacing: 60 } }
  }
  return { mode: 'testnet', arc: chain('arc'), base: chain('base'), vaa: { kind: 'wormholescan', api: 'https://api.testnet.wormholescan.io' },
    limits: { outbound: PILOT.baseAmount.toString(), inbound: PILOT.baseAmount.toString() },
    budgets: { payment: '1000000', canonical: '2000000', manager: '5000000', debit: '1000000', credit: '1000000', pool: '2000000' }, receiptTimeoutMs: 300_000 }
}

if (command === 'plan') {
  const key = process.env.EQUILIBRIUM_OPERATOR_KEY as Hex | undefined
  const operator = (flag('--operator') ?? (key ? privateKeyToAccount(key).address : undefined)) as Address | undefined
  if (!operator || !isAddress(operator)) throw new Error('Pass --operator <address> (the executor owner), or set EQUILIBRIUM_OPERATOR_KEY.')
  const payer = flag('--payer') as Address | undefined
  const launches = BigInt(flag('--launches') ?? '1')
  const p = await predictions(operator)
  const fromBlocks = { arc: await clients.arc.getBlockNumber(), base: await clients.base.getBlockNumber() }
  const config = configFor(p, fromBlocks)
  mkdirSync('deployments', { recursive: true })
  const text = JSON.stringify(config, null, 2) + '\n'
  writeFileSync(CONFIG, text)
  const report: Record<string, unknown> = { operator, config: CONFIG, approval: { EQUILIBRIUM_APPROVAL: approvalDigest(readFileSync(PREVIEW, 'utf8'), text), preview: PREVIEW } }
  const missing: string[] = []
  for (const chain of ['arc', 'base'] as const) {
    const c = clients[chain]
    const price = await c.getGasPrice()
    const infraGas = (await c.estimateGas({ account: operator, data: p[chain].libraryInit })) + (await c.estimateGas({ account: operator, data: p[chain].executorInit }))
    const need = (infraGas + LAUNCH_GAS[chain] * launches) * price * MARGIN + (chain === 'base' ? BASE_L1_ALLOWANCE : 0n)
    const have = await c.getBalance({ address: operator })
    const unit = chain === 'arc' ? 'native USDC' : 'ETH'
    report[chain] = { chainId: NETWORKS[chain].chainId, nonce: p[chain].nonce, library: p[chain].library, executor: p[chain].executor, gasPriceGwei: formatUnits(price, 9),
      infraGas: infraGas.toString(), launchGas: (LAUNCH_GAS[chain] * launches).toString(), operatorGas: { need: `${formatEther(need)} ${unit}`, have: `${formatEther(have)} ${unit}` } }
    if (have < need) missing.push(`${chain}: operator ${operator} needs ${formatEther(need - have)} more ${unit} for gas (${MARGIN}x margin${chain === 'base' ? ' plus 0.005 ETH L1 data fee allowance' : ''})`)
  }
  const baseInventory = PILOT.poolQuote * launches
  const executorUsdc = await clients.base.readContract({ address: NETWORKS.base.usdc, abi: erc20, functionName: 'balanceOf', args: [p.base.executor] })
  if (executorUsdc < baseInventory) missing.push(`base: executor ${p.base.executor} needs ${formatUnits(baseInventory - executorUsdc, 6)} Base Sepolia USDC quote inventory (send after deploy; no CCTP refill yet)`)
  // Step budgets per launch: payment, canonical, both managers, both pools, debit and credit.
  const b = config.budgets
  const fees = [b.payment, b.canonical, b.manager, b.manager, b.pool, b.pool, b.debit, b.credit].reduce((n, x) => n + BigInt(x), 0n)
  const payerNeed = (PILOT.poolQuote * 2n + fees) * launches
  if (!payer) missing.push(`payer wallet: not named. It needs ${formatUnits(payerNeed, 6)} Arc testnet USDC per the pilot allocation, and signs the EIP-3009 authorization`)
  else {
    const have = await clients.arc.readContract({ address: NETWORKS.arc.usdc, abi: erc20, functionName: 'balanceOf', args: [payer] })
    if (have < payerNeed) missing.push(`arc: payer ${payer} needs ${formatUnits(payerNeed - have, 6)} more Arc testnet USDC`)
  }
  report.missing = missing
  report.next = missing.length ? 'Fund the listed wallets, re-run plan, then approve the printed digest.' : 'Approve the printed digest, then run deploy.'
  console.log(JSON.stringify(report, null, 2))
} else if (command === 'deploy') {
  const key = process.env.EQUILIBRIUM_OPERATOR_KEY as Hex | undefined
  if (!key) throw new Error('EQUILIBRIUM_OPERATOR_KEY is required to deploy.')
  const text = readFileSync(CONFIG, 'utf8')
  const required = approvalDigest(readFileSync(PREVIEW, 'utf8'), text)
  if (process.env.EQUILIBRIUM_APPROVAL !== required) throw new Error(`Not approved. Deploying ${CONFIG} requires EQUILIBRIUM_APPROVAL=${required}`)
  const account = privateKeyToAccount(key)
  const config = JSON.parse(text) as EvmFileConfig
  const p = await predictions(account.address)
  for (const chain of ['arc', 'base'] as const) {
    if (p[chain].executor.toLowerCase() !== config[chain].executor.toLowerCase()) throw new Error(`${chain}: operator nonce moved since the plan; re-plan and re-approve.`)
    const wallet = createWalletClient({ account, transport: http(NETWORKS[chain].rpc) })
    for (const [label, data, expected] of [['library', p[chain].libraryInit, p[chain].library], ['executor', p[chain].executorInit, p[chain].executor]] as const) {
      const hash = await wallet.sendTransaction({ account, chain: null, data })
      const receipt = await clients[chain].waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success' || receipt.contractAddress?.toLowerCase() !== expected.toLowerCase()) throw new Error(`${chain} ${label} deployment ${hash} did not produce ${expected}`)
      console.log(`${chain} ${label} ${expected} in ${hash}`)
    }
  }
  console.log(`Deployed as planned. Next: fund the Base executor's quote inventory, then run equilibrium:evm-serve with EQUILIBRIUM_EVM_CONFIG=${CONFIG}.`)
} else if (command === 'request') {
  // The release preview's allocation: 1,000,000 EQL; 990,000 on Arc and 10,000 on Base; 5,000 EQL and 100 USDC per pool.
  const payer = flag('--payer'); const recipient = flag('--recipient')
  if (!payer || !isAddress(payer) || !recipient || !isAddress(recipient)) throw new Error('Pass --payer <address> and --recipient <address>.')
  const expires = Math.floor(Date.now() / 1000) + 240
  const request = { requestId: `pilot-${expires}`, payer: payer.toLowerCase(),
    canonical: { chain: 'arc', name: 'Equilibrium', symbol: 'EQL', decimals: 6, issuance: '1000000000000', recipient },
    destinations: [
      { chain: 'arc', recipient, amount: '990000000000', poolTokens: '5000000000', poolQuote: PILOT.poolQuote.toString() },
      { chain: 'base', recipient, amount: PILOT.baseAmount.toString(), poolTokens: '5000000000', poolQuote: PILOT.poolQuote.toString() },
    ], quote: { expires, costCap: '220000000' } }
  const out = flag('--out') ?? 'request.json'
  writeFileSync(out, JSON.stringify(request, null, 2) + '\n')
  console.log(`Wrote ${out}; the quote expires in 240 s. Launch next with equilibrium:evm-launch.`)
} else throw new Error('Use plan, deploy or request.')
