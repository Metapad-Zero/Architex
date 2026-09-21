import { activeChain } from '../chain'

/** USDC is also Arc's gas token, so spending the whole balance leaves nothing for the fee. 0.1 USDC covers a pair-creating addLiquidity (~3M gas) with room for a gas-price spike. */
export const USDC_GAS_RESERVE = 100_000n

export function spendableBalance(token: string, balance: bigint): bigint {
  if (token.toLowerCase() !== activeChain.usdc.toLowerCase()) return balance
  return balance > USDC_GAS_RESERVE ? balance - USDC_GAS_RESERVE : 0n
}
