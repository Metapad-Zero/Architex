/**
 * Live smoke test for the AMM on Arc Testnet, against real USDC.
 *
 *   BURNER_KEY=0x… bun run scripts/amm-smoke.ts
 *
 * Arc's USDC moves balances through a chain-native precompile that a local fork cannot execute, so
 * this is where the pair and router meet the real token: a swap out of USDC, a swap back into it,
 * and a liquidity withdrawal, each compared with the router's own quote and with the pair's
 * reserves. Trader-side checks are made on the native balance with gas added back, because on Arc
 * gas is paid from the same balance the trade moves.
 *
 * Needs a seeded USDC/EURC pool (scripts/seed-usdc-pools.ts) and about 1 test USDC.
 * Testnet only: the script refuses any other chain id.
 */
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, type Address, type Hex, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import deployment from '../src/deployments/arc-testnet.json'
import { erc20Abi, factoryAbi, pairAbi, routerAbi } from '../src/lib/abi'

const rpc = process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io'
const pub = createPublicClient({ chain: arcTestnet, transport: http(rpc) })

const chainId = await pub.getChainId()
if (chainId !== 5042002) throw new Error(`Refusing to run on chain ${chainId}: this script is for Arc Testnet (5042002) only.`)

const key = process.env.BURNER_KEY as Hex | undefined
if (!key) throw new Error('BURNER_KEY missing')
const account = privateKeyToAccount(key)
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${String(actual)}, expected ${String(expected)}`}`)
}
function checkTrue(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`)
}

const router = getAddress(deployment.router)
const factory = getAddress(deployment.factory)
const usdc = getAddress(deployment.tokens.find((t) => t.symbol === 'USDC')!.address)
const eurc = getAddress(deployment.tokens.find((t) => t.symbol === 'EURC')!.address)
const pair = await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPair', args: [usdc, eurc] })
const usdcIsToken0 = (await pub.readContract({ address: pair, abi: pairAbi, functionName: 'token0' })) === usdc

const UNIT = 10n ** 12n // one USDC base unit (6 decimals) in native wei (18 decimals)
const nativeOf = (who: Address) => pub.getBalance({ address: who })
const balanceOf = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
const gasCost = (receipt: TransactionReceipt) => receipt.gasUsed * receipt.effectiveGasPrice
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 600)

async function reserves(): Promise<{ usdc: bigint; eurc: bigint }> {
  const [r0, r1] = await pub.readContract({ address: pair, abi: pairAbi, functionName: 'getReserves' })
  return usdcIsToken0 ? { usdc: r0, eurc: r1 } : { usdc: r1, eurc: r0 }
}

/** The pair's recorded reserves must equal what the tokens say it holds: no drift on a precompile-backed balance. */
async function checkSynced(label: string) {
  const r = await reserves()
  check(`${label}: USDC reserve == USDC balanceOf(pair)`, r.usdc, await balanceOf(usdc, pair))
  check(`${label}: EURC reserve == EURC balanceOf(pair)`, r.eurc, await balanceOf(eurc, pair))
  check(`${label}: pair native balance == USDC reserve`, await nativeOf(pair), r.usdc * UNIT)
  return r
}

async function send(label: string, request: Parameters<typeof wallet.writeContract>[0]) {
  const hash = await wallet.writeContract(request)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  console.log(`     ${label}: ${hash} (${receipt.status}, gas ${receipt.gasUsed})`)
  if (receipt.status !== 'success') throw new Error(`${label} reverted`)
  return receipt
}

async function approve(token: Address, spender: Address, amount: bigint, label: string) {
  const current = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, spender] })
  if (current < amount) await send(`approve ${label}`, { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
}

console.log(`trader ${account.address}: ${formatUnits(await nativeOf(account.address), 18)} USDC`)
console.log(`pair   ${pair} (USDC is token${usdcIsToken0 ? 0 : 1})`)
const start = await checkSynced('before')
if (start.usdc === 0n || start.eurc === 0n) throw new Error('USDC/EURC pool is empty. Seed it first: scripts/seed-usdc-pools.ts')

// ── Swap out of USDC ────────────────────────────────────────────────────────
const usdcIn = 250_000n // 0.25 USDC
const [, eurcQuoted] = await pub.readContract({ address: router, abi: routerAbi, functionName: 'getAmountsOut', args: [usdcIn, [usdc, eurc]] })
await approve(usdc, router, usdcIn, 'USDC')
let nativeBefore = await nativeOf(account.address)
let eurcBefore = await balanceOf(eurc, account.address)
let receipt = await send('swap 0.25 USDC -> EURC', { address: router, abi: routerAbi, functionName: 'swapExactTokensForTokens', args: [usdcIn, eurcQuoted, [usdc, eurc], account.address, deadline()] })
check('swap out: trader paid USDC + gas', nativeBefore - (await nativeOf(account.address)), usdcIn * UNIT + gasCost(receipt))
check('swap out: EURC received == quote', (await balanceOf(eurc, account.address)) - eurcBefore, eurcQuoted)
const afterOut = await checkSynced('swap out')
check('swap out: USDC reserve grew by the input', afterOut.usdc - start.usdc, usdcIn)
check('swap out: EURC reserve fell by the output', start.eurc - afterOut.eurc, eurcQuoted)
checkTrue('swap out: k did not shrink', afterOut.usdc * afterOut.eurc >= start.usdc * start.eurc)

// ── Swap back into USDC ─────────────────────────────────────────────────────
const [, usdcQuoted] = await pub.readContract({ address: router, abi: routerAbi, functionName: 'getAmountsOut', args: [eurcQuoted, [eurc, usdc]] })
await approve(eurc, router, eurcQuoted, 'EURC')
nativeBefore = await nativeOf(account.address)
eurcBefore = await balanceOf(eurc, account.address)
receipt = await send('swap EURC -> USDC', { address: router, abi: routerAbi, functionName: 'swapExactTokensForTokens', args: [eurcQuoted, usdcQuoted, [eurc, usdc], account.address, deadline()] })
check('swap back: trader received USDC - gas', (await nativeOf(account.address)) - nativeBefore, usdcQuoted * UNIT - gasCost(receipt))
check('swap back: EURC spent', eurcBefore - (await balanceOf(eurc, account.address)), eurcQuoted)
const afterBack = await checkSynced('swap back')
check('swap back: USDC reserve fell by the output', afterOut.usdc - afterBack.usdc, usdcQuoted)
checkTrue('swap back: round trip costs the fee twice, no more', usdcQuoted < usdcIn && usdcQuoted * 1000n >= usdcIn * 990n, `${usdcQuoted} of ${usdcIn}`)

// ── Withdraw a tenth of the position ────────────────────────────────────────
const lpHeld = await balanceOf(pair, account.address)
if (lpHeld === 0n) {
  console.log('     trader holds no LP in this pool: skipping the withdrawal check')
} else {
  const lpOut = lpHeld / 10n
  const supply = await pub.readContract({ address: pair, abi: pairAbi, functionName: 'totalSupply' })
  const expectUsdc = (lpOut * afterBack.usdc) / supply
  const expectEurc = (lpOut * afterBack.eurc) / supply
  await approve(pair, router, lpOut, 'LP')
  nativeBefore = await nativeOf(account.address)
  eurcBefore = await balanceOf(eurc, account.address)
  receipt = await send('removeLiquidity 10%', { address: router, abi: routerAbi, functionName: 'removeLiquidity', args: [usdc, eurc, lpOut, expectUsdc, expectEurc, account.address, deadline()] })
  check('withdraw: trader received USDC share - gas', (await nativeOf(account.address)) - nativeBefore, expectUsdc * UNIT - gasCost(receipt))
  check('withdraw: trader received EURC share', (await balanceOf(eurc, account.address)) - eurcBefore, expectEurc)
  const afterBurn = await checkSynced('withdraw')
  check('withdraw: USDC reserve fell by the share', afterBack.usdc - afterBurn.usdc, expectUsdc)
  check('withdraw: LP supply fell by the burn', supply - (await pub.readContract({ address: pair, abi: pairAbi, functionName: 'totalSupply' })), lpOut)
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
