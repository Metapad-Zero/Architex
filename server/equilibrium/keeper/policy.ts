/**
 * The bounded policy: whether a cycle may open at all, and on what terms.
 *
 * Pure functions over a snapshot, so every refusal is reproducible from recorded numbers. The
 * ordering is deliberate — anything that forbids trading outright is checked before price, so a
 * halted or exposed keeper never reports an opportunity it is not allowed to take.
 *
 * Fees are already inside the pool quotes, once. Gas, the reserved recovery leg and an execution
 * buffer are added on top. The keeper trades only its own vault inventory: it never rebases holders,
 * never redistributes, and never counts pool inventory as its own.
 */
import type { ChainQuote, CycleCandidate, KeeperChain, KeeperDecision, KeeperPolicy, KeeperSnapshot } from './types'

const big = (value: string) => BigInt(value)
const max = (a: bigint, b: bigint) => (a > b ? a : b)

/** Net cash the vault on `chain` has drained so far: paid out minus taken in. */
export const drained = (quote: ChainQuote) => max(big(quote.spentQuote) - big(quote.receivedQuote), 0n)

/** Quote the buy chain must have on hand to pay the purchase and its own gas at all. */
export function requiredBuyCash(buyCost: bigint, buy: ChainQuote): bigint {
  return buyCost + big(buy.legCost)
}

/** Quote that must still be there after the purchase, so the unwind is funded before it is needed. */
export function requiredReserve(policy: KeeperPolicy): bigint {
  return big(policy.recoveryReserve) + big(policy.recoveryCost)
}

/** Worst-case gas and recovery cost of the whole cycle, in quote atoms. */
export function cycleCost(buy: ChainQuote, sell: ChainQuote, policy: KeeperPolicy): bigint {
  return big(buy.legCost) + big(sell.legCost) + big(policy.recoveryCost)
}

/**
 * The most a leg's worst-case gas may come to. A leg costed at quote time may cost more by the time
 * it is sent — fees move — so the allowance is the costed figure plus whatever edge the cycle has
 * over the minimum, minus anything an earlier leg already overran, and never above the absolute
 * per-leg ceiling. A gas spike therefore refuses the leg instead of quietly eating the profit.
 */
export function legBudget(candidate: CycleCandidate, policy: KeeperPolicy, costedLegCost: string, overrun = 0n): bigint {
  const slack = big(candidate.edge) - big(policy.minEdge) - overrun
  const allowed = big(costedLegCost) + (slack > 0n ? slack : 0n)
  const ceiling = big(policy.maxLegCost)
  return allowed < ceiling ? allowed : ceiling
}

/** Buy limit and sell floor a leg is bound to on-chain, with the policy's slippage allowance. */
export function legLimits(candidate: CycleCandidate, policy: KeeperPolicy) {
  const bps = BigInt(policy.slippageBps)
  return {
    buyLimit: (big(candidate.buyCost) * (10_000n + bps)) / 10_000n,
    sellFloor: (big(candidate.sellProceeds) * (10_000n - bps)) / 10_000n,
  }
}

function pair(snapshot: KeeperSnapshot, buy: KeeperChain, sell: KeeperChain, policy: KeeperPolicy): { candidate: CycleCandidate; blocked: null } | { candidate: null; blocked: KeeperDecision } {
  const b = snapshot.quotes[buy]
  const s = snapshot.quotes[sell]
  const tokens = big(snapshot.tokens)
  const buyCost = big(b.buyCost)
  const sellProceeds = big(s.sellProceeds)
  const cost = cycleCost(b, s, policy)
  const edge = sellProceeds - buyCost - cost - big(policy.buffer)
  const candidate: CycleCandidate = { tokens: snapshot.tokens, buy, sell, buyCost: b.buyCost, sellProceeds: s.sellProceeds, cost: cost.toString(), edge: edge.toString() }
  const no = (reason: KeeperDecision['reason'], detail: string) => ({ candidate: null, blocked: { candidate: null, reason, detail } as KeeperDecision })

  if (edge < big(policy.minEdge)) {
    return no('no_edge', `Buying ${tokens} on ${buy} for ${buyCost} and selling on ${sell} for ${sellProceeds} leaves ${edge} after ${cost} of costs and a ${policy.buffer} buffer, below the ${policy.minEdge} minimum edge.`)
  }
  if (tokens > big(policy.maxTokens)) return no('size', `${tokens} tokens exceeds the ${policy.maxTokens} per-cycle limit.`)
  // The keeper sells only inventory it already holds on the selling chain: it never shorts.
  if (big(s.keeperTokens) < tokens) return no('inventory', `${sell} holds ${s.keeperTokens} keeper tokens, short of the ${tokens} the sale needs. Refill is a separate authorized route.`)
  const need = requiredBuyCash(buyCost, b)
  if (big(b.keeperQuote) < need) return no('inventory', `${buy} holds ${b.keeperQuote} quote atoms, short of the ${need} the purchase and its gas need. Refill is a separate authorized route.`)
  // Reserved recovery capacity: the unwind must still be funded after the purchase settles.
  const left = big(b.keeperQuote) - need
  if (left < requiredReserve(policy)) {
    return no('recovery_reserve', `${buy} would be left with ${left}, below the ${policy.recoveryReserve} recovery reserve plus ${policy.recoveryCost} recovery cost.`)
  }
  if (big(b.spentQuote) + buyCost + big(b.legCost) > big(policy.spendCap)) {
    return no('spend_cap', `${buy} has spent ${b.spentQuote}; this purchase would pass the ${policy.spendCap} session spending cap.`)
  }
  return { candidate, blocked: null }
}

