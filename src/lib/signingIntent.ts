import { decodeAbiParameters, decodeFunctionData, hexToString, isHex, maxUint256, parseAbi, zeroAddress, type Address, type Hex, type TypedDataDefinition } from 'viem'
import { listedPluginAt } from '../content/plugins/registry'
import { buybackPluginAbi, factoryAbi, launchRouterAbi, launchTokenAbi, launchpadAbi, routerAbi, splitPluginAbi, testTokenAbi } from './abi'
import { bytes32ToAddress, domainLabel, isMessenger, isTransmitter } from './cctp'
import { deployment, launchSuite, type LaunchSuite } from './deployment'
import { formatAmount, formatPct, shortAddress } from './format'
import { holderPluginAbi } from './plugins/holders'
import { rememberedToken, type Token } from './tokens'
import type { SigningRequest } from './unlock'

export interface TxRequest {
  from?: Hex
  to?: Hex
  data?: Hex
  value?: Hex
  gas?: Hex
}

export interface IntentLine {
  label: string
  value: string
}

/** What the confirm sheet says about a request: the action as its heading, then receipt lines. */
export interface SigningIntent {
  title: string
  lines: IntentLine[]
  note?: string
}

const NATIVE_DECIMALS = 18

function same(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase()
}

function tokenFor(address: string, tokens: readonly Token[]): Token | undefined {
  return tokens.find((token) => same(token.address, address))
    ?? deployment.tokens.find((token) => same(token.address, address))
    ?? rememberedToken(address)
}

function amount(value: bigint, address: string, tokens: readonly Token[]): string {
  const token = tokenFor(address, tokens)
  if (!token) return `${value.toString()} units of ${shortAddress(address)}`
  return `${formatAmount(value, token.decimals)} ${token.symbol}`
}

function symbol(address: string, tokens: readonly Token[]): string {
  return tokenFor(address, tokens)?.symbol ?? shortAddress(address)
}

function contractName(address: string | undefined, tokens: readonly Token[], suite: LaunchSuite = launchSuite): string {
  if (!address) return 'Contract creation'
  if (same(address, deployment.router)) return 'Architex router'
  if (same(address, deployment.factory)) return 'Architex factory'
  if (isMessenger(address)) return 'USDC bridge'
  if (isTransmitter(address)) return 'USDC bridge mint'
  if (suite.launchpad !== zeroAddress && same(address, suite.launchpad)) return 'Architex launchpad'
  if (suite.launchRouter !== zeroAddress && same(address, suite.launchRouter)) return 'Architex launch router'
  const listed = listedPluginAt(address, suite)
  if (listed) return `${listed.name} plugin`
  if (deployment.pairs.some((pair) => same(pair.pair, address))) return 'Architex pool'
  const token = tokenFor(address, tokens)
  return token ? `${token.symbol} token` : shortAddress(address)
}

/** "Split", "Your wallet", "Custom address 0x12…ab": where a createToken sends the creator fees, from the signer's view. */
function destination(plugin: Address, from: string | undefined, suite: LaunchSuite): string {
  const listed = listedPluginAt(plugin, suite)
  if (listed) return listed.name
  if (same(plugin, from)) return 'Your wallet'
  return `Custom address ${shortAddress(plugin)}`
}

function decodeParams<const T extends readonly { type: string }[]>(types: T, data: Hex) {
  try {
    return decodeAbiParameters(types, data)
  } catch {
    return undefined
  }
}

function shareLines(addresses: readonly Address[], weights: readonly bigint[], label: (address: Address) => string): IntentLine[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0n)
  return addresses.map((address, index) => ({
    label: label(address),
    value: total > 0n ? formatPct(((weights[index] ?? 0n) * 10_000n) / total) : '—',
  }))
}

