/**
 * MIXED-ENVIRONMENT FORK HARNESS for the Robinhood launch job: the route harness in fork.ts (Arc
 * testnet fork + Robinhood mainnet fork, local Guardian, USDG fixture) plus the Arc payment fixture
 * the HTTP job path needs. It uses its own ports (18655/18656) so it never collides with the route
 * rehearsal (18555/18556) or the Arc–Base suite (18545/18546). Additional fork-only substitutions:
 *
 * 5. Arc's native USDC reads balances through precompiles anvil does not implement, so an EIP-3009
 *    ForkUsdc runs at 0x3600… (as in evm/fork.ts) and the anvil development payer is minted a balance.
 *    x402 payments in this harness are therefore PAYMENT FIXTURES: real signatures, fork-only funds.
 *
 * The existing canonical asset is deployed once by the route engine (`deployHub`) before any job;
 * launch jobs adopt it rather than issuing their own.
 */
import { createTestClient, createWalletClient, http, parseAbi, publicActions, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CODE, linked } from '../evm/contracts'
import { DEV, PINNED } from '../evm/fork'
import { configFromJson, configToJson, robinhoodForkEnvironment, type RobinhoodForkEnvironment } from './fork'
import { FULFILLMENT_LABELS, type RobinhoodFulfillmentConfig } from './fulfillment'

export const FULFILLMENT_PORTS = { arc: 18655, robinhood: 18656, service: 4046 } as const
/** Conservative fixed rate for Robinhood ETH gas: 5,000 USDC per ETH, in USDC atoms per 1e18 wei. */
const ETH_USDC_ATOMS = 5_000_000_000n

export interface FulfillmentForkEnvironment extends RobinhoodForkEnvironment { fulfillment: RobinhoodFulfillmentConfig; payer: Address }

export async function fulfillmentForkEnvironment(options: { arcPort?: number; robinhoodPort?: number; confirmations?: { arc: number; robinhood: number }; assetId?: string; payerUsdc?: bigint } = {}): Promise<FulfillmentForkEnvironment> {
  const env = await robinhoodForkEnvironment({ arcPort: options.arcPort ?? FULFILLMENT_PORTS.arc, robinhoodPort: options.robinhoodPort ?? FULFILLMENT_PORTS.robinhood,
    confirmations: options.confirmations, assetId: options.assetId ?? 'equilibrium-robinhood-fulfillment-1' })
  try {
    const operator = privateKeyToAccount(DEV.operator)
    const test = createTestClient({ mode: 'anvil', transport: http(env.arc.url) }).extend(publicActions)
    const wallet = createWalletClient({ account: operator, transport: http(env.arc.url) })
    const deployed = await test.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: operator, chain: null, data: linked(CODE.ForkUsdc) }) })
    if (!deployed.contractAddress) throw new Error('ForkUsdc deployment failed')
    await test.setCode({ address: PINNED.arc.usdc, bytecode: (await test.getCode({ address: deployed.contractAddress }))! })
    const payer = privateKeyToAccount(DEV.payer).address
    await test.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: operator, chain: null, address: PINNED.arc.usdc, abi: parseAbi(['function mint(address,uint256)']), functionName: 'mint', args: [payer, options.payerUsdc ?? 1_000_000_000n] }) })
    // Arbitrum ignores priority fees; without this the fork charges anvil's 1 gwei suggestion, ~50x the base fee.
    const route = { ...env.config, robinhood: { ...env.config.robinhood, priorityFeeWei: 0n } }
    const fulfillment: RobinhoodFulfillmentConfig = {
      route,
      arc: { usdc: PINNED.arc.usdc, factory: PINNED.arc.factory },
      pricing: { arc: 1_000_000n, robinhood: ETH_USDC_ATOMS },
      budgets: { payment: '1000000', canonical: '5000000', manager: '10000000', debit: '2000000', credit: '2000000', pool: '5000000' },
      labels: FULFILLMENT_LABELS,
    }
    return { ...env, config: route, fulfillment, payer }
  } catch (cause) { env.stop(); throw cause }
}

/** The on-disk form a separate worker or service process loads. Keys stay fork development keys. */
export function fulfillmentToJson(config: RobinhoodFulfillmentConfig, guardianSets: { arc: number; robinhood: number }): string {
  return JSON.stringify({ ...config, route: JSON.parse(configToJson(config.route, guardianSets)) as unknown }, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
}
export function fulfillmentFromJson(json: string): RobinhoodFulfillmentConfig {
  const raw = JSON.parse(json, (_, v: unknown) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Omit<RobinhoodFulfillmentConfig, 'route'> & { route: unknown }
  return { ...raw, route: configFromJson(JSON.stringify(raw.route, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))) }
}
