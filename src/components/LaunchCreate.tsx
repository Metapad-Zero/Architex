import { useMemo, useState, type FormEvent } from 'react'
import type { Address } from 'viem'
import { useAccount, useSwitchChain } from 'wagmi'
import { activeChain } from '../chain'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { useCreateToken } from '../hooks/useCreateToken'
import { useLaunch } from '../hooks/useLaunch'
import { useSettings } from '../hooks/useSettings'
import { formatAmount, parseAmount } from '../lib/format'
import { METADATA_MAX_BYTES, NAME_MAX_BYTES, SYMBOL_MAX_BYTES, parseHttpsUrl, utf8ByteLength } from '../lib/launch'
import { PrimaryButton } from './PrimaryButton'
import { TxStatus } from './TxStatus'

interface LaunchCreateProps {
  onCreated: (token: Address) => void
}

const GHOST = '—'

export function LaunchCreate({ onCreated }: LaunchCreateProps) {
  const { address } = useAccount()
  const { open } = useConnectSheet()
  const { switchChainAsync } = useSwitchChain()
  const settings = useSettings()
  const { usdc, usdcBalance, usdcAllowance, refetch } = useLaunch(undefined)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [firstBuy, setFirstBuy] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const nameBytes = utf8ByteLength(name.trim())
  const symbolBytes = utf8ByteLength(symbol.trim())
  const imageBytes = utf8ByteLength(imageUrl.trim())
  const nameError = name.trim() === '' || nameBytes < 1 || nameBytes > NAME_MAX_BYTES
    ? 'Name must be 1 to 32 bytes.'
    : undefined
  const symbolError = symbol.trim() === '' || symbolBytes < 1 || symbolBytes > SYMBOL_MAX_BYTES
    ? 'Symbol must be 1 to 10 bytes.'
    : undefined
  const imageError = imageUrl.trim()
    ? imageBytes > METADATA_MAX_BYTES
      ? 'Image URL must be 256 bytes or fewer.'
      : parseHttpsUrl(imageUrl) ? undefined : 'Image URL must be https.'
    : undefined

  const initialBuyUsdc = useMemo(() => {
    try {
      return firstBuy ? parseAmount(firstBuy, usdc.decimals) : 0n
    } catch {
      return 0n
    }
  }, [firstBuy, usdc.decimals])

  const valid = !nameError && !symbolError && !imageError

  const create = useCreateToken({
    name: name.trim(),
    symbol: symbol.trim(),
    metadataURI: imageUrl.trim(),
    valid,
    initialBuyUsdc,
    slippageBps: settings.slippageBps,
    usdcBalance,
    usdcAllowance,
    usdcDecimals: usdc.decimals,
    onCreated: (token) => {
      void refetch()
      onCreated(token)
    },
  })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (create.buttonState === 'disconnected') {
      open()
      return
    }
    if (create.buttonState === 'wrongChain') {
      await switchChainAsync({ chainId: activeChain.id })
      return
    }
    if (!valid) return
    await create.execute()
  }

  const receive = create.firstBuy ? `${formatAmount(create.firstBuy.tokensOut, 18)} ${symbol.trim() || 'TOKEN'}` : GHOST
  const total = `${formatAmount(create.totalUsdc, usdc.decimals)} USDC`

  return (
    <div className="pools-page">
      <div className="mb-10 max-w-xl">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Create a token</h1>
        <p className="mt-2 text-sm text-g500">
          Name and symbol are on-chain forever. The optional first buy happens in the same transaction, so nobody can buy before you.
        </p>
      </div>

      <form className="launch-create" onSubmit={(event) => void submit(event)}>
        {create.isLoading && <span className="rule-sweep" aria-hidden="true" />}
        <div className="space-y-6">
          <div>
            <label className="block text-sm text-g500" htmlFor="launch-name">Name</label>
            <div className="field-with-suffix mt-1">
              <input
                id="launch-name"
                name="name"
                required
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={submitted && Boolean(nameError)}
                aria-describedby={submitted && nameError ? 'launch-name-error' : undefined}
              />
              <span>{nameBytes}/{NAME_MAX_BYTES}</span>
            </div>
            {submitted && nameError && <p id="launch-name-error" className="mt-2 text-sm text-loss" role="alert">{nameError}</p>}
          </div>

          <div>
            <label className="block text-sm text-g500" htmlFor="launch-symbol">Symbol</label>
            <div className="field-with-suffix mt-1">
              <input
                id="launch-symbol"
                name="symbol"
                required
                autoComplete="off"
                value={symbol}
                onChange={(event) => setSymbol(event.target.value.toUpperCase())}
                aria-invalid={submitted && Boolean(symbolError)}
                aria-describedby={submitted && symbolError ? 'launch-symbol-error' : undefined}
              />
              <span>{symbolBytes}/{SYMBOL_MAX_BYTES}</span>
            </div>
            {submitted && symbolError && <p id="launch-symbol-error" className="mt-2 text-sm text-loss" role="alert">{symbolError}</p>}
          </div>

          <div>
            <label className="block text-sm text-g500" htmlFor="launch-image">Image URL</label>
            <div className="field-with-suffix mt-1">
              <input
                id="launch-image"
                name="image"
                type="url"
                inputMode="url"
                autoComplete="off"
                placeholder="https://"
                value={imageUrl}
                onChange={(event) => setImageUrl(event.target.value)}
                aria-invalid={submitted && Boolean(imageError)}
                aria-describedby={submitted && imageError ? 'launch-image-error' : 'launch-image-hint'}
              />
            </div>
            <p id="launch-image-hint" className="mt-2 text-xs leading-5 text-g500">Optional. Only https URLs are shown as images.</p>
            {submitted && imageError && <p id="launch-image-error" className="mt-2 text-sm text-loss" role="alert">{imageError}</p>}
          </div>

          <div>
            <label className="block text-sm text-g500" htmlFor="launch-first-buy">Your first buy</label>
            <div className="field-with-suffix mt-1">
              <input
                id="launch-first-buy"
                name="firstBuy"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={firstBuy}
                onChange={(event) => {
                  const next = event.target.value.replace(/,/g, '')
                  if (next === '' || /^\d*(?:\.\d*)?$/.test(next)) setFirstBuy(next)
                }}
              />
              <span>USDC</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-g500">
              Optional. This buy happens in the same transaction as the create, so nobody can buy before you.
            </p>
            {address && (
              <p className="mt-1 text-sm text-g500">Balance {formatAmount(usdcBalance, usdc.decimals)}</p>
            )}
          </div>
        </div>

        <dl className="receipt-lines mt-8">
          <div><dt>Launch fee</dt><dd>{create.launchFee > 0n ? `${create.formatFee} USDC` : GHOST}</dd></div>
          <div><dt>You receive</dt><dd className={create.firstBuy ? '' : 'text-g500'}>{receive}</dd></div>
          <div><dt>Total</dt><dd>{total}</dd></div>
        </dl>

        <PrimaryButton
          type="submit"
          className="mt-6 w-full"
          loading={create.isLoading}
          disabled={create.isDisabled}
        >
          {create.label}
        </PrimaryButton>
        {create.hint && <p className="hint-line" role="status">{create.hint}</p>}
        <TxStatus status={create.txStatus} />
      </form>
    </div>
  )
}