/** What the plugin data of a createToken sets up, as receipt lines: a Split's payees, a Combo's destinations. */
function pluginDataLines(plugin: Address, data: Hex, suite: LaunchSuite): IntentLine[] {
  const listed = listedPluginAt(plugin, suite)
  if (data === '0x') return []
  if (listed?.kind === 'split') {
    const split = decodeParams([{ type: 'address[]' }, { type: 'uint256[]' }], data)
    if (split) return shareLines(split[0], split[1], (payee) => `Payee ${shortAddress(payee)}`)
  }
  if (listed?.kind === 'combo') {
    const combo = decodeParams([{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes[]' }], data)
    if (combo) {
      const [targets, bps, datas] = combo
      return targets.map((target, index) => {
        const entry = listedPluginAt(target, suite)
        const payees = entry?.kind === 'split' ? decodeParams([{ type: 'address[]' }, { type: 'uint256[]' }], datas[index] ?? '0x')?.[0].length : undefined
        const name = entry ? `${entry.name}${payees ? ` · ${payees} ${payees === 1 ? 'payee' : 'payees'}` : ''}` : `Wallet ${shortAddress(target)}`
        return { label: name, value: formatPct(bps[index] ?? 0) }
      })
    }
  }
  return [{ label: 'Plugin settings', value: `${(data.length - 2) / 2} bytes` }]
}

function until(deadline: bigint): string {
  const seconds = Number(deadline)
  if (!Number.isFinite(seconds) || seconds > 4_102_444_800) return 'No deadline'
  return new Date(seconds * 1_000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function allowance(value: bigint, address: string, tokens: readonly Token[]): string {
  return value === maxUint256 ? 'Unlimited' : amount(value, address, tokens)
}

function asBigint(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' || (typeof value === 'string' && value !== '')) {
    try {
      return BigInt(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

function decode<const abi extends readonly unknown[]>(abi: abi, data: Hex) {
  try {
    return decodeFunctionData({ abi, data })
  } catch {
    return undefined
  }
}

const usdcAddress = () => deployment.tokens[0]?.address ?? ''

export function describeLaunchpadCall(data: Hex, from: string | undefined, tokens: readonly Token[], suite: LaunchSuite = launchSuite): SigningIntent | undefined {
  const call = decode(launchpadAbi, data)
  if (!call) return undefined
  const args = call.args as readonly unknown[]
  const usdc = usdcAddress()
  switch (call.functionName) {
    case 'createToken': {
      const [name, tokenSymbol, , creatorFeeBps, plugin, pluginData, initialBuyUsdc, , maxLaunchFee] = args as [
        string,
        string,
        string,
        number,
        Address,
        Hex,
        bigint,
        bigint,
        bigint,
      ]
      return {
        title: 'Create token',
        lines: [
          { label: 'Name', value: name || '—' },
          { label: 'Symbol', value: tokenSymbol || '—' },
          { label: 'Creator fee', value: `${formatPct(creatorFeeBps)} of every trade` },
          { label: 'Fees go to', value: destination(plugin, from, suite) },
          ...pluginDataLines(plugin, pluginData, suite),
          { label: 'First buy', value: initialBuyUsdc > 0n ? amount(initialBuyUsdc, usdc, tokens) : 'None' },
          { label: 'Launch fee', value: `Up to ${amount(maxLaunchFee, usdc, tokens)}` },
        ],
        note: 'The creator fee and where it goes are locked for good once the token exists.',
      }
    }
    case 'buy': {
      const [token, usdcIn, minTokensOut, to, deadline] = args as [Address, bigint, bigint, Address, bigint]
      const lines = [
        { label: 'You pay at most', value: amount(usdcIn, usdc, tokens) },
        { label: 'You receive at least', value: amount(minTokensOut, token, tokens) },
      ]
      if (!same(to, from)) lines.push({ label: 'Sent to', value: shortAddress(to) })
      lines.push({ label: 'Valid until', value: until(deadline) })
      return { title: `Buy ${symbol(token, tokens)}`, lines }
    }
    case 'sell': {
      const [token, tokensIn, minUsdcOut, to, deadline] = args as [Address, bigint, bigint, Address, bigint]
      const lines = [
        { label: 'You sell', value: amount(tokensIn, token, tokens) },
        { label: 'You receive at least', value: amount(minUsdcOut, usdc, tokens) },
      ]
      if (!same(to, from)) lines.push({ label: 'Sent to', value: shortAddress(to) })
      lines.push({ label: 'Valid until', value: until(deadline) })
      return { title: `Sell ${symbol(token, tokens)}`, lines }
    }
    case 'collectCreatorFees': {
      const [token] = args as [Address]
      return {
        title: 'Collect creator fees',
        lines: [{ label: 'Token', value: symbol(token, tokens) }],
        note: 'Sends the token’s accrued creator fees to its plugin. Nothing comes to you.',
      }
    }
    case 'collectFees':
      return { title: 'Collect platform fees', lines: [{ label: 'To', value: 'The launchpad’s fee address' }] }
    default:
      return undefined
  }
}

/** Launch-pool trades, through the launch router. */
export function describeLaunchRouterCall(data: Hex, from: string | undefined, tokens: readonly Token[]): SigningIntent | undefined {
  const call = decode(launchRouterAbi, data)
  if (!call) return undefined
  const usdc = usdcAddress()
  if (call.functionName === 'buy' || call.functionName === 'sell') {
    const [token, amountIn, minOut, to, deadline] = call.args
    const buy = call.functionName === 'buy'
    const lines: IntentLine[] = buy
      ? [
          { label: 'You pay', value: amount(amountIn, usdc, tokens) },
          { label: 'You receive at least', value: amount(minOut, token, tokens) },
        ]
      : [
          { label: 'You sell', value: amount(amountIn, token, tokens) },
          { label: 'You receive at least', value: amount(minOut, usdc, tokens) },
        ]
    if (!same(to, from)) lines.push({ label: 'Sent to', value: shortAddress(to) })
    lines.push({ label: 'Valid until', value: until(deadline) })
    return { title: `${buy ? 'Buy' : 'Sell'} ${symbol(token, tokens)}`, lines }
  }
  return undefined
}

/** The reference plugins' public actions: release a Split payee, run a buyback, drip or claim holders' USDC. */
export function describePluginCall(to: Address, data: Hex, from: string | undefined, tokens: readonly Token[], suite: LaunchSuite = launchSuite): SigningIntent | undefined {
  const listed = listedPluginAt(to, suite)
  if (listed?.kind === 'split') {
    const call = decode(splitPluginAbi, data)
    if (call?.functionName === 'release') {
      const [token, payee] = call.args
      return {
        title: 'Release creator fees',
        lines: [
          { label: 'Token', value: symbol(token, tokens) },
          { label: 'Paid to', value: same(payee, from) ? 'You' : shortAddress(payee) },
        ],
      }
    }
  }
  if (listed?.kind === 'buyback') {
    const call = decode(buybackPluginAbi, data)
    if (call?.functionName === 'run') {
      const [token] = call.args
      return {
        title: `Run ${symbol(token, tokens)} buyback`,
        lines: [{ label: 'Token', value: symbol(token, tokens) }],
        note: 'Buys the token with its waiting creator fees, within a budget of 0.25% of the USDC side per hour, and burns what it buys.',
      }
    }
  }
  if (listed?.kind === 'holders') {
    const call = decode(holderPluginAbi, data)
    if (call?.functionName === 'dripAndClaim') {
      const [token] = call.args
      return {
        title: `Claim ${symbol(token, tokens)} USDC`,
        lines: [
          { label: 'Token', value: symbol(token, tokens) },
          { label: 'Paid to', value: 'You' },
        ],
        note: 'Releases what is due to every holder, then pays you your share.',
      }
    }
    if (call?.functionName === 'drip') {
      const [token] = call.args
      return { title: 'Drip to holders', lines: [{ label: 'Token', value: symbol(token, tokens) }] }
    }
  }
  return undefined
}

/** A launch token's own dividend and burn calls. */
function describeLaunchTokenCall(to: Address, data: Hex, tokens: readonly Token[]): SigningIntent | undefined {
  const call = decode(launchTokenAbi, data)
  if (!call) return undefined
  switch (call.functionName) {
    case 'claim':
      return { title: `Claim ${symbol(to, tokens)} USDC`, lines: [{ label: 'Paid to', value: 'You' }] }
    case 'claimFor': {
      const [holder] = call.args
      return { title: `Claim ${symbol(to, tokens)} USDC`, lines: [{ label: 'Paid to', value: shortAddress(holder) }] }
    }
    case 'burn': {
      const [burned] = call.args
      return { title: `Burn ${symbol(to, tokens)}`, lines: [{ label: 'Amount', value: amount(burned, to, tokens) }], note: 'Burned tokens are gone for good.' }
    }
    default:
      return undefined
  }
}

function describeTransaction(tx: TxRequest, tokens: readonly Token[]): SigningIntent {
  const value = tx.value ? BigInt(tx.value) : 0n
  const data = tx.data && tx.data !== '0x' ? tx.data : undefined

  if (data && same(tx.to, deployment.router)) {
    const call = decode(routerAbi, data)
    if (call) {
      const args = call.args as readonly unknown[]
      switch (call.functionName) {
        case 'swapExactTokensForTokens': {
          const [amountIn, amountOutMin, path, to, deadline] = args as [bigint, bigint, readonly Address[], Address, bigint]
          const lines = [
            { label: 'You pay', value: amount(amountIn, path[0], tokens) },
            { label: 'You receive at least', value: amount(amountOutMin, path[path.length - 1], tokens) },
          ]
          if (!same(to, tx.from)) lines.push({ label: 'Sent to', value: shortAddress(to) })
          lines.push({ label: 'Valid until', value: until(deadline) })
          return { title: 'Swap', lines }
        }
        case 'swapTokensForExactTokens': {
          const [amountOut, amountInMax, path, to, deadline] = args as [bigint, bigint, readonly Address[], Address, bigint]
          const lines = [
            { label: 'You receive', value: amount(amountOut, path[path.length - 1], tokens) },
            { label: 'You pay at most', value: amount(amountInMax, path[0], tokens) },
          ]
          if (!same(to, tx.from)) lines.push({ label: 'Sent to', value: shortAddress(to) })
          lines.push({ label: 'Valid until', value: until(deadline) })
          return { title: 'Swap', lines }
        }
        case 'addLiquidity': {
          const [tokenA, tokenB, aDesired, bDesired, aMin, bMin, , deadline] = args as [Address, Address, bigint, bigint, bigint, bigint, Address, bigint]
          return {
            title: 'Add liquidity',
            lines: [
              { label: 'Pool', value: `${symbol(tokenA, tokens)} / ${symbol(tokenB, tokens)}` },
              { label: 'Deposit up to', value: amount(aDesired, tokenA, tokens) },
              { label: 'And up to', value: amount(bDesired, tokenB, tokens) },
              { label: 'At least', value: `${amount(aMin, tokenA, tokens)} + ${amount(bMin, tokenB, tokens)}` },
              { label: 'Valid until', value: until(deadline) },
            ],
          }
        }
        case 'removeLiquidity':
        case 'removeLiquidityWithPermit': {
          const [tokenA, tokenB, liquidity, aMin, bMin, , deadline] = args as [Address, Address, bigint, bigint, bigint, Address, bigint]
          return {
            title: 'Remove liquidity',
            lines: [
              { label: 'Pool', value: `${symbol(tokenA, tokens)} / ${symbol(tokenB, tokens)}` },
              { label: 'LP tokens', value: `${formatAmount(liquidity, 18)} ATX-LP` },
              { label: 'You receive at least', value: `${amount(aMin, tokenA, tokens)} + ${amount(bMin, tokenB, tokens)}` },
              { label: 'Valid until', value: until(deadline) },
            ],
          }
        }
      }
    }
  }

  if (data && launchSuite.launchpad !== zeroAddress && same(tx.to, launchSuite.launchpad)) {
    const intent = describeLaunchpadCall(data, tx.from, tokens)
    if (intent) return intent
  }

  if (data && launchSuite.launchRouter !== zeroAddress && same(tx.to, launchSuite.launchRouter)) {
    const intent = describeLaunchRouterCall(data, tx.from, tokens)
    if (intent) return intent
  }

  if (data && tx.to && listedPluginAt(tx.to)) {
    const intent = describePluginCall(tx.to, data, tx.from, tokens)
    if (intent) return intent
  }

  if (data && tx.to && rememberedToken(tx.to)?.isLaunch) {
    const intent = describeLaunchTokenCall(tx.to, data, tokens)
    if (intent) return intent
  }

  if (data && same(tx.to, deployment.factory)) {
    const call = decode(factoryAbi, data)
    if (call?.functionName === 'createPair') {
      const [tokenA, tokenB] = call.args
      return { title: 'Create a pool', lines: [{ label: 'Pool', value: `${symbol(tokenA, tokens)} / ${symbol(tokenB, tokens)}` }] }
    }
  }

  if (data && tx.to) {
    const call = decode(testTokenAbi, data)
    if (call?.functionName === 'approve') {
      const [spender, allowed] = call.args
      return {
        title: `Approve ${symbol(tx.to, tokens)}`,
        lines: [
          { label: 'Spender', value: contractName(spender, tokens) },
          { label: 'Allowance', value: allowance(allowed, tx.to, tokens) },
        ],
      }
    }
    if (call?.functionName === 'faucet') {
      return { title: `Claim test ${symbol(tx.to, tokens)}`, lines: [{ label: 'From', value: `${symbol(tx.to, tokens)} faucet` }] }
    }
    if (call?.functionName === 'transfer') {
      const [to, sent] = call.args
      return { title: `Send ${symbol(tx.to, tokens)}`, lines: [{ label: 'Amount', value: amount(sent, tx.to, tokens) }, { label: 'To', value: shortAddress(to) }] }
    }
  }

  if (data && isMessenger(tx.to)) {
    const burnV2 = decode(parseAbi(['function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64)']), data)
    const burn = burnV2 ?? decode(parseAbi(['function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken) returns (uint64)']), data)
    if (burn?.functionName === 'depositForBurn') {
      const [paid, domain, recipient, token] = burn.args as [bigint, number, Hex, Address]
      return {
        title: 'Bridge USDC',
        lines: [
          { label: 'You send', value: amount(paid, token, tokens) },
          { label: 'To', value: domainLabel(Number(domain)) },
          { label: 'Recipient', value: shortAddress(bytes32ToAddress(recipient)) },
        ],
      }
    }
  }
  if (data && isTransmitter(tx.to)) {
    const receive = decode(parseAbi(['function receiveMessage(bytes message, bytes attestation) returns (bool)']), data)
    if (receive?.functionName === 'receiveMessage') {
      return { title: 'Claim bridged USDC', lines: [{ label: 'On', value: contractName(tx.to, tokens) }] }
    }
  }

  const lines: IntentLine[] = [{ label: 'To', value: contractName(tx.to, tokens) }]
  if (value > 0n) lines.push({ label: 'Value', value: `${formatAmount(value, NATIVE_DECIMALS)} USDC` })
  lines.push({ label: 'Data', value: data ? `${(data.length - 2) / 2} bytes` : 'None' })
  return { title: 'Send transaction', lines }
}

function describeTypedData(typed: TypedDataDefinition, tokens: readonly Token[]): SigningIntent {
  const domain = (typed.domain ?? {}) as { name?: string; verifyingContract?: Address }
  const message = (typed.message ?? {})
  if (typed.primaryType === 'Permit' && typeof message.spender === 'string') {
    const permitted = asBigint(message.value) ?? 0n
    const deadline = asBigint(message.deadline)
    const lines: IntentLine[] = [
      { label: 'Token', value: domain.name ?? (domain.verifyingContract ? contractName(domain.verifyingContract, tokens) : 'Unknown') },
      { label: 'Spender', value: contractName(message.spender, tokens) },
      { label: 'Allowance', value: permitted === maxUint256 ? 'Unlimited' : formatAmount(permitted, 18) },
    ]
    if (deadline !== undefined) lines.push({ label: 'Valid until', value: until(deadline) })
    return { title: 'Approve by signature', lines, note: 'Nothing moves yet: this signature lets the spender take up to the allowance in the next step.' }
  }
  return {
    title: 'Sign typed data',
    lines: [
      { label: 'Type', value: typed.primaryType },
      { label: 'Contract', value: domain.verifyingContract ? contractName(domain.verifyingContract, tokens) : 'None' },
    ],
  }
}

function describeMessage(message: Hex): SigningIntent {
  let text: string
  try {
    text = isHex(message) ? hexToString(message) : String(message)
  } catch {
    text = message
  }
  const printable = /^[\x20-\x7e\s]*$/.test(text) ? text : `${message.slice(0, 18)}…`
  return { title: 'Sign message', lines: [{ label: 'Message', value: printable.length > 120 ? `${printable.slice(0, 117)}…` : printable }] }
}

export function describeRequest(request: SigningRequest, tokens: readonly Token[]): SigningIntent {
  switch (request.kind) {
    case 'transaction':
      return describeTransaction(request.tx, tokens)
    case 'typedData':
      return describeTypedData(request.typed, tokens)
    case 'message':
      return describeMessage(request.message)
    case 'reveal':
      return { title: 'Back up private key', lines: [], note: 'The key is shown on this screen only. Anyone who sees it controls the wallet.' }
  }
}
