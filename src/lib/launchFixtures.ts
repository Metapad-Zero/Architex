/**
 * Dev-only fake launchpad. Loaded only via a dynamic import inside
 * `import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'`, which is a
 * compile-time dead branch in production. The marker string below must not appear in dist/.
 */
import { getAddress, keccak256, toHex, type Address, type Hash } from 'viem'
import { INITIAL_CURVE, quoteBuy, quoteSell, type CurveState } from './curve'
import type { LaunchRecord, LaunchTrade } from './launch'
import { setLaunchFixtureApi } from './launchFixtureApi'
import { rememberToken } from './tokens'
import { activeChain } from '../chain'

export const LAUNCHPAD_FIXTURE_XSS_PAYLOAD = '<img src=x onerror=alert(1)>'

const USDC = 1_000_000n
const FIXTURE_LAUNCH_FEE = 10n * USDC
const FIXTURE_USDC_BALANCE = 10_000n * USDC
const CREATOR = getAddress('0x00000000000000000000000000000000000000c0')
const NOW = 1_700_000_000n

function addr(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, '0')}`)
}

function stateAfter(usdcIn: bigint): CurveState {
  return quoteBuy(INITIAL_CURVE, usdcIn).next
}

export interface FixtureLaunch extends LaunchRecord {
  state: CurveState
}

interface FixtureStore {
  launches: FixtureLaunch[]
  trades: Map<string, LaunchTrade[]>
  balances: Map<string, bigint>
  allowances: Map<string, bigint>
  version: number
}

const listeners = new Set<() => void>()

function key(owner: string, token: string): string {
  return `${owner.toLowerCase()}:${token.toLowerCase()}`
}

function seedLaunch(
  token: Address,
  name: string,
  symbol: string,
  metadataURI: string,
  state: CurveState,
  graduated: boolean,
  createdAt: bigint,
): FixtureLaunch {
  rememberToken({ address: token, name, symbol, decimals: 18, faucet: false, isLaunch: true })
  return {
    token,
    creator: CREATOR,
    pair: addr(Number.parseInt(token.slice(-2), 16) + 100),
    virtualUsdc: state.virtualUsdc,
    virtualTokens: state.virtualTokens,
    tokensSold: state.tokensSold,
    createdAt,
    graduated,
    metadataURI,
    name,
    symbol,
    state,
  }
}

function initialStore(): FixtureStore {
  // Scaled to a 25,000 USDC curve: about half sold, nearly sold out, and barely started.
  const mid = stateAfter(5_700n * USDC)
  const high = stateAfter(20_000n * USDC)
  const low = stateAfter(150n * USDC)
  const done = quoteBuy(INITIAL_CURVE, 1_000_000n * USDC)
  const launches: FixtureLaunch[] = [
    seedLaunch(addr(1), 'Doge on Arc', 'DOGE', 'https://example.com/doge.png', mid, false, NOW - 3_600n),
    seedLaunch(addr(2), 'Pepe', 'PEPE', '', INITIAL_CURVE, false, NOW - 120n),
    seedLaunch(addr(3), 'Graduated Coin', 'GRAD', 'https://example.com/grad.png', done.next, true, NOW - 86_400n),
    seedLaunch(addr(4), LAUNCHPAD_FIXTURE_XSS_PAYLOAD, 'XSS', 'javascript:alert(1)', low, false, NOW - 7_200n),
    seedLaunch(addr(5), 'Almost there', 'NEAR', '', high, false, NOW - 14_400n),
    seedLaunch(addr(6), 'Fresh mint', 'MINT', 'https://example.com/mint.png', INITIAL_CURVE, false, NOW - 30n),
  ]
  const trades = new Map<string, LaunchTrade[]>()
  const dogeBuy = quoteBuy(INITIAL_CURVE, 5_700n * USDC)
  trades.set(addr(1).toLowerCase(), [
    {
      trader: CREATOR,
      isBuy: true,
      usdcAmount: dogeBuy.usdcSpent,
      tokenAmount: dogeBuy.tokensOut,
      fee: dogeBuy.fee,
      time: Number(NOW - 3_500n),
      txHash: keccak256(toHex('fixture-doge-buy')),
      block: 1,
    },
  ])
  trades.set(addr(3).toLowerCase(), [
    {
      trader: CREATOR,
      isBuy: true,
      usdcAmount: done.usdcSpent,
      tokenAmount: done.tokensOut,
      fee: done.fee,
      time: Number(NOW - 86_000n),
      txHash: keccak256(toHex('fixture-grad-buy')),
      block: 2,
    },
  ])
  return { launches, trades, balances: new Map(), allowances: new Map(), version: 1 }
}

let store: FixtureStore = initialStore()

function emit(): void {
  store = { ...store, version: store.version + 1 }
  listeners.forEach((listener) => listener())
}

function syncRecord(launch: FixtureLaunch): FixtureLaunch {
  return {
    ...launch,
    virtualUsdc: launch.state.virtualUsdc,
    virtualTokens: launch.state.virtualTokens,
    tokensSold: launch.state.tokensSold,
  }
}

export function subscribeLaunchFixtures(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function launchFixturesVersion(): number {
  return store.version
}

export function fixtureLaunchFee(): bigint {
  return FIXTURE_LAUNCH_FEE
}

export function listFixtureLaunches(): LaunchRecord[] {
  return [...store.launches].map(syncRecord).sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1))
}

export function getFixtureLaunch(token: Address): LaunchRecord | undefined {
  const found = store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())
  return found ? syncRecord(found) : undefined
}

export function fixtureBalance(owner: Address | undefined, token: Address): bigint {
  if (!owner) return 0n
  const stored = store.balances.get(key(owner, token))
  if (stored !== undefined) return stored
  if (token.toLowerCase() === activeChain.usdc.toLowerCase()) return FIXTURE_USDC_BALANCE
  return 0n
}

export function fixtureAllowance(owner: Address | undefined, token: Address): bigint {
  if (!owner) return 0n
  return store.allowances.get(key(owner, token)) ?? 0n
}

export function fixtureTrades(token: Address): LaunchTrade[] {
  return [...(store.trades.get(token.toLowerCase()) ?? [])].sort((a, b) => b.time - a.time).slice(0, 50)
}

function setBalance(owner: Address, token: Address, value: bigint): void {
  store.balances.set(key(owner, token), value)
}

export function fixtureApprove(owner: Address, token: Address, value: bigint): Hash {
  store.allowances.set(key(owner, token), value)
  emit()
  return keccak256(toHex(`fixture-approve:${owner}:${value}`))
}

export function fixtureBuy(owner: Address, token: Address, usdcIn: bigint): { hash: Hash; tokensOut: bigint; usdcSpent: bigint; graduates: boolean } {
  const launch = store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())
  if (!launch || launch.graduated) throw new Error('CurveGraduated')
  const quote = quoteBuy(launch.state, usdcIn)
  const usdc = activeChain.usdc
  setBalance(owner, usdc, fixtureBalance(owner, usdc) - quote.usdcSpent)
  setBalance(owner, token, fixtureBalance(owner, token) + quote.tokensOut)
  launch.state = quote.next
  launch.graduated = quote.graduates
  const hash = keccak256(toHex(`fixture-buy:${token}:${store.version}`))
  const list = store.trades.get(token.toLowerCase()) ?? []
  list.unshift({
    trader: owner,
    isBuy: true,
    usdcAmount: quote.usdcSpent,
    tokenAmount: quote.tokensOut,
    fee: quote.fee,
    time: Math.floor(Date.now() / 1000),
    txHash: hash,
    block: store.version + 10,
  })
  store.trades.set(token.toLowerCase(), list)
  emit()
  return { hash, tokensOut: quote.tokensOut, usdcSpent: quote.usdcSpent, graduates: quote.graduates }
}

export function fixtureSell(owner: Address, token: Address, tokensIn: bigint): { hash: Hash; usdcOut: bigint } {
  const launch = store.launches.find((item) => item.token.toLowerCase() === token.toLowerCase())
  if (!launch || launch.graduated) throw new Error('CurveGraduated')
  const quote = quoteSell(launch.state, tokensIn)
  const usdc = activeChain.usdc
  setBalance(owner, token, fixtureBalance(owner, token) - tokensIn)
  setBalance(owner, usdc, fixtureBalance(owner, usdc) + quote.usdcOut)
  launch.state = quote.next
  const hash = keccak256(toHex(`fixture-sell:${token}:${store.version}`))
  const list = store.trades.get(token.toLowerCase()) ?? []
  list.unshift({
    trader: owner,
    isBuy: false,
    usdcAmount: quote.gross,
    tokenAmount: tokensIn,
    fee: quote.fee,
    time: Math.floor(Date.now() / 1000),
    txHash: hash,
    block: store.version + 10,
  })
  store.trades.set(token.toLowerCase(), list)
  emit()
  return { hash, usdcOut: quote.usdcOut }
}

export function fixtureCreateToken(
  owner: Address,
  name: string,
  symbol: string,
  metadataURI: string,
  initialBuyUsdc: bigint,
): { hash: Hash; token: Address } {
  const token = addr(store.launches.length + 10)
  let state = INITIAL_CURVE
  let graduated = false
  const usdc = activeChain.usdc
  setBalance(owner, usdc, fixtureBalance(owner, usdc) - FIXTURE_LAUNCH_FEE)
  const hash = keccak256(toHex(`fixture-create:${token}`))
  if (initialBuyUsdc > 0n) {
    const quote = quoteBuy(state, initialBuyUsdc)
    setBalance(owner, usdc, fixtureBalance(owner, usdc) - quote.usdcSpent)
    setBalance(owner, token, fixtureBalance(owner, token) + quote.tokensOut)
    state = quote.next
    graduated = quote.graduates
    store.trades.set(token.toLowerCase(), [
      {
        trader: owner,
        isBuy: true,
        usdcAmount: quote.usdcSpent,
        tokenAmount: quote.tokensOut,
        fee: quote.fee,
        time: Math.floor(Date.now() / 1000),
        txHash: hash,
        block: store.version + 10,
      },
    ])
  }
  const launch = seedLaunch(token, name, symbol, metadataURI, state, graduated, BigInt(Math.floor(Date.now() / 1000)))
  launch.creator = owner
  store.launches.unshift(launch)
  emit()
  return { hash, token }
}

setLaunchFixtureApi({
  subscribe: subscribeLaunchFixtures,
  version: launchFixturesVersion,
  launchFee: fixtureLaunchFee,
  list: listFixtureLaunches,
  get: getFixtureLaunch,
  balance: fixtureBalance,
  allowance: fixtureAllowance,
  trades: fixtureTrades,
  approve: fixtureApprove,
  buy: fixtureBuy,
  sell: fixtureSell,
  create: fixtureCreateToken,
})
