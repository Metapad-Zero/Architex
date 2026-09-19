/**
 * Seed the four USDC pools on Arc Testnet from a funded EOA.
 *
 *   BURNER_KEY=0x… USDC_PER_POOL=4 bun run scripts/seed-usdc-pools.ts
 *
 * Mints test tokens via their open faucet(), approves the router, then calls addLiquidity at
 * the reference prices from docs/CONTRACTS-SPEC.md. Idempotent-ish: pools that already have
 * reserves are skipped. Testnet only.
 */
import { createPublicClient, createWalletClient, http, parseAbi, parseUnits, getAddress, formatUnits, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import deployment from '../src/deployments/arc-testnet.json'

const key = process.env.BURNER_KEY as Hex | undefined
if (!key) throw new Error('BURNER_KEY missing')
const usdcPerPool = Number(process.env.USDC_PER_POOL ?? '4')

const account = privateKeyToAccount(key)
const rpc = 'https://rpc.testnet.arc.io'
const pub = createPublicClient({ chain: arcTestnet, transport: http(rpc) })
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function faucet()',
])
const routerAbi = parseAbi([
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256, uint256, uint256)',
])
const pairAbi = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)'])

const router = getAddress(deployment.router)
const usdc = getAddress(deployment.tokens.find((t) => t.symbol === 'USDC')!.address)
const token = (sym: string) => deployment.tokens.find((t) => t.symbol === sym)!
// USDC per 1 whole token
const prices: Record<string, number> = { WETH: 2500, WBTC: 60000, ARC: 0.05, EURC: 1.08 }

async function send(desc: string, req: Parameters<typeof wallet.writeContract>[0]) {
  const hash = await wallet.writeContract(req)
  const rcpt = await pub.waitForTransactionReceipt({ hash })
  console.log(`${desc}: ${hash} (${rcpt.status})`)
  if (rcpt.status !== 'success') throw new Error(`${desc} reverted`)
}

const native = await pub.getBalance({ address: account.address })
const usdcBal = (await pub.readContract({ address: usdc, abi: erc20, functionName: 'balanceOf', args: [account.address] }))
console.log(`seeder ${account.address}: native ${formatUnits(native, 18)} USDC(gas), ERC-20 USDC ${formatUnits(usdcBal, 6)}`)

for (const sym of Object.keys(prices)) {
  const t = token(sym)
  const addr = getAddress(t.address)
  const pair = deployment.pairs.find((p) => [p.token0.toLowerCase(), p.token1.toLowerCase()].includes(addr.toLowerCase()) && [p.token0.toLowerCase(), p.token1.toLowerCase()].includes(usdc.toLowerCase()))
  if (!pair) { console.log(`no USDC pair for ${sym}, skipping`); continue }
  const [r0, r1] = (await pub.readContract({ address: getAddress(pair.pair), abi: pairAbi, functionName: 'getReserves' })) as [bigint, bigint, number]
  if (r0 > 0n && r1 > 0n) { console.log(`USDC/${sym} already seeded (${r0}, ${r1}), skipping`); continue }

  const usdcAmount = parseUnits(usdcPerPool.toFixed(6), 6)
  const tokenAmount = parseUnits((usdcPerPool / prices[sym]).toFixed(t.decimals), t.decimals)
  let bal = (await pub.readContract({ address: addr, abi: erc20, functionName: 'balanceOf', args: [account.address] }))
  while (bal < tokenAmount) {
    await send(`faucet ${sym}`, { address: addr, abi: erc20, functionName: 'faucet' })
    bal = (await pub.readContract({ address: addr, abi: erc20, functionName: 'balanceOf', args: [account.address] }))
  }
  for (const [a, amt, name] of [[addr, tokenAmount, sym], [usdc, usdcAmount, 'USDC']] as const) {
    const allowance = (await pub.readContract({ address: a, abi: erc20, functionName: 'allowance', args: [account.address, router] }))
    if (allowance < amt) await send(`approve ${name}`, { address: a, abi: erc20, functionName: 'approve', args: [router, amt] })
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
  await send(`addLiquidity USDC/${sym} (${formatUnits(usdcAmount, 6)} USDC + ${formatUnits(tokenAmount, t.decimals)} ${sym})`, {
    address: router, abi: routerAbi, functionName: 'addLiquidity',
    args: [usdc, addr, usdcAmount, tokenAmount, 0n, 0n, account.address, deadline],
  })
}
console.log('done')