/**
 * The single best cycle the snapshot allows, or the specific reason there is none.
 *
 * Both directions are considered at the same token quantity. Nothing about the price is consulted
 * until the keeper is allowed to trade at all.
 */
export function decide(snapshot: KeeperSnapshot, policy: KeeperPolicy): KeeperDecision {
  const chains: KeeperChain[] = ['arc', 'base']
  if (snapshot.maintenance?.length) return { candidate: null, reason: 'unresolved_exposure', detail: `Inventory maintenance is unfinished: ${snapshot.maintenance.join(', ')}. Reconcile it before opening a cycle.` }
  const halted = chains.filter((chain) => snapshot.quotes[chain].halted)
  if (halted.length) return { candidate: null, reason: 'halted', detail: `The keeper vault on ${halted.join(' and ')} is halted. Recover the open position, then resume.` }
  if (snapshot.unresolved.length) {
    return { candidate: null, reason: 'unresolved_exposure', detail: `${snapshot.unresolved.length} cycle(s) still hold an open position: ${snapshot.unresolved.join(', ')}. Recovery comes before new exposure.` }
  }
  const open = chains.filter((chain) => snapshot.quotes[chain].openCycles > 0)
  if (open.length) return { candidate: null, reason: 'unresolved_exposure', detail: `The vault on ${open.join(' and ')} reports an open cycle on-chain. Close or recover it first.` }
  if (big(snapshot.loss) >= big(policy.lossCap)) {
    return { candidate: null, reason: 'loss_cap', detail: `Realized loss ${snapshot.loss} has reached the ${policy.lossCap} session cap. The keeper stops until the operator reviews it.` }
  }
  if (snapshot.stalled.length) {
    return { candidate: null, reason: 'chain_unavailable', detail: `${snapshot.stalled.join(' and ')} did not produce a block across the availability window. The keeper does not trade against a chain it cannot read.` }
  }
  const stale = chains.filter((chain) => snapshot.lag[chain].blocks > policy.maxBlockLag || snapshot.lag[chain].seconds > policy.maxQuoteAgeSeconds)
  if (stale.length) {
    const shown = stale.map((chain) => `${chain} ${snapshot.lag[chain].blocks} blocks / ${snapshot.lag[chain].seconds}s behind`).join(', ')
    return { candidate: null, reason: 'stale_quote', detail: `Quotes are stale (${shown}); the limits are ${policy.maxBlockLag} blocks and ${policy.maxQuoteAgeSeconds}s.` }
  }
  const attempts = [pair(snapshot, 'arc', 'base', policy), pair(snapshot, 'base', 'arc', policy)]
  const viable = attempts.flatMap((a) => (a.candidate ? [a.candidate] : []))
  if (!viable.length) {
    // Report the more informative refusal: a blocked-but-profitable route beats "no edge".
    const blocked = attempts.flatMap((a) => (a.blocked ? [a.blocked] : []))
    const ranked = blocked.find((d) => d.reason !== 'no_edge') ?? blocked[0]
    return ranked
  }
  const best = viable.reduce((a, b) => (big(b.edge) > big(a.edge) ? b : a))
  return { candidate: best, reason: 'ok', detail: `Buying ${best.tokens} on ${best.buy} and selling on ${best.sell} clears ${best.edge} quote atoms after ${best.cost} of costs and the buffer.` }
}

/**
 * The recovery decision for an open position: unwind on the chain it was bought on, at the worst
 * price the policy will accept. Refuses when the unwind would pass the loss cap — the position then
 * stays open and the keeper stays halted, rather than the limit being quietly ignored.
 */
export function decideRecovery(
  snapshot: KeeperSnapshot, policy: KeeperPolicy, position: { cycle: string; buy: KeeperChain; tokens: string; spent: string },
): { floor: string; loss: string } | { refused: string } {
  const b = snapshot.quotes[position.buy]
  if (snapshot.lag[position.buy].blocks > policy.maxBlockLag || snapshot.lag[position.buy].seconds > policy.maxQuoteAgeSeconds) {
    return { refused: `${position.buy} quotes are stale; recovery needs a fresh price on the purchase market.` }
  }
  if (snapshot.stalled.includes(position.buy)) return { refused: `${position.buy} is unavailable; the position stays open.` }
  if (big(b.keeperTokens) < big(position.tokens)) return { refused: `${position.buy} holds ${b.keeperTokens} keeper tokens, fewer than the ${position.tokens} to unwind.` }
  const proceeds = big(b.sellProceeds)
  const floor = (proceeds * (10_000n - BigInt(policy.slippageBps))) / 10_000n
  // Worst case the operator accepts: the floor price, this leg's gas, and what the purchase cost.
  const loss = big(position.spent) + big(b.legCost) - floor
  const remaining = big(policy.lossCap) - big(snapshot.loss)
  if (loss > remaining) {
    return { refused: `Unwinding ${position.cycle} on ${position.buy} could realize ${loss}, above the ${remaining} of loss budget left. The position stays open and the keeper stays halted.` }
  }
  if (big(b.keeperQuote) < big(b.legCost)) return { refused: `${position.buy} cannot pay the ${b.legCost} recovery gas from ${b.keeperQuote}.` }
  return { floor: floor.toString(), loss: (loss > 0n ? loss : 0n).toString() }
}
