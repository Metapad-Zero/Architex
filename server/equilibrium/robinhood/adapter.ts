import { LaunchError, type PromotionalTokenAdapter } from '../types'
import { ROBINHOOD_DECISIONS, ROBINHOOD_MAINNET, ROBINHOOD_TESTNET, type RobinhoodDecision } from './pins'

/**
 * The Robinhood spoke's public adapter. It is CLOSED: every entry point refuses, in every mode,
 * and names the exact decisions still missing. Only an owner-approved change to this file (with
 * deployed addresses, custody and funding) may open it; no environment flag or config file can.
 * The fork rehearsal lives in route.ts and refuses non-loopback RPCs.
 */
export function robinhoodStatus() {
  return {
    route: 'closed' as const,
    mainnet: { chainId: ROBINHOOD_MAINNET.chainId, wormholeChainId: ROBINHOOD_MAINNET.wormholeChainId, core: ROBINHOOD_MAINNET.core, venue: ROBINHOOD_MAINNET.venue.factory },
    testnet: { chainId: ROBINHOOD_TESTNET.chainId, core: ROBINHOOD_TESTNET.core, venue: ROBINHOOD_TESTNET.venue },
    quoteAsset: { candidate: ROBINHOOD_MAINNET.usdgFixture, symbol: 'USDG', status: 'provisional-fork-fixture' as const },
    deployments: { token: null, manager: null, transceiver: null, pool: null },
    decisions: ROBINHOOD_DECISIONS.map((d): RobinhoodDecision => d.key),
  }
}

export function robinhoodClosedAdapter(mode: 'testnet' | 'live'): PromotionalTokenAdapter {
  const refuse = (): never => {
    throw new LaunchError(503, 'route_closed', `The Robinhood spoke is closed. Missing: ${ROBINHOOD_DECISIONS.map((d) => d.key).join(', ')}. No EQUILIBRIUM token, manager, transceiver or pool exists on Robinhood Chain.`)
  }
  return {
    mode,
    version: 'robinhood-closed-v1',
    terms: { chainId: mode === 'live' ? 5042 : 5042002, asset: '0x3600000000000000000000000000000000000000', payTo: '0x0000000000000000000000000000000000000000', name: 'USDC', version: '2' },
    assertReady: refuse, budgets: refuse, prepare: refuse, observe: refuse, broadcast: refuse,
  }
}
