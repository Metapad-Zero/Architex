/**
 * Executable quotes, read out of the selected pool contracts themselves.
 *
 * `EquilibriumKeeper.probe` performs the swap the keeper would perform and returns the result by
 * reverting, so nothing is spent and nothing is approximated off-chain. On Uniswap v3 the pool
 * computes the swap and the keeper's callback reverts with the amounts the pool asked for — the
 * route Uniswap's own quoter uses. On the Architex pair the closed-form constant-product amount is
 * computed from the pair's live `getReserves()` with the pair's own 0.30% fee, counted once; the
 * pair's K check is what validates it when the leg actually executes, and the fork rehearsal asserts
 * the quoted amount equals the executed amount.
 *
 * Both chains are always quoted for the SAME token quantity. A cheap chain and an expensive chain
 * priced at different sizes is not a comparison.
 */
import {
  BaseError, ContractFunctionRevertedError, createPublicClient, defineChain, http,
  type Address, type Block, type PublicClient,
} from 'viem'
import { erc20Abi, keeperAbi, pairAbi, poolAbi } from './contracts'
import { KeeperError, type ChainQuote, type KeeperChain, type KeeperChainConfig, type KeeperConfig, type KeeperVenue } from './types'

/**
 * Planning allowance for one `run` leg, per venue. Deliberately pessimistic: the candidate is costed
 * with it, and the bounded sender refuses to send a leg whose measured worst case exceeds what the
 * candidate was costed with, so a cheaper estimate can never turn into an over-budget send.
 */
export const LEG_GAS: Record<KeeperVenue, bigint> = { 'architex-pair': 260_000n, 'uniswap-v3-pool': 420_000n }
// No OP Stack fee oracle is used for Robinhood.

export function keeperChain(config: KeeperChainConfig) {
  return defineChain({ id: config.chainId, name: config.chain, nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 }, rpcUrls: { default: { http: [config.rpc] } } })
}

export function keeperClients(config: Pick<KeeperConfig, 'arc' | 'robinhood'>): Record<KeeperChain, PublicClient> {
  return {
    arc: createPublicClient({ chain: keeperChain(config.arc), transport: http(config.arc.rpc) }),
    robinhood: createPublicClient({ chain: keeperChain(config.robinhood), transport: http(config.robinhood.rpc) }),
  }
}

export const toQuoteAtoms = (chain: KeeperChainConfig, wei: bigint) => (wei * chain.quoteAtomsPerNative + 10n ** 18n - 1n) / 10n ** 18n

/** Explicit EIP-1559 fees, so the worst case costed here is the one a send may actually pay. */
export async function legFees(client: PublicClient, chain: KeeperChainConfig) {
  if (chain.priorityFeeWei === undefined) {
    const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas()
    return { maxFeePerGas, maxPriorityFeePerGas }
  }
  const block = await client.getBlock()
  return { maxPriorityFeePerGas: chain.priorityFeeWei, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + chain.priorityFeeWei }
}

/** Worst-case cost of `gas` on this chain in quote atoms, L1 data fee included where it applies. */
export function legCost(_client: PublicClient, chain: KeeperChainConfig, gas: bigint, maxFeePerGas: bigint): bigint {
  let worst = gas * maxFeePerGas
  assertInputs(chain)
  worst += BigInt(chain.feeInput.l1UpperWei)
  return toQuoteAtoms(chain, worst)
}

/** Decode the `Quoted` revert the probe answers with. Any other revert is a real failure. */
async function probe(client: PublicClient, chain: KeeperChainConfig, operator: Address, buy: boolean, tokens: bigint, blockNumber: bigint): Promise<bigint> {
  try {
    await client.simulateContract({ account: operator, address: chain.keeper, abi: keeperAbi, functionName: 'probe', args: [buy, tokens], blockNumber })
  } catch (cause) {
    const revert = cause instanceof BaseError ? cause.walk((e) => e instanceof ContractFunctionRevertedError) : null
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'Quoted') {
      const [amountIn, amountOut] = revert.data.args as readonly [bigint, bigint]
      const answer = buy ? amountIn : amountOut
      if (answer === 0n) throw new KeeperError('size', `${chain.chain}: the pool quoted zero for ${tokens} tokens.`)
      if (buy && amountOut !== tokens) throw new KeeperError('size', `${chain.chain}: the pool could only fill ${amountOut} of ${tokens} tokens.`)
      if (!buy && amountIn !== tokens) throw new KeeperError('size', `${chain.chain}: the pool could only take ${amountIn} of ${tokens} tokens.`)
      return answer
    }
    const reason = revert instanceof ContractFunctionRevertedError ? (revert.reason ?? revert.data?.errorName ?? String(revert)) : String(cause)
    throw new KeeperError('size', `${chain.chain}: the pool cannot quote ${tokens} tokens (${reason}).`)
  }
  throw new KeeperError('chain_unavailable', `${chain.chain}: probe returned without a quote; the keeper at ${chain.keeper} is not an EquilibriumKeeper.`)
}

/** The block a quote is read at: the chain's finalized block under this configuration. */
export async function quoteBlock(client: PublicClient, chain: KeeperChainConfig): Promise<Block> {
  if (chain.finality === 'finalized') return client.getBlock({ blockTag: 'finalized' })
  const latest = await client.getBlockNumber({ cacheTime: 0 })
  const confirmations = BigInt(chain.finality)
  return client.getBlock({ blockNumber: latest > confirmations ? latest - confirmations : 0n })
}

