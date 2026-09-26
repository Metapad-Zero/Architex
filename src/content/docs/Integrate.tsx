import type { ReactNode } from 'react'
import { zeroAddress } from 'viem'
import mainnet from '../../deployments/arc-mainnet.json'
import testnet from '../../deployments/arc-testnet.json'
import { UNISWAP_V4_ARC } from '../../lib/deployment'
import { LAUNCH_TOPICS, LAUNCH_V14_TOPICS, MAINNET_USDC_EURC_PAIR, PAIR_INIT_CODE_HASH, UNISWAP_V2_TOPICS } from '../../lib/integration'
import { V14Note } from './V14Note'

const SITE = 'https://architex.fun'

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-10 text-base font-semibold text-ink">{children}</h3>
}

function C({ children }: { children: ReactNode }) {
  return <code className="break-words rounded bg-g100 px-1 text-[0.875em]">{children}</code>
}

function Pre({ children, label }: { children: string; label?: string }) {
  return (
    <figure className="min-w-0">
      {label ? <figcaption className="mb-1 text-2xs font-semibold text-g500">{label}</figcaption> : null}
      <pre className="overflow-x-auto rounded bg-g100 p-3 text-sm leading-5">
        <code>{children}</code>
      </pre>
    </figure>
  )
}

function Rows({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="border-t border-ink text-sm">
      {rows.map(([key, value]) => (
        <div key={key} className="grid gap-1 border-b border-g300 py-2 sm:grid-cols-[168px_minmax(0,1fr)] sm:gap-4">
          <dt className="text-g500">{key}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="break-all underline decoration-1 underline-offset-[3px] hover:text-g700">
      {children}
    </a>
  )
}

function Address({ address, explorer }: { address: string; explorer: string }) {
  return <Link href={`${explorer}/address/${address}`}>{address}</Link>
}

interface Deployment {
  explorerBase: string
  factory: string
  router: string
  lens: string
  launchpad: string
  launchPairFactory: string
  launchRouter: string
  splitPlugin: string
  buybackPlugin: string
  holderPlugin: string
  comboPlugin: string
  deepenPlugin: string
  v14: { launchpad: string; hook: string; router: string; splitPlugin: string; holderPlugin: string; comboPlugin: string }
  tokens: ReadonlyArray<{ symbol: string; address: string; decimals: number }>
}

function contractRows(deployment: Deployment, extra: ReadonlyArray<readonly [string, string]> = []): ReadonlyArray<readonly [string, ReactNode]> {
  // A contract listed before it is deployed sits at the zero address in the deployment file.
  const address = (value: string) => (value === zeroAddress ? 'Not deployed yet' : <Address address={value} explorer={deployment.explorerBase} />)
  return [
    ['Core factory', address(deployment.factory)],
    ['Core router', address(deployment.router)],
    ['Lens (bulk reads)', address(deployment.lens)],
    ['Launchpad (v1.3)', address(deployment.launchpad)],
    ['Launch pair factory', address(deployment.launchPairFactory)],
    ['Launch router', address(deployment.launchRouter)],
    ['Plugin: Split', address(deployment.splitPlugin)],
    ['Plugin: Buyback & burn', address(deployment.buybackPlugin)],
    ['Plugin: Deepen pool', address(deployment.deepenPlugin)],
    ['Plugin: Holders', address(deployment.holderPlugin)],
    ['Plugin: Combo', address(deployment.comboPlugin)],
    ['Launchpad (v1.4)', address(deployment.v14.launchpad)],
    ['Launch hook (v1.4)', address(deployment.v14.hook)],
    ['v4 router (v1.4)', address(deployment.v14.router)],
    ['Plugin: Split (v1.4)', address(deployment.v14.splitPlugin)],
    ['Plugin: Holders (v1.4)', address(deployment.v14.holderPlugin)],
    ['Plugin: Combo (v1.4)', address(deployment.v14.comboPlugin)],
    ...extra.map(([name, value]) => [name, address(value)] as const),
    ...deployment.tokens.map((token) => [`${token.symbol} (${token.decimals} decimals)`, address(token.address)] as const),
  ]
}

const TICKER = `${mainnet.tokens[1].address}_${mainnet.tokens[0].address}`

const SAMPLE_PAIRS = `[
  {
    "ticker_id": "${TICKER}",
    "base": "${mainnet.tokens[1].address}",
    "target": "${mainnet.tokens[0].address}",
    "pool_id": "${MAINNET_USDC_EURC_PAIR}"
  }
]`

const SAMPLE_TICKERS = `[
  {
    "ticker_id": "${TICKER}",
    "base_currency": "${mainnet.tokens[1].address}",
    "target_currency": "${mainnet.tokens[0].address}",
    "pool_id": "${MAINNET_USDC_EURC_PAIR}",
    "last_price": "1.15177646147",
    "base_volume": "64.401711",
    "target_volume": "76.959184",
    "liquidity_in_usd": "563.28",
    "bid": "1.14832113208",
    "ask": "1.15524218803",
    "high": "1.47410117647",
    "low": "1.04609868318"
  }
]`

const SAMPLE_ORDERBOOK = `{
  "ticker_id": "${TICKER}",
  "timestamp": "1790074198000",
  "bids": [["1.14774740178", "0.122599695247"], ["1.14660080098", "0.122660979778"]],
  "asks": [["1.15581966479", "0.122170826012"], ["1.15697548446", "0.122109786375"]]
}`

const SAMPLE_TRADES = `{
  "buy": [
    {
      "trade_id": 22083607000005,
      "price": "1.20241473737",
      "base_volume": "8.316598",
      "target_volume": "10",
      "trade_timestamp": "1790032399",
      "type": "buy"
    }
  ],
  "sell": [
    {
      "trade_id": 22083608000004,
      "price": "1.19216213132",
      "base_volume": "8.992266",
      "target_volume": "10.720239",
      "trade_timestamp": "1790032399",
      "type": "sell"
    }
  ]
}`

const SAMPLE_TOKENLIST = `{
  "name": "Architex",
  "version": { "major": 1, "minor": 1, "patch": 1 },
  "tokens": [
    { "chainId": 5042, "address": "${mainnet.tokens[0].address}", "name": "USDC", "symbol": "USDC", "decimals": 6 },
    {
      "chainId": 5042,
      "address": "0xC25f9f799810A8f73CB707afB5EFC584bE8471bD",
      "name": "architest",
      "symbol": "ATXTST",
      "decimals": 18,
      "logoURI": "${SITE}/api/ipfs/bafkreihj4zhktsccwtmue4vyjqf7cjpkj5lgb7udthp6nf7azi6epkjdd4",
      "tags": ["launch", "curve"],
      "extensions": { "launchpad": "${mainnet.launchpad}", "pool": "0xFD3CB5Ff2cA68B4256a7E0a78f0aCc6dcB5D5360", "creatorFeeBps": 250, "graduated": false }
    }
  ]
}`

const V2_EVENTS = `PairCreated(address indexed token0, address indexed token1,
            address pair, uint256)
  ${UNISWAP_V2_TOPICS.PairCreated}
Swap(address indexed sender, uint256 amount0In, uint256 amount1In,
     uint256 amount0Out, uint256 amount1Out, address indexed to)
  ${UNISWAP_V2_TOPICS.Swap}
Sync(uint112 reserve0, uint112 reserve1)
  ${UNISWAP_V2_TOPICS.Sync}
Mint(address indexed sender, uint256 amount0, uint256 amount1)
  ${UNISWAP_V2_TOPICS.Mint}
Burn(address indexed sender, uint256 amount0, uint256 amount1,
     address indexed to)
  ${UNISWAP_V2_TOPICS.Burn}`

const LAUNCH_EVENTS = `// launchpad
TokenCreated(address indexed token, address indexed creator,
             address indexed plugin, address pair, uint16 creatorFeeBps,
             string name, string symbol, string metadataURI)
  ${LAUNCH_TOPICS.TokenCreated}
Trade(address indexed token, address indexed trader, bool isBuy,
      uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee,
      uint256 creatorFee, uint256 virtualUsdc, uint256 virtualTokens)
  ${LAUNCH_TOPICS.Trade}
Graduated(address indexed token, address indexed pair, uint256 usdcSeeded,
          uint256 tokensSeeded, uint256 liquidityLocked)
  ${LAUNCH_TOPICS.Graduated}

// launch router
PoolTrade(address indexed token, address indexed trader, bool isBuy,
          uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee,
          uint256 creatorFee)
  ${LAUNCH_TOPICS.PoolTrade}`

const QUOTES = `// on the curve
launchpad.quoteBuy(token, usdcIn)
  returns (tokensOut, platformFee, creatorFee, usdcSpent, graduates)
launchpad.quoteSell(token, tokensIn)
  returns (usdcOut, platformFee, creatorFee)
launchpad.curves(token)
  returns pair, virtualUsdc, virtualTokens, tokensSold, graduated,
  creatorFeeBps, plugin and metadataURI
launchpad.spotPrice(token)
  USDC per token, times 10^24
launchpad.tokensLength(), launchpad.curvesPage(start, count)
  every launch, up to 100 a page

// in the launch pool
launchRouter.quoteBuy(token, usdcIn)
  returns (tokensOut, platformFee, creatorFee)
launchRouter.quoteSell(token, tokensIn)
  returns (usdcOut, platformFee, creatorFee)
launchRouter.buy(token, usdcIn, minTokensOut, to, deadline)
launchRouter.sell(token, tokensIn, minUsdcOut, to, deadline)`

const V14_EVENTS = `// launchpad v1.4
TokenCreated(address indexed token, address indexed creator,
             address indexed plugin, bool openPool, uint16 creatorFeeBps,
             string name, string symbol, string metadataURI)
  ${LAUNCH_V14_TOPICS.TokenCreated}
Trade(address indexed token, address indexed trader, bool isBuy,
      uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee,
      uint256 creatorFee, uint256 snipeFee, uint256 virtualUsdc,
      uint256 virtualTokens)
  ${LAUNCH_V14_TOPICS.Trade}
Graduated(address indexed token, bytes32 indexed poolId, uint256 usdcSeeded,
          uint256 tokensSeeded, uint256 liquidityLocked, uint256 snipeLocked)
  ${LAUNCH_V14_TOPICS.Graduated}

// launch hook: every v1.4 pool
PoolOpened(address indexed token, bytes32 indexed poolId, uint160 sqrtPriceX96,
           uint256 tokensAdded, uint256 usdcAdded, uint128 liquidity, bool open)
  ${LAUNCH_V14_TOPICS.PoolOpened}
PoolTrade(address indexed token, address indexed sender, bool isBuy,
          uint256 usdcAmount, uint256 tokenAmount, uint256 platformFee,
          uint256 creatorFee, uint256 snipeFee)
  ${LAUNCH_V14_TOPICS.PoolTrade}
BidLocked(address indexed token, uint256 usdc, uint128 liquidity,
          int24 tickLower, int24 tickUpper)
  ${LAUNCH_V14_TOPICS.BidLocked}
FeesReleased(address indexed token, uint256 platformFee, uint256 creatorFee)
  ${LAUNCH_V14_TOPICS.FeesReleased}

// launchpad v1.4, on a sync (not on a trade)
PoolFeesAccrued(address indexed token, uint256 platformFee, uint256 creatorFee)
  ${LAUNCH_V14_TOPICS.PoolFeesAccrued}`

const V14_POOLS = `// a token's pool, known from launch (hook.poolKeyOf(token))
PoolKey(currency0 = min(USDC, token), currency1 = max(USDC, token),
        fee = 0, tickSpacing = 200, hooks = the launch hook)
poolId = keccak256(abi.encode(PoolKey))

// its price: sqrtPriceX96 is sqrt(currency1 / currency0) in Q64.96
StateView.getSlot0(poolId)
hook.launchOf(token)       returns (poolId, usdcIs0, open, openBlock, ...)

// quotes, fees included: not views, call them with eth_call
v4Router.quoteBuy(token, usdcIn)      returns tokensOut
v4Router.quoteSell(token, tokensIn)   returns usdcOut
v4Router.buy(token, usdcIn, minTokensOut, to, deadline)
v4Router.sell(token, tokensIn, minUsdcOut, to, deadline)

// pool fees wait as the hook's claims until a sync (anyone)
hook.pendingPlatform(token), hook.pendingCreator(token)
launchpad.syncPoolFees(token), launchpad.syncPoolFeesBatch(tokens)
launchpad.pendingCreatorFees(token)   counts them once synced

// snipe fees never wait: each becomes a bid when it is paid
hook.bidCount(token)                  bids placed so far (BidLocked each)`

const ENDPOINTS: ReadonlyArray<readonly [string, string, string]> = [
  ['GET /api/v1/pairs', 'Every market: ticker_id, base, target, pool_id', '5 min'],
  ['GET /api/v1/tickers', '24 hours of price, volume and liquidity per market', '2 min'],
  ['GET /api/v1/orderbook', 'Depth derived from a market’s reserves and fees', '1 min'],
  ['GET /api/v1/historical_trades', 'Trades read from the chain’s event logs', '2 min'],
  ['GET /tokenlist.json', 'The token list (Uniswap Token Lists format)', '15 min'],
]

export function DocsIntegrate() {
  return (
    <div className="space-y-4">
      <p>
        Everything a DEX lister, aggregator, wallet or bot needs to pick up Architex: the chain, every contract, how trades
        show up on-chain, and public endpoints in the formats listers already read. Nothing here needs a key or an account.
      </p>

      <H3>The chain</H3>
      <Rows
        rows={[
          ['Network', 'Arc, Circle’s chain, where gas is paid in USDC'],
          ['Chain ID', <>5042 (Arc Testnet: 5042002)</>],
          ['RPC', <><Link href="https://rpc.mainnet.arc.io">https://rpc.mainnet.arc.io</Link>. Public. eth_getLogs covers at most 10,000 blocks a call, and bursts are rate limited (about three log queries a second in our tests).</>],
          ['Explorer', <Link href={mainnet.explorerBase}>{mainnet.explorerBase}</Link>],
          ['Blocks', 'About every 0.5 seconds, some 170,000 a day'],
          ['USDC', <><Address address={mainnet.tokens[0].address} explorer={mainnet.explorerBase} />, 6 decimals. It is the same balance as the native gas token, which the node reports with 18 decimals: count it once, as the 6-decimal ERC-20.</>],
          ['EURC', <><Address address={mainnet.tokens[1].address} explorer={mainnet.explorerBase} />, 6 decimals</>],
        ]}
      />

      <H3>Contracts on Arc mainnet</H3>
      <Rows
        rows={contractRows(mainnet, [
          ['Pool: USDC/EURC', MAINNET_USDC_EURC_PAIR],
          ['Uniswap v4 PoolManager', UNISWAP_V4_ARC.poolManager],
          ['Uniswap v4 StateView', UNISWAP_V4_ARC.stateView],
        ])}
      />
      <p className="text-sm text-g700">
        The contracts are open source under the MIT license and have not been audited by a third party.
      </p>

      <H3>Contracts on Arc Testnet</H3>
      <Rows
        rows={contractRows(testnet, [
          ['Uniswap v4 PoolManager', UNISWAP_V4_ARC.poolManager],
          ['Uniswap v4 StateView', UNISWAP_V4_ARC.stateView],
        ])}
      />

      <H3>The core AMM is a Uniswap V2 fork</H3>
      <p>
        Core pools are Uniswap V2 pairs in every way an indexer or a router can see: the same constant-product math, the
        same factory and pair functions, and byte-identical events. Any Uniswap V2 indexer can follow them from the factory
        with the values below.
      </p>
      <Rows
        rows={[
          ['Swap fee', '0.30% of the amount paid in, kept in the pool (997/1000), exactly as in Uniswap V2'],
          ['Protocol fee', <>The V2 fee switch (1/6 of fee growth to <C>factory.feeTo()</C>) is off: feeTo is the zero address</>],
          ['Pair address', <>CREATE2 from the factory, salt <C>keccak256(abi.encodePacked(token0, token1))</C>, token0 the lower address</>],
          ['Init code hash', <><C>{PAIR_INIT_CODE_HASH.mainnet}</C> (testnet: <C>{PAIR_INIT_CODE_HASH.testnet}</C>)</>],
          ['LP token', <>&ldquo;Architex LP&rdquo; (ATX-LP), 18 decimals, with EIP-2612 permit. The first 1,000 units are locked at 0x&hellip;dEaD</>],
          ['Factory', <C>getPair, allPairs, allPairsLength, feeTo, feeToSetter, createPair</C>],
          ['Pair', <C>token0, token1, getReserves, factory, price0CumulativeLast, price1CumulativeLast, kLast, swap, skim, sync</C>],
          ['Router', <C>swapExactTokensForTokens, swapTokensForExactTokens, getAmountsOut, getAmountsIn, getAmountOut, getAmountIn, quote, addLiquidity, removeLiquidity, removeLiquidityWithPermit</C>],
        ]}
      />
      <Pre label="The hash reproduces the live pool">{`pairFor(factory, USDC, EURC)
  = ${MAINNET_USDC_EURC_PAIR}
  = factory.allPairs(0)`}</Pre>
      <Pre label="Events, with topic0: the same as Uniswap V2">{V2_EVENTS}</Pre>
      <p>Where it differs from Uniswap V2:</p>
      <ul className="list-disc space-y-2 pl-5">
        <li>The router has no ETH or WETH functions: every asset is an ERC-20, USDC included. The functions it has take the same arguments as Uniswap V2&rsquo;s Router02.</li>
        <li>No fee-on-transfer variants. Fee-on-transfer tokens are not supported.</li>
        <li>
          A flash swap calls <C>architexCall(sender, amount0Out, amount1Out, data)</C> on the receiver, not <C>uniswapV2Call</C>.
        </li>
      </ul>

      <H3>Launchpad and launch pools</H3>
      <p>
        A launch token trades against USDC in two phases: on its bonding curve inside the launchpad, then, once the curve
        sells out, in its own launch pool, which only the launch router can trade. Neither is a Uniswap V2 pair. Index the
        launchpad and launch router events below.
      </p>
      <Rows
        rows={[
          ['Launch token', 'ERC-20, 18 decimals, 1,000,000,000 minted at launch: 800,000,000 sold on the curve, 200,000,000 kept to seed the pool'],
          ['The curve', 'Constant product on virtual reserves, the same for every token. It opens at 0.0000078125 USDC a token and sells out at 0.000125, having raised 25,000 USDC'],
          ['Graduation', 'The buy that sells the last curve token deposits the 200,000,000 tokens and the 25,000 USDC into the launch pool and burns the LP (to 0x…dEaD), in the same transaction'],
          ['Launch pool', <>One LaunchPair per token, created empty at launch by the launch pair factory. Constant product, no pool fee. Only the launch router may call <C>swap</C>; <C>mint</C>, <C>burn</C>, <C>skim</C> and <C>sync</C> are open</>],
          ['Fees', 'A 0.5% platform fee plus the token’s creator fee (0–10%, fixed at launch) on every buy and sell, on the curve and in the pool, both taken from the USDC side and rounded up. Core pools charge only their 0.30%'],
          ['Creator fee', <><C>launchpad.creatorFeeBpsOf(token)</C>, in basis points</>],
        ]}
      />
      <Pre label="Events, with topic0">{LAUNCH_EVENTS}</Pre>
      <p>
        In <C>Trade</C> and <C>PoolTrade</C>, <C>usdcAmount</C> is gross: what a buyer paid, fees included, or what left the
        curve or pool on a sell, of which the seller received <C>usdcAmount - platformFee - creatorFee</C>. After a curve
        trade, its price is <C>virtualUsdc / virtualTokens</C> times 10<sup>12</sup> USDC a token.
      </p>
      <p>
        A LaunchPair also emits Swap, Sync, Mint and Burn with Uniswap V2&rsquo;s topics, but its two amounts are always
        (token, USDC), whatever order the addresses sort in, and it has <C>token()</C> and <C>usdc()</C> instead of{' '}
        <C>token0()</C> and <C>token1()</C>. Its factory emits <C>PairCreated(address indexed token, address pair, uint256)</C>
        {' '}(<C>{LAUNCH_TOPICS.LaunchPairCreated}</C>), not V2&rsquo;s. A V2 indexer will not pick launch pools up as they
        are: read <C>PoolTrade</C>, which also carries the trader and both fees.
      </p>
      <Pre label="Pricing a trade">{QUOTES}</Pre>
      <p>
        Anyone can pair a launch token in a core pool, but trades there skip the creator fee. The site and the endpoints
        below leave such pools out.
      </p>

      <H3>Launchpad v1.4 and Uniswap v4 pools</H3>
      <V14Note
        live="Tokens launched since v1.4 went live graduate this way; v1.3 tokens keep their launch pools."
        pending="Launchpad v1.4 is not live yet. Its addresses above read Not deployed yet until it is; until then, everything above is what runs."
      />
      <p>
        v1.4 keeps v1.3&rsquo;s curves and fees, and graduates each token into its own Uniswap v4 pool behind the
        Architex launch hook instead of a launch pair. The hook takes the 0.5% platform fee and the creator fee in USDC
        on every swap in the pool, whichever router makes it, and the pool charges no LP fee. For 20 blocks after a
        launch and after a pool opens, buys also pay a snipe fee (90% falling to 0), which becomes USDC-only liquidity
        in the pool: the curve&rsquo;s at graduation, a pool buy&rsquo;s inside that buy. Index the launchpad and the
        hook: their events cover every curve and pool trade, fees included.
      </p>
      <Pre label="Events, with topic0">{V14_EVENTS}</Pre>
      <p>
        In <C>PoolTrade</C>, <C>sender</C> is whoever called the PoolManager (a router), not necessarily the trader,
        and <C>usdcAmount</C> is gross as in <C>Trade</C>: all a buyer paid, or all the pool paid out on a sell. It is
        the per-trade record of a pool&rsquo;s fees: the hook keeps them as its ERC-6909 claims in the PoolManager, and
        <C>PoolFeesAccrued</C> fires only when a sync or a creator-fee collection books them in the launchpad. The
        PoolManager&rsquo;s own <C>Swap</C> event, keyed by the pool id, carries the price after each swap.
      </p>
      <Pre label="Pools, prices and quotes">{V14_POOLS}</Pre>
      <p>
        Arc&rsquo;s USDC sorts below most token addresses, so it is currency0 in most v1.4 pools and currency1 in
        the rest: read which from the key. The pools refuse donations. Snipe fees become bids with no separate step:
        each a position of its own, a USDC-only range whose top is 6,932 ticks (about half the price) past a reference
        tick and which runs 92,200 ticks further. A buy in a pool&rsquo;s window places its fee inside the same swap,
        from the cheaper of the tick just before that buy and the graduation tick (the higher tick when USDC is
        currency0, the lower when it is currency1), and emits <C>BidLocked</C> before its <C>PoolTrade</C>; graduation
        places the curve&rsquo;s fees from the graduation tick. So no bid starts above half the graduation price, a buy
        made above the graduation price places its bid on the graduation bid&rsquo;s ticks, and after a crash the next
        bid follows the price down. <C>hook.bidCount(token)</C> counts the bids, and <C>lockHeld(token)</C> is only the
        unit or two of rounding a bid could not take. Such a buy costs about 56,000 to 93,000 more gas when its
        bid&rsquo;s ticks are already in use, and 117,000 to 176,000 when it opens new ones. Uniswap&rsquo;s app and
        routing only reach a pool with a hook like this one once Uniswap has approved the hook, which has not happened.
        The public endpoints below do not list v1.4 markets yet.
      </p>

      <H3>Token details</H3>
      <Rows
        rows={[
          ['metadataURI', <><C>ipfs://&lt;cid&gt;</C>, fixed at launch, read from <C>launchpad.curves(token)</C> or the TokenCreated event</>],
          ['The file', 'JSON with name, symbol, description, image, external_link, twitter and telegram (ERC-7572 names). The image is an ipfs:// address too'],
          ['Addresses', 'One-block CIDv1 (bafkrei…): a framed SHA-256 of the bytes, so any copy can be checked against it'],
          ['Our gateway', <><C>{SITE}/api/ipfs/&lt;cid&gt;</C> serves both files verified and immutable, for files uploaded through Architex only</>],
          ['Name and symbol', <>The token&rsquo;s own <C>name()</C> and <C>symbol()</C> are the truth; the file&rsquo;s copies are informational</>],
        ]}
      />

      <H3>Public endpoints</H3>
      <p>
        Read-only JSON from <C>{SITE}</C>: no key, CORS open to every origin. The market endpoints follow CoinGecko&rsquo;s
        exchange API standard for DEXes, with every market named by contract addresses; the token list follows the Uniswap
        Token Lists schema.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-t border-ink text-left text-sm">
          <thead>
            <tr className="border-b border-g300 text-g500">
              <th scope="col" className="py-2 pr-4 font-normal">Endpoint</th>
              <th scope="col" className="py-2 pr-4 font-normal">Returns</th>
              <th scope="col" className="whitespace-nowrap py-2 font-normal">Cached</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map(([endpoint, returns, cached]) => (
              <tr key={endpoint} className="border-b border-g300 align-top">
                <td className="whitespace-nowrap py-2 pr-4 font-semibold">{endpoint}</td>
                <td className="min-w-[200px] py-2 pr-4">{returns}</td>
                <td className="whitespace-nowrap py-2">{cached}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Three kinds of market, each named by contract addresses:</p>
      <Rows
        rows={[
          ['Core pools', 'ticker_id BASE_TARGET, pool_id the pair. A pool with USDC is quoted in USDC, then EURC, else token0 in token1'],
          ['Launch pools', 'ticker_id TOKEN_USDC, pool_id the launch pair'],
          ['Curves', 'ticker_id TOKEN_USDC, pool_id the token’s own address: its curve’s key inside the launchpad, the way a Uniswap V4 pool is keyed inside its singleton. At graduation the ticker_id stays and pool_id becomes the launch pair'],
        ]}
      />

      <Pre label={`GET ${SITE}/api/v1/pairs`}>{SAMPLE_PAIRS}</Pre>
      <Pre label={`GET ${SITE}/api/v1/tickers`}>{SAMPLE_TICKERS}</Pre>
      <Pre label={`GET ${SITE}/api/v1/orderbook?ticker_id=${TICKER}&depth=4`}>{SAMPLE_ORDERBOOK}</Pre>
      <Pre label={`GET ${SITE}/api/v1/historical_trades?ticker_id=${TICKER}&limit=2`}>{SAMPLE_TRADES}</Pre>
      <Pre label={`GET ${SITE}/tokenlist.json (shortened)`}>{SAMPLE_TOKENLIST}</Pre>
      <p className="text-sm text-g700">Samples from Arc mainnet on 22 September 2026.</p>

      <ul className="list-disc space-y-2 pl-5">
        <li>Numbers are decimal strings. Token amounts are exact, prices carry 12 significant digits and USD is to the cent.</li>
        <li>ticker_id is written checksummed and matched in any case.</li>
        <li>
          <C>orderbook</C>: <C>depth</C> 100 (the default) is 50 levels a side; 0, and anything over 500, is 250 a side.
          Levels are 0.1% apart in marginal price, and exact: taking the first n levels costs what one trade of that size
          would, fees included. <C>timestamp</C> is the block read, in Unix milliseconds.
        </li>
        <li>
          <C>historical_trades</C>: <C>type</C> is buy or sell (both when left out); <C>limit</C> counts the newest trades
          (default 200, at most 5,000; 0 means 5,000); <C>start_time</C> and <C>end_time</C> are Unix seconds. One request
          covers at most 24 hours: a longer range is cut to the 24 hours that end at end_time. <C>trade_id</C> is the block
          number times 1,000,000 plus the log index, and <C>trade_timestamp</C> is Unix seconds.
        </li>
        <li>
          Every answer carries <C>x-architex-network</C> and <C>x-architex-block</C>. When part of the chain could not be
          read, it also carries <C>x-architex-partial</C>, naming what is missing, and is cached for 15 seconds instead.
        </li>
        <li>Answers are cached at the CDN for the time in the table and served stale while they refresh, so the chain is read at most that often per region.</li>
      </ul>

      <H3>How prices and volumes are computed</H3>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          Trades come from events: a core pair&rsquo;s Swap, the launch router&rsquo;s PoolTrade and the launchpad&rsquo;s
          Trade. Their amounts are what the trader paid and received, with the fees inside the amount paid, as in a Uniswap
          V2 Swap. A buy takes the base token out of the market.
        </li>
        <li>base_volume and target_volume add those amounts up over the 24 hours before the block read.</li>
        <li>
          last_price is the market&rsquo;s price now, the target reserve over the base reserve (a curve&rsquo;s virtual
          reserves), fee excluded: where the latest trade left it.
        </li>
        <li>high and low are the highest and lowest price the market stood at over the 24 hours: before and after every trade, and now.</li>
        <li>
          bid and ask are the best prices a trade gets now, fees included: price &times; (1 - fee) and price / (1 - fee). A
          curve that has sold nothing has no bid.
        </li>
        <li>
          liquidity_in_usd values both reserves in USD. USDC is $1, EURC is priced by the USDC/EURC pool, and other tokens
          through their deepest pool with a priced token. A curve counts the USDC it has raised plus the tokens it has left
          at its price now, not its virtual reserves.
        </li>
        <li>
          For &plusmn;2% depth, use the Uniswap V2 formula on the reserves with the market&rsquo;s fee: 0.30% of the amount
          paid in for core pools, 0.5% plus the creator fee on the USDC side for launch markets. The order book above is
          that formula, level by level.
        </li>
      </ul>

      <H3>Token list</H3>
      <Rows
        rows={[
          ['URL', <C>{SITE}/tokenlist.json</C>],
          ['Tokens', 'USDC and EURC, then every launch token, oldest first, tagged launch and either curve or graduated'],
          ['Extensions', 'launchpad, pool (its launch pair), creatorFeeBps, graduated'],
          ['Logos', 'A launch token’s image, from our verified gateway, when its details file names one'],
          ['Left out', 'Launch tokens whose on-chain name or symbol uses characters the schema refuses (one such entry makes consumers reject the whole list), and launches that take USDC’s or EURC’s name or symbol'],
          ['Version', 'minor counts the launch tokens listed, patch the logos found'],
        ]}
      />

      <H3>Indexing it yourself</H3>
      <ul className="list-disc space-y-2 pl-5">
        <li>Core pools: any Uniswap V2 indexer, given the core factory&rsquo;s address and the init code hash above.</li>
        <li>
          Launches: TokenCreated for each new token, Trade for curve trades, Graduated for the move to the pool and
          PoolTrade for pool trades. <C>launchpad.tokensLength()</C> and <C>curvesPage(start, count)</C> list every launch.
        </li>
        <li>On the public RPC, read logs in windows of 10,000 blocks or fewer, a few calls at a time, and retry what is rate limited.</li>
      </ul>
    </div>
  )
}
