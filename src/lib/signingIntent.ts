import { decodeFunctionData, hexToString, isHex, maxUint256, type Address, type Hex, type TypedDataDefinition } from 'viem'
import { factoryAbi, routerAbi, testTokenAbi } from './abi'
import { deployment } from './deployment'
import { formatAmount, shortAddress } from './format'
import type { Token } from './tokens'
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
  return tokens.find((token) => same(token.address, address)) ?? deployment.tokens.find((token) => same(token.address, address))
}

function amount(value: bigint, address: string, tokens: readonly Token[]): string {
  const token = tokenFor(address, tokens)
  if (!token) return `${value.toString()} units of ${shortAddress(address)}`
  return `${formatAmount(value, token.decimals)} ${token.symbol}`
}

function symbol(address: string, tokens: readonly Token[]): string {
  return tokenFor(address, tokens)?.symbol ?? shortAddress(address)
}

function contractName(address: string | undefined, tokens: readonly Token[]): string {
  if (!address) return 'Contract creation'
  if (same(address, deployment.router)) return 'Architex router'
  if (same(address, deployment.factory)) return 'Architex factory'
  if (deployment.pairs.some((pair) => same(pair.pair, address))) return 'Architex pool'
  const token = tokenFor(address, tokens)
  return token ? `${token.symbol} token` : shortAddress(address)
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
