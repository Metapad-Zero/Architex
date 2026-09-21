/**
 * Live smoke test for the launchpad v1.3 on Arc Testnet, against real USDC.
 *
 *   bun run scripts/launchpad-smoke.ts                 # read-only: wiring and constants
 *   BURNER_KEY=0x… bun run scripts/launchpad-smoke.ts  # also trades: needs about 12 test USDC, keeps most of it
 *   SMOKE_BUY=2 BURNER_KEY=0x… bun run …               # smaller buys: needs about 6
 *   SMOKE_FEE=250 …                                    # the creator fee the smoke token launches with, in bps (default 250)
 *
 * Arc's USDC moves balances through a chain-native precompile that a local fork cannot execute, so
 * this is the only place the launchpad meets the real token: allowance and transferFrom on the
 * 6-decimal ERC-20 view of the native balance, the launch fee, a buy, a sell, both fee collections,
 * and the accounting identity (USDC held == platform fees + creator fees + curve float) checked to the unit.
 *
 * The smoke token's creator fees go to the trader's own wallet (a plain address: no plugin hooks), so
 * collectCreatorFees pays the trader back. Every on-chain result is compared with the reference model in
 * src/lib/curve.ts. Testnet only: the script refuses any other chain id.
 */
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseEventLogs, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import deployment from '../src/deployments/arc-testnet.json'
import { erc20Abi, launchPairAbi, launchpadAbi } from '../src/lib/abi'
import { CURVE, INITIAL_CURVE, quoteBuy, quoteSell, type CurveState } from '../src/lib/curve'

const rpc = process.env.ARC_TESTNET_RPC ?? 'https://rpc.testnet.arc.io'
const pub = createPublicClient({ chain: arcTestnet, transport: http(rpc) })

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: got ${String(actual)}, expected ${String(expected)}`}`)
}

const chainId = await pub.getChainId()
if (chainId !== 5042002) throw new Error(`Refusing to run on chain ${chainId}: this script is for Arc Testnet (5042002) only.`)

const launchpad = getAddress(deployment.launchpad)
if (launchpad === zeroAddress) throw new Error('No launchpad address in src/deployments/arc-testnet.json yet. Deploy first: docs/launchpad/TESTNET-DEPLOY.md')
const usdc = getAddress(deployment.tokens.find((t) => t.symbol === 'USDC')!.address)
const pad = { address: launchpad, abi: launchpadAbi } as const
const CREATOR_FEE_BPS = Number(process.env.SMOKE_FEE ?? '250')
if (!Number.isInteger(CREATOR_FEE_BPS) || CREATOR_FEE_BPS < 0 || CREATOR_FEE_BPS > 1_000) throw new Error('SMOKE_FEE must be 0 to 1000 (bps).')

// ── Read-only: wiring and constants ─────────────────────────────────────────
check('usdc', await pub.readContract({ ...pad, functionName: 'usdc' }), usdc)
check('router', await pub.readContract({ ...pad, functionName: 'router' }), getAddress(deployment.launchRouter))
check('pairFactory', await pub.readContract({ ...pad, functionName: 'pairFactory' }), getAddress(deployment.launchPairFactory))
check('VIRTUAL_USDC_0', await pub.readContract({ ...pad, functionName: 'VIRTUAL_USDC_0' }), CURVE.VIRTUAL_USDC_0)
check('VIRTUAL_TOKENS_0', await pub.readContract({ ...pad, functionName: 'VIRTUAL_TOKENS_0' }), CURVE.VIRTUAL_TOKENS_0)
check('CURVE_SUPPLY', await pub.readContract({ ...pad, functionName: 'CURVE_SUPPLY' }), CURVE.CURVE_SUPPLY)
check('FEE_BPS', await pub.readContract({ ...pad, functionName: 'FEE_BPS' }), CURVE.FEE_BPS)
check('MAX_CREATOR_FEE_BPS', await pub.readContract({ ...pad, functionName: 'MAX_CREATOR_FEE_BPS' }), CURVE.MAX_CREATOR_FEE_BPS)
const launchFee = await pub.readContract({ ...pad, functionName: 'launchFee' })
const feeTo = await pub.readContract({ ...pad, functionName: 'feeTo' })
console.log(`     launch fee ${formatUnits(launchFee, 6)} USDC, fees go to ${feeTo}, admin ${await pub.readContract({ ...pad, functionName: 'feeToSetter' })}`)

