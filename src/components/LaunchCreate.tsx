import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { activeChain } from '../chain'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { useCreateToken } from '../hooks/useCreateToken'
import { useFeePluginProbe } from '../hooks/useFeePluginProbe'
import { useLaunch } from '../hooks/useLaunch'
import { useSettings } from '../hooks/useSettings'
import { parseOptionalAmount, sanitizeAmount } from '../lib/amountInput'
import { deployment, launchSuite } from '../lib/deployment'
import { formatAmount, formatPct } from '../lib/format'
import { metadataStatus } from '../lib/ipfs'
import { NAME_MAX_BYTES, SYMBOL_MAX_BYTES, utf8ByteLength } from '../lib/launch'
import { MAX_CREATOR_FEE_BPS, parsePercentBps, planFeePlugin, type FeePlan } from '../lib/plugins/plan'
import { prepareImage, type PreparedImage } from '../lib/prepareImage'
import { saveTokenDetails } from '../lib/saveDetails'
import { METADATA_LIMITS, hasMetadata, metadataErrors, type MetadataInput } from '../lib/tokenMetadata'
import { CreatorFeeField } from './CreatorFeeField'
import { FeeDestinationPicker, planAddresses, planSummary } from './FeeDestinationPicker'
import { FeeGauge } from './FeeGauge'
import { GhostButton } from './GhostButton'
import { PrimaryButton } from './PrimaryButton'
import { TxStatus } from './TxStatus'
import { useSwitchToArc } from '../hooks/useSwitchToArc'

interface LaunchCreateProps {
  onCreated: (token: Address) => void
}

const GHOST = '—'

