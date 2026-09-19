import { useMemo, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { useAccount, useChainId, useSwitchChain } from 'wagmi'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { activeChain } from '../chain'
import { liquidityMinted, liquidityShareBps, quote as ratioQuote, reservesFor, type AmmPair } from '../lib/amm'
import { formatAmount, formatPct, parseAmount } from '../lib/format'
import type { Token } from '../lib/tokens'
import { useLiquidity } from '../hooks/useLiquidity'
import { useSettings } from '../hooks/useSettings'
import { AmountField } from './AmountField'
import { PrimaryButton } from './PrimaryButton'
import { TxStatus } from './TxStatus'

interface AddLiquidityFormProps {
  pair?: AmmPair
  tokens: readonly Token[]
  balances: ReadonlyMap<string, bigint>
  allowances: ReadonlyMap<string, bigint>
  tokenA?: Token
  tokenB?: Token
  onConfirmed: () => void | Promise<void>
}

function editable(value: bigint, decimals: number): string {
  const result = formatUnits(value, decimals)
  return result.includes('.') ? result.replace(/0+$/, '').replace(/\.$/, '') : result
}

export function AddLiquidityForm({ pair, tokens, balances, allowances, tokenA: fixedA, tokenB: fixedB, onConfirmed }: AddLiquidityFormProps) {
  const { address: account } = useAccount()
  const chainId = useChainId()
  const { open } = useConnectSheet()
  const { switchChainAsync } = useSwitchChain()
  const settings = useSettings()
  const liquidity = useLiquidity(onConfirmed)
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
  const expectedLp = pair ? liquidityMinted(parsedA, parsedB, ...reservesFor(pair, tokenA?.address ?? pair.token0), pair.totalSupply) : liquidityMinted(parsedA, parsedB, 0n, 0n, 0n)
  const shareBps = liquidityShareBps(expectedLp, pair?.totalSupply ?? 0n)
  const allowanceA = tokenA ? allowances.get(tokenA.address.toLowerCase()) ?? 0n : 0n
  const allowanceB = tokenB ? allowances.get(tokenB.address.toLowerCase()) ?? 0n : 0n

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
      : parsedA === 0n || parsedB === 0n
        ? 'Enter amounts'
        : allowanceA < parsedA
          ? `Approve ${tokenA?.symbol ?? 'token'}`
          : allowanceB < parsedB
            ? `Approve ${tokenB?.symbol ?? 'token'}`
            : pair ? 'Add liquidity' : 'Create a pool'

  const submit = async () => {
    if (!account) return open()
    if (chainId !== activeChain.id) return void switchChainAsync({ chainId: activeChain.id })
    if (!tokenA || !tokenB || parsedA === 0n || parsedB === 0n) return
    if (allowanceA < parsedA) return void liquidity.approve(tokenA.address, parsedA, tokenA.symbol)
    if (allowanceB < parsedB) return void liquidity.approve(tokenB.address, parsedB, tokenB.symbol)
    await liquidity.addLiquidity({
      tokenA: tokenA.address,
      tokenB: tokenB.address,
      amountA: parsedA,
      amountB: parsedB,
      slippageBps: settings.slippageBps,
      deadlineMinutes: settings.deadlineMinutes,
    })
    setAmountA('')
    setAmountB('')
  }

  return (
    <div className="inline-form">
      {pending && <span className="rule-sweep" aria-hidden="true" />}
      {!pair && <p className="mb-6 text-sm leading-6 text-g700">You are creating this pool — the ratio you enter sets the initial price.</p>}
      <div className="grid gap-8 sm:grid-cols-2">
        <AmountField
          id={`liquidity-a-${pair?.pair ?? 'new'}`}
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
          id={`liquidity-b-${pair?.pair ?? 'new'}`}
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
        <div><dt>Expected LP</dt><dd>{formatAmount(expectedLp, 18)}</dd></div>
        <div><dt>Your share</dt><dd>{formatPct(shareBps)}</dd></div>
      </dl>
      <PrimaryButton className="mt-6 w-full sm:w-auto sm:min-w-56" loading={pending} disabled={pending || (Boolean(account) && chainId === activeChain.id && parsedA === 0n)} onClick={() => void submit()}>{pending ? liquidity.status?.label : label}</PrimaryButton>
      <TxStatus status={liquidity.status} />
    </div>
  )
}