const key = process.env.BURNER_KEY as Hex | undefined
if (!key) {
  console.log('\nBURNER_KEY not set: read-only checks only.')
  process.exit(failures ? 1 : 0)
}

// ── Trading, with real USDC ─────────────────────────────────────────────────
const account = privateKeyToAccount(key)
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc) })
const usdcOf = (who: Address) => pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

/**
 * On Arc the ERC-20 USDC balance is the native balance seen at 6 decimals, and gas is paid from it.
 * The trader's side is therefore checked on the native balance (18 decimals) with gas added back:
 * one USDC base unit is 1e12 wei.
 */
const UNIT = 10n ** 12n
const nativeOf = (who: Address) => pub.getBalance({ address: who })
/** Curve buys and sells revert Expired past their deadline, like the launch router's: 20 minutes from now. */
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60)
const gasCost = (receipt: TransactionReceipt) => receipt.gasUsed * receipt.effectiveGasPrice

/** USDC the launchpad owes: platform fees, every token's creator fees, and every live curve's float (V13-SPEC §6.1). */
async function owed(): Promise<bigint> {
  let total = await pub.readContract({ ...pad, functionName: 'pendingFees' })
  const count = await pub.readContract({ ...pad, functionName: 'tokensLength' })
  for (let start = 0n; start < count; start += 50n) {
    const page = await pub.readContract({ ...pad, functionName: 'curvesPage', args: [start, 50n] })
    for (const c of page) {
      total += await pub.readContract({ ...pad, functionName: 'pendingCreatorFees', args: [c.token] })
      if (!c.graduated) total += c.virtualUsdc - CURVE.VIRTUAL_USDC_0
    }
  }
  return total
}

async function send(label: string, request: Parameters<typeof wallet.writeContract>[0]) {
  const hash = await wallet.writeContract(request)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  console.log(`     ${label}: ${hash} (${receipt.status}, gas ${receipt.gasUsed})`)
  if (receipt.status !== 'success') throw new Error(`${label} reverted`)
  return receipt
}

async function checkCurve(label: string, token: Address, expected: CurveState) {
  const curve = await pub.readContract({ ...pad, functionName: 'curves', args: [token] })
  check(`${label}: virtualUsdc`, curve.virtualUsdc, expected.virtualUsdc)
  check(`${label}: virtualTokens`, curve.virtualTokens, expected.virtualTokens)
  check(`${label}: tokensSold`, curve.tokensSold, expected.tokensSold)
  check(`${label}: held == owed`, await usdcOf(launchpad), await owed())
  return curve
}

// USDC per buy. SMOKE_BUY=2 runs the same checks on a wallet that holds less.
const BUY = BigInt(Math.round(Number(process.env.SMOKE_BUY ?? '5') * 1e6))
if (BUY < 1_000_000n) throw new Error('SMOKE_BUY must be at least 1 (USDC).')
const startNative = await nativeOf(account.address)
console.log(`\ntrader ${account.address}: ${formatUnits(startNative, 18)} USDC`)
const needed = launchFee + 2n * BUY + 1_000_000n // two buys, the launch fee, and 1 USDC of gas headroom
if (startNative < needed * UNIT) throw new Error(`Needs at least ${formatUnits(needed, 6)} test USDC (faucet.circle.com, Arc Testnet).`)

check('held == owed before', await usdcOf(launchpad), await owed())

const allowance = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'allowance', args: [account.address, launchpad] })
if (allowance < needed) await send('approve', { address: usdc, abi: erc20Abi, functionName: 'approve', args: [launchpad, needed] })