export function LaunchCreate({ onCreated }: LaunchCreateProps) {
  const { address } = useAccount()
  const { open } = useConnectSheet()
  const switchToArc = useSwitchToArc()
  const settings = useSettings()
  const { usdc, usdcBalance, usdcAllowance, refetch } = useLaunch(undefined)
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [website, setWebsite] = useState('')
  const [x, setX] = useState('')
  const [telegram, setTelegram] = useState('')
  const [image, setImage] = useState<PreparedImage>()
  const [imageName, setImageName] = useState('')
  const [imageProblem, setImageProblem] = useState<string>()
  const [detailsEnabled, setDetailsEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveProblem, setSaveProblem] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  // The same details are not pinned twice when the wallet prompt is cancelled and the creator tries again.
  const saved = useRef<{ key: string; uri: string }>()

  useEffect(() => {
    let live = true
    void metadataStatus().then((status) => live && setDetailsEnabled(status.enabled))
    return () => {
      live = false
    }
  }, [])
  useEffect(() => () => {
    if (image) URL.revokeObjectURL(image.previewUrl)
  }, [image])
  const [firstBuy, setFirstBuy] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const nameBytes = utf8ByteLength(name.trim())
  const symbolBytes = utf8ByteLength(symbol.trim())
  const nameError = name.trim() === '' || nameBytes < 1 || nameBytes > NAME_MAX_BYTES
    ? 'Name must be 1 to 32 bytes.'
    : undefined
  const symbolError = symbol.trim() === '' || symbolBytes < 1 || symbolBytes > SYMBOL_MAX_BYTES
    ? 'Symbol must be 1 to 10 bytes.'
    : undefined
  const details: MetadataInput = { name: name.trim(), symbol: symbol.trim(), description, website, x, telegram }
  const detailErrors = detailsEnabled ? metadataErrors(details) : {}
  const wantsDetails = detailsEnabled && (Boolean(image) || hasMetadata(details))

  const firstBuyInput = useMemo(() => parseOptionalAmount(firstBuy, usdc.decimals), [firstBuy, usdc.decimals])
  const initialBuyUsdc = firstBuyInput.amount ?? 0n

  // Creator fee: starts at 0% [D4]. Where it goes: the creator's own wallet until they choose otherwise.
  const [feeText, setFeeText] = useState('0')
  const fee = parsePercentBps(feeText, MAX_CREATOR_FEE_BPS, 0)
  const creatorFeeBps = fee.bps ?? 0
  const [plan, setPlan] = useState<FeePlan>({ kind: 'wallet', address: '' })
  const probed = useFeePluginProbe(useMemo(() => planAddresses(plan), [plan]))
  const planned = useMemo(
    () =>
      planFeePlugin(plan, {
        creator: address,
        usdc: activeChain.usdc,
        suite: launchSuite,
        architexContracts: [deployment.factory, deployment.router, deployment.lens],
        pluginAddresses: probed,
      }),
    [address, plan, probed],
  )

  const valid =
    !nameError && !symbolError && !firstBuyInput.error && !fee.error && Object.keys(detailErrors).length === 0 && !imageProblem && Boolean(planned.plan)

  const create = useCreateToken({
    name: name.trim(),
    symbol: symbol.trim(),
    metadataURI: '',
    creatorFeeBps,
    pluginPlan: planned.plan,
    valid,
    initialBuyUsdc,
    slippageBps: settings.slippageBps,
    usdcBalance,
    usdcAllowance: usdcAllowance.launchpad,
    usdcDecimals: usdc.decimals,
    onApproved: refetch,
    onCreated: (token) => {
      void refetch()
      onCreated(token)
    },
  })
  const firstBuyError = firstBuyInput.error ?? (create.firstBuyInvalid ? 'That buy is too small: the fees would take all of it.' : undefined)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    if (create.buttonState === 'disconnected') {
      open()
      return
    }
    if (create.buttonState === 'wrongChain') {
      await switchToArc()
      return
    }
    if (!valid) return
    // Details are pinned at the last moment, on the press that creates the token, never on the approval press.
    if (create.buttonState !== 'ready' || !wantsDetails) {
      await create.execute()
      return
    }
    setSaveProblem(undefined)
    const key = JSON.stringify([details, image?.cid])
    let uri = saved.current?.key === key ? saved.current.uri : undefined
    if (!uri) {
      setSaving(true)
      try {
        uri = await saveTokenDetails(details, image)
        saved.current = { key, uri }
      } catch (error) {
        setSaveProblem(error instanceof Error ? error.message : 'The details could not be saved. Try again.')
        return
      } finally {
        setSaving(false)
      }
    }
    await create.execute(uri)
  }

  const pickImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setImageProblem(undefined)
    try {
      setImage(await prepareImage(file))
      setImageName(file.name)
    } catch (error) {
      setImage(undefined)
      setImageName('')
      setImageProblem(error instanceof Error ? error.message : 'That image could not be read. Try another file.')
    }
  }

  const receive = create.firstBuy ? `${formatAmount(create.firstBuy.tokensOut, 18)} ${symbol.trim() || 'TOKEN'}` : GHOST
  // Both fees on the creator's own first buy [D3], together: the platform's 0.5% and the creator fee.
  const buyFees = create.firstBuy ? `${formatAmount(create.firstBuy.platformFee + create.firstBuy.creatorFee, usdc.decimals)} USDC` : GHOST
  const total = create.feeKnown && !firstBuyError ? `${formatAmount(create.totalUsdc, usdc.decimals)} USDC` : GHOST

  return (
    <div className="pools-page">
      <div className="mb-10 max-w-xl">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Create a token</h1>
        <p className="mt-2 text-sm text-g500">
          Name, symbol, creator fee and where the fees go are on-chain forever. The optional first buy happens in the same transaction, so nobody can buy before you.
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

          <CreatorFeeField text={feeText} onText={setFeeText} showError={submitted} />

          <FeeDestinationPicker
            plan={plan}
            onPlan={setPlan}
            errors={planned.errors}
            showErrors={submitted}
            account={address}
            probed={probed}
          />

          {detailsEnabled && (
            <fieldset className="launch-details">
              <legend className="text-sm font-semibold">Details</legend>
              <p className="mt-1 text-xs leading-5 text-g500">All optional. They are stored on IPFS and cannot be changed after launch.</p>

              <div className="mt-5">
                <span className="block text-sm text-g500" id="launch-image-label">Image</span>
                <div className="mt-2 flex min-w-0 items-center gap-3">
                  {image && <img src={image.previewUrl} alt="" width={44} height={44} className="h-11 w-11 shrink-0 rounded border border-g300 object-cover" />}
                  <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => void pickImage(event)} />
                  <GhostButton type="button" aria-describedby="launch-image-label launch-image-hint" onClick={() => fileInput.current?.click()}>{image ? 'Change image' : 'Choose image'}</GhostButton>
                  {image && (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm text-g500">{imageName}</span>
                      <button type="button" className="shrink-0 text-sm underline" onClick={() => { setImage(undefined); setImageName('') }}>Remove</button>
                    </>
                  )}
                </div>
                <p id="launch-image-hint" className="mt-2 text-xs leading-5 text-g500">PNG, JPEG, WebP or GIF. Resized to 512px; location data in the photo is removed.</p>
                {imageProblem && <p className="mt-2 text-sm text-loss" role="alert">{imageProblem}</p>}
              </div>

              <div className="mt-5">
                <label className="block text-sm text-g500" htmlFor="launch-description">Description</label>
                <div className="field-with-suffix mt-1 items-start">
                  <textarea
                    id="launch-description"
                    name="description"
                    rows={3}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    aria-invalid={submitted && Boolean(detailErrors.description)}
                    aria-describedby={submitted && detailErrors.description ? 'launch-description-error' : undefined}
                  />
                  <span>{[...description.trim()].length}/{METADATA_LIMITS.descriptionChars}</span>
                </div>
                {submitted && detailErrors.description && <p id="launch-description-error" className="mt-2 text-sm text-loss" role="alert">{detailErrors.description}</p>}
              </div>

              {([
                ['website', 'Website', 'example.com', website, setWebsite, 'url'],
                ['x', 'X', '@handle', x, setX, 'text'],
                ['telegram', 'Telegram', '@name', telegram, setTelegram, 'text'],
              ] as const).map(([key, label, placeholder, value, setValue, mode]) => (
                <div className="mt-5" key={key}>
                  <label className="block text-sm text-g500" htmlFor={`launch-${key}`}>{label}</label>
                  <div className="field-with-suffix mt-1">
                    <input
                      id={`launch-${key}`}
                      name={key}
                      inputMode={mode}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder={placeholder}
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      aria-invalid={submitted && Boolean(detailErrors[key])}
                      aria-describedby={submitted && detailErrors[key] ? `launch-${key}-error` : undefined}
                    />
                  </div>
                  {submitted && detailErrors[key] && <p id={`launch-${key}-error`} className="mt-2 text-sm text-loss" role="alert">{detailErrors[key]}</p>}
                </div>
              ))}
            </fieldset>
          )}

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
                  const next = sanitizeAmount(event.target.value, usdc.decimals)
                  if (next !== undefined) setFirstBuy(next)
                }}
                aria-invalid={submitted && Boolean(firstBuyError)}
                aria-describedby={submitted && firstBuyError ? 'launch-first-buy-error' : undefined}
              />
              <span>USDC</span>
            </div>
            {submitted && firstBuyError && <p id="launch-first-buy-error" className="mt-2 text-sm text-loss" role="alert">{firstBuyError}</p>}
            <p className="mt-2 text-xs leading-5 text-g500">
              Optional. This buy happens in the same transaction as the create, so nobody can buy before you. It pays both fees like any other buy.
            </p>
            {address && (
              <p className="mt-1 text-sm text-g500">Balance {formatAmount(usdcBalance, usdc.decimals)}</p>
            )}
          </div>
        </div>

        <dl className="receipt-lines mt-8">
          <div><dt>Launch fee</dt><dd>{create.feeKnown ? `${create.formatFee} USDC` : GHOST}</dd></div>
          <div>
            <dt>Creator fee</dt>
            <dd className={fee.error ? 'text-g500' : ''}>
              {fee.error ? GHOST : (
                <span className="inline-flex items-center gap-2">
                  <FeeGauge bps={creatorFeeBps} showValue={false} decorative />
                  {formatPct(creatorFeeBps)} of every trade
                </span>
              )}
            </dd>
          </div>
          <div><dt>Fees go to</dt><dd>{planSummary(plan, address)}</dd></div>
          <div><dt>You receive</dt><dd className={create.firstBuy ? '' : 'text-g500'}>{receive}</dd></div>
          <div><dt>Fees on your buy</dt><dd className={create.firstBuy ? '' : 'text-g500'}>{buyFees}</dd></div>
          <div><dt>Total</dt><dd>{total}</dd></div>
        </dl>

        <PrimaryButton
          type="submit"
          className="mt-6 w-full"
          loading={create.isLoading || saving}
          disabled={create.isDisabled || saving}
        >
          {saving ? 'Saving details…' : create.label}
        </PrimaryButton>
        {saveProblem && <p className="mt-3 text-sm text-loss" role="alert">{saveProblem}</p>}
        {create.hint && <p className="hint-line" role="status">{create.hint}</p>}
        <TxStatus status={create.txStatus} />
      </form>
    </div>
  )
}
