import { useId, useMemo, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { activeChain } from '../chain'
import { liquidityMinted, liquidityShareBps, pairFor, quote as ratioQuote, reservesFor, type AmmPair } from '../lib/amm'
import { formatAmount, formatLp, formatPct, parseAmount } from '../lib/format'
import { spendableBalance } from '../lib/gasReserve'
import type { PoolHold } from '../lib/pairList'
import type { Token } from '../lib/tokens'
import { useLiquidity } from '../hooks/useLiquidity'
import { useSettings } from '../hooks/useSettings'
import { AmountField } from './AmountField'
import { PrimaryButton } from './PrimaryButton'
import { TxStatus } from './TxStatus'
import { useSwitchToArc } from '../hooks/useSwitchToArc'

interface AddLiquidityFormProps {
  pair?: AmmPair
  /** For the standalone create form: lets it notice that the chosen tokens already have a pool. */
  pairs?: readonly AmmPair[]
  /** For the standalone create form: tokens whose USDC pool exists but is held back (see usePairs). */
  heldBack?: ReadonlyMap<string, PoolHold>
  tokens: readonly Token[]
  balances: ReadonlyMap<string, bigint>
  allowances: ReadonlyMap<string, bigint>
  tokenA?: Token
  tokenB?: Token
  onConfirmed: () => void | Promise<void>
}

const isUsdc = (address: string) => address.toLowerCase() === activeChain.usdc.toLowerCase()

function editable(value: bigint, decimals: number): string {
  const result = formatUnits(value, decimals)
  return result.includes('.') ? result.replace(/0+$/, '').replace(/\.$/, '') : result
}

export function AddLiquidityForm({ pair: fixedPair, pairs, heldBack, tokens, balances, allowances, tokenA: fixedA, tokenB: fixedB, onConfirmed }: AddLiquidityFormProps) {
  const { address: account, chainId } = useAccount()
  const { open } = useConnectSheet()
  const switchToArc = useSwitchToArc()
  const settings = useSettings()
  const liquidity = useLiquidity(onConfirmed)
  const formId = useId()
  const [tokenAAddress, setTokenAAddress] = useState<Address | undefined>(fixedA?.address)
  const [tokenBAddress, setTokenBAddress] = useState<Address | undefined>(fixedB?.address)
  const [amountA, setAmountA] = useState('')
  const [amountB, setAmountB] = useState('')

  const tokenA = fixedA ?? tokens.find((token) => token.address === tokenAAddress) ?? tokens[0]
  const tokenB = fixedB
    ?? tokens.find((token) => token.address === tokenBAddress && token.address !== tokenA?.address)
    ?? tokens.find((token) => token.address !== tokenA?.address)
  const parsedA = useMemo(() => {
    try { return tokenA ? parseAmount(amountA, tokenA.decimals) : 0n } catch { return 0n }
  }, [amountA, tokenA])
  const parsedB = useMemo(() => {
    try { return tokenB ? parseAmount(amountB, tokenB.decimals) : 0n } catch { return 0n }
  }, [amountB, tokenB])
  const found = fixedPair ?? (pairs && tokenA && tokenB ? pairFor(pairs, tokenA.address, tokenB.address) : undefined)
  // A launch token's USDC pool already exists but takes no deposits until graduation, so it cannot be created here.
  const heldToken = !found && tokenA && tokenB
    ? isUsdc(tokenA.address) ? tokenB : isUsdc(tokenB.address) ? tokenA : undefined
    : undefined
  const hold = heldToken ? heldBack?.get(heldToken.address.toLowerCase()) : undefined
  // A pair anyone created without depositing has no price yet: treat it like a new pool, not an existing one.
  const pair = found && found.reserve0 > 0n && found.reserve1 > 0n ? found : undefined
  const expectedLp = pair ? liquidityMinted(parsedA, parsedB, ...reservesFor(pair, tokenA?.address ?? pair.token0), pair.totalSupply) : liquidityMinted(parsedA, parsedB, 0n, 0n, 0n)
  const shareBps = liquidityShareBps(expectedLp, pair?.totalSupply ?? 0n)
  const allowanceA = tokenA ? allowances.get(tokenA.address.toLowerCase()) ?? 0n : 0n
  const allowanceB = tokenB ? allowances.get(tokenB.address.toLowerCase()) ?? 0n : 0n
  const spendableA = tokenA ? spendableBalance(tokenA.address, balances.get(tokenA.address.toLowerCase()) ?? 0n) : 0n
  const spendableB = tokenB ? spendableBalance(tokenB.address, balances.get(tokenB.address.toLowerCase()) ?? 0n) : 0n
  const shortA = parsedA > spendableA
  const shortB = parsedB > spendableB
  // Scaled by 1e18 so a token worth less than one raw unit of the other still shows its price.
  const initialPrice = !pair && !hold && tokenA && tokenB && parsedA > 0n && parsedB > 0n
    ? `1 ${tokenA.symbol} = ${formatAmount((parsedB * 10n ** BigInt(tokenA.decimals + 18)) / parsedA, tokenB.decimals + 18)} ${tokenB.symbol}`
    : undefined

  const updateA = (value: string) => {
    setAmountA(value)
    if (!pair || !tokenA || !tokenB) return
    try {
      const rawA = parseAmount(value, tokenA.decimals)
      const [reserveA, reserveB] = reservesFor(pair, tokenA.address)
      setAmountB(editable(ratioQuote(rawA, reserveA, reserveB), tokenB.decimals))
    } catch {
      setAmountB('')
    }
  }
  const updateB = (value: string) => {
    setAmountB(value)
    if (!pair || !tokenA || !tokenB) return
    try {
      const rawB = parseAmount(value, tokenB.decimals)
      const [reserveB, reserveA] = reservesFor(pair, tokenB.address)
      setAmountA(editable(ratioQuote(rawB, reserveB, reserveA), tokenA.decimals))
    } catch {
      setAmountA('')
    }
  }

  const pending = liquidity.status?.kind === 'pending'
  const label = !account
    ? 'Connect wallet'
    : chainId !== activeChain.id
      ? activeChain.isTestnet ? 'Switch to Arc Testnet' : 'Switch to Arc'
      : hold
        ? hold === 'launch' ? 'Opens at graduation' : 'Checking pool…'
      : parsedA === 0n || parsedB === 0n
        ? 'Enter amounts'
        : shortA || shortB
          ? `Not enough ${(shortA ? tokenA : tokenB)?.symbol ?? 'balance'}`
          : allowanceA < parsedA
          ? `Approve ${tokenA?.symbol ?? 'token'}`
          : allowanceB < parsedB
            ? `Approve ${tokenB?.symbol ?? 'token'}`
            : pair ? 'Add liquidity' : 'Create a pool'

  const submit = async () => {
    if (!account) return open()
    if (chainId !== activeChain.id) return void switchToArc()
    if (hold) return
    if (!tokenA || !tokenB || parsedA === 0n || parsedB === 0n || shortA || shortB) return
    if (allowanceA < parsedA) return void liquidity.approve(tokenA.address, parsedA, tokenA.symbol)
    if (allowanceB < parsedB) return void liquidity.approve(tokenB.address, parsedB, tokenB.symbol)
    await liquidity.addLiquidity({
      tokenA: tokenA.address,
      tokenB: tokenB.address,
      amountA: parsedA,
      amountB: parsedB,
      creatingPool: !pair,
      slippageBps: settings.slippageBps,
      deadlineMinutes: settings.deadlineMinutes,
    })
    setAmountA('')
    setAmountB('')
  }

  return (
    <div className="inline-form">
      {pending && <span className="rule-sweep" aria-hidden="true" />}
      {hold === 'launch' && heldToken ? (
        <p className="mb-6 text-sm leading-6 text-g700">{heldToken.symbol} is still on its launch curve. Its USDC pool opens at graduation, when the curve sells out — until then, <a className="underline" href={`#launch/${heldToken.address}`}>trade it on the launch page</a>.</p>
      ) : !pair && !hold && <p className="mb-6 text-sm leading-6 text-g700">You are creating this pool — the ratio you enter sets the initial price. Match the market rate: if it's off, arbitrageurs trade the difference out of your deposit.</p>}
      <div className="grid gap-8 sm:grid-cols-2">
        <AmountField
          id={`liquidity-a${formId}`}
          label="Amount"
          amount={amountA}
          onAmount={updateA}
          token={tokenA}
          tokens={tokens.filter((token) => token.address !== tokenB?.address)}
          onToken={(token) => setTokenAAddress(token.address)}
          balances={balances}
          disableTokenSelect={Boolean(fixedA)}
        />
        <AmountField
          id={`liquidity-b${formId}`}
          label="Amount"
          amount={amountB}
          onAmount={updateB}
          token={tokenB}
          tokens={tokens.filter((token) => token.address !== tokenA?.address)}
          onToken={(token) => setTokenBAddress(token.address)}
          balances={balances}
          disableTokenSelect={Boolean(fixedB)}
        />
      </div>
      <dl className="receipt-lines mt-6">
        {initialPrice && <div><dt>Initial price</dt><dd>{initialPrice}</dd></div>}
        {!hold && <div><dt>Expected LP</dt><dd>{formatLp(expectedLp)}</dd></div>}
        {!hold && <div><dt>Your share</dt><dd>{formatPct(shareBps)}</dd></div>}
      </dl>
      <PrimaryButton className="mt-6 w-full sm:w-auto sm:min-w-56" loading={pending} disabled={pending || (Boolean(account) && chainId === activeChain.id && (Boolean(hold) || parsedA === 0n || parsedB === 0n || shortA || shortB))} onClick={() => void submit()}>{pending ? liquidity.status?.label : label}</PrimaryButton>
      <TxStatus status={liquidity.status} />
    </div>
  )
}