// Create with an initial buy; creator fees go to the trader's own wallet (no plugin data), capped launch fee [D22].
const stamp = Date.now().toString(36).toUpperCase()
const feesBeforeCreate = await pub.readContract({ ...pad, functionName: 'pendingFees' })
const expectedCreate = quoteBuy(INITIAL_CURVE, BUY, CREATOR_FEE_BPS)
let before = await nativeOf(account.address)
let receipt = await send('createToken', {
  ...pad,
  functionName: 'createToken',
  args: [`Smoke ${stamp}`, `SMK${stamp.slice(-3)}`, '', CREATOR_FEE_BPS, account.address, '0x', BUY, expectedCreate.tokensOut, launchFee],
})
const token = parseEventLogs({ abi: launchpadAbi, logs: receipt.logs, eventName: 'TokenCreated' })[0].args.token
console.log(`     token ${token}`)
check('create: trader paid fee + buy + gas', before - (await nativeOf(account.address)), (launchFee + BUY) * UNIT + gasCost(receipt))
check('create: trader tokens', await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }), expectedCreate.tokensOut)
check('create: platform fees accrued', (await pub.readContract({ ...pad, functionName: 'pendingFees' })) - feesBeforeCreate, launchFee + expectedCreate.platformFee)
check('create: creator fees accrued', await pub.readContract({ ...pad, functionName: 'pendingCreatorFees', args: [token] }), expectedCreate.creatorFee)
check('create: plugin', await pub.readContract({ ...pad, functionName: 'pluginOf', args: [token] }), account.address)
const curve = await checkCurve('create', token, expectedCreate.next)
check('create: creator fee', curve.creatorFeeBps, CREATOR_FEE_BPS)
check('create: no plugin hooks for a wallet', curve.pluginHooks, false)
check('create: launch pool is empty', await pub.readContract({ address: curve.pair, abi: launchPairAbi, functionName: 'totalSupply' }), 0n)

// Buy again: the on-chain quote, the model and the trade must agree.
const expectedBuy = quoteBuy(expectedCreate.next, BUY, CREATOR_FEE_BPS)
const [quotedTokens, quotedPlatform, quotedCreator] = await pub.readContract({ ...pad, functionName: 'quoteBuy', args: [token, BUY] })
check('buy: quote tokens == model', quotedTokens, expectedBuy.tokensOut)
check('buy: quote platform fee == model', quotedPlatform, expectedBuy.platformFee)
check('buy: quote creator fee == model', quotedCreator, expectedBuy.creatorFee)
before = await nativeOf(account.address)
receipt = await send('buy', { ...pad, functionName: 'buy', args: [token, BUY, expectedBuy.tokensOut, account.address, deadline()] })
check('buy: trader paid buy + gas', before - (await nativeOf(account.address)), BUY * UNIT + gasCost(receipt))
await checkCurve('buy', token, expectedBuy.next)

// Sell everything back, with no token approval: the launchpad pulls from the seller.
const held = expectedBuy.next.tokensSold
const expectedSell = quoteSell(expectedBuy.next, held, CREATOR_FEE_BPS)
const [quotedOut, sellPlatform, sellCreator] = await pub.readContract({ ...pad, functionName: 'quoteSell', args: [token, held] })
check('sell: quote == model', quotedOut, expectedSell.usdcOut)
check('sell: fees == model', `${sellPlatform}/${sellCreator}`, `${expectedSell.platformFee}/${expectedSell.creatorFee}`)
before = await nativeOf(account.address)
receipt = await send('sell', { ...pad, functionName: 'sell', args: [token, held, expectedSell.usdcOut, account.address, deadline()] })
check('sell: trader received proceeds - gas', (await nativeOf(account.address)) - before, expectedSell.usdcOut * UNIT - gasCost(receipt))
await checkCurve('sell', token, expectedSell.next)

// Anyone may collect a token's creator fees to its plugin: here, back to the trader's wallet by plain transfer.
const creatorOwed = expectedCreate.creatorFee + expectedBuy.creatorFee + expectedSell.creatorFee
check('creator fees accrued over all three trades', await pub.readContract({ ...pad, functionName: 'pendingCreatorFees', args: [token] }), creatorOwed)
before = await nativeOf(account.address)
receipt = await send('collectCreatorFees', { ...pad, functionName: 'collectCreatorFees', args: [token] })
check('collect creator: plugin received', (await nativeOf(account.address)) - before, creatorOwed * UNIT - gasCost(receipt))
check('collect creator: cleared', await pub.readContract({ ...pad, functionName: 'pendingCreatorFees', args: [token] }), 0n)

// Anyone may push accrued platform fees to feeTo.
const pending = await pub.readContract({ ...pad, functionName: 'pendingFees' })
before = await nativeOf(feeTo)
receipt = await send('collectFees', { ...pad, functionName: 'collectFees' })
const collectGas = feeTo === account.address ? gasCost(receipt) : 0n
check('collect: feeTo received', (await nativeOf(feeTo)) - before, pending * UNIT - collectGas)
check('collect: pendingFees cleared', await pub.readContract({ ...pad, functionName: 'pendingFees' }), 0n)
check('collect: held == owed', await usdcOf(launchpad), await owed())

console.log(`\nnet cost to the trader, fees and gas included: ${formatUnits(startNative - (await nativeOf(account.address)), 18)} USDC`)
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed')
process.exit(failures ? 1 : 0)