/**
 * One chain's executable quote for `tokens`, with the vault's inventory and counters read at the
 * same block, so an inventory decision is never made against a different state than the price.
 */
export async function readChainQuote(
  client: PublicClient, chain: KeeperChainConfig, operator: Address, tokens: bigint,
): Promise<ChainQuote> {
  assertInputs(chain)
  const block = await quoteBlock(client, chain)
  const blockNumber = block.number
  if (blockNumber === null) throw new KeeperError('chain_unavailable', `${chain.chain}: the finalized block has no number.`)
  const at = { blockNumber } as const
  const read = <T>(promise: Promise<T>) => promise
  const [buyCost, sellProceeds, keeperTokens, keeperQuote, spentQuote, receivedQuote, openCycles, halted, poolToken0] = await Promise.all([
    probe(client, chain, operator, true, tokens, blockNumber),
    probe(client, chain, operator, false, tokens, blockNumber),
    read(client.readContract({ address: chain.token, abi: erc20Abi, functionName: 'balanceOf', args: [chain.keeper], ...at })),
    read(client.readContract({ address: chain.quote, abi: erc20Abi, functionName: 'balanceOf', args: [chain.keeper], ...at })),
    read(client.readContract({ address: chain.keeper, abi: keeperAbi, functionName: 'spentQuote', ...at })),
    read(client.readContract({ address: chain.keeper, abi: keeperAbi, functionName: 'receivedQuote', ...at })),
    read(client.readContract({ address: chain.keeper, abi: keeperAbi, functionName: 'openCycles', ...at })),
    read(client.readContract({ address: chain.keeper, abi: keeperAbi, functionName: 'halted', ...at })),
    read(client.readContract({ address: chain.pool, abi: chain.venue === 'architex-pair' ? pairAbi : poolAbi, functionName: 'token0', ...at })),
  ])
  if (poolToken0.toLowerCase() !== chain.token.toLowerCase() && poolToken0.toLowerCase() !== chain.quote.toLowerCase()) {
    throw new KeeperError('invalid_configuration', `${chain.chain}: pool ${chain.pool} does not hold the configured token and quote.`)
  }
  const fees = await legFees(client, chain)
  return {
    chain: chain.chain, pool: chain.pool, tokens: tokens.toString(),
    rawBuyCost: buyCost.toString(), rawSellProceeds: sellProceeds.toString(),
    buyCost: valueOf(chain, buyCost, true).toString(), sellProceeds: valueOf(chain, sellProceeds).toString(),
    blockNumber: blockNumber.toString(), observedAt: Number(block.timestamp),
    keeperTokens: keeperTokens.toString(), keeperQuote: valueOf(chain, keeperQuote).toString(),
    spentQuote: valueOf(chain, spentQuote, true).toString(), receivedQuote: valueOf(chain, receivedQuote).toString(),
    openCycles: Number(openCycles), halted,
    legCost: (legCost(client, chain, LEG_GAS[chain.venue], fees.maxFeePerGas)).toString(),
  }
}

/**
 * How far behind its own chain's head a quote sits. Measured against the chain, not the wall clock,
 * so the same rule holds on a pinned fork, a testnet and a live chain.
 */
export async function quoteLag(client: PublicClient, quote: ChainQuote): Promise<{ blocks: number; seconds: number }> {
  const head = await client.getBlock({ blockTag: 'latest', cacheTime: 0 } as Parameters<PublicClient['getBlock']>[0])
  return { blocks: Number((head.number ?? 0n) - BigInt(quote.blockNumber)), seconds: Number(head.timestamp) - quote.observedAt }
}

/** Conversion is explicit and rounded against the keeper. USDG parity is never a default. */
export function assertInputs(chain: KeeperChainConfig) {
  const v = chain.valuation; const f = chain.feeInput
  const now = Math.floor(Date.now() / 1000)
  if (!v || !/^[1-9]\d*$/.test(v.numerator) || !/^[1-9]\d*$/.test(v.denominator) || !v.source || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= now) {
    throw new KeeperError('chain_unavailable', `${chain.chain}: current explicit quote-asset valuation is unavailable.`)
  }
  if (!f || f.kind !== 'fork-fixture' || !/^(0|[1-9]\d*)$/.test(f.l1UpperWei) || !f.source || !Number.isSafeInteger(f.expiresAt) || f.expiresAt <= now || chain.quoteAtomsPerNative <= 0n) {
    throw new KeeperError('chain_unavailable', `${chain.chain}: native valuation or labelled L1 fee fixture is unavailable.`)
  }
}
export function valueOf(chain: KeeperChainConfig, atoms: bigint, up = false): bigint {
  assertInputs(chain)
  const n = BigInt(chain.valuation.numerator); const d = BigInt(chain.valuation.denominator)
  return (atoms * n + (up ? d - 1n : 0n)) / d
}
export function localLimit(chain: KeeperChainConfig, usdc: bigint, buy: boolean): bigint {
  assertInputs(chain)
  const n = BigInt(chain.valuation.numerator); const d = BigInt(chain.valuation.denominator)
  return (usdc * d + (buy ? 0n : n - 1n)) / n
}
