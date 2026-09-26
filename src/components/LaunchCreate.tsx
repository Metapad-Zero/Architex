import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { activeChain } from '../chain'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { useCreateToken } from '../hooks/useCreateToken'
import { useDestinationProbe } from '../hooks/useDestinationProbe'
import { useLaunch } from '../hooks/useLaunch'
import { useSettings } from '../hooks/useSettings'
import { parseOptionalAmount, sanitizeAmount } from '../lib/amountInput'
import { builderVersion, deployment, launchSuiteV14, suiteFor } from '../lib/deployment'
import { GHOST, formatAmount, formatPct } from '../lib/format'
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

/** v1.4's choice of who may add liquidity to the token's Uniswap pool once it graduates, closed first (the default). */
const POOL_CHOICES = [
  { open: false, name: 'Closed pool', tagline: 'Only the launch liquidity, locked for good.' },
  { open: true, name: 'Open pool', tagline: 'Anyone can add their own liquidity too.' },
] as const

/** The launchpad new launches go to, and the plugins deployed for it. */
const LAUNCHPAD = { suite: suiteFor(builderVersion), version: builderVersion }
const V14 = builderVersion === 'v14'

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
  // v1.4: who may add liquidity to the token's pool once it graduates. Closed unless the creator opens it.
  const [openPool, setOpenPool] = useState(false)
  // Every typed address is checked against the launchpad before the launch can go (launch pools, launch tokens,
  // the router and pair factory are refused on chain), and against ERC-165 (a plugin is never a Split payee).
  const facts = useDestinationProbe(useMemo(() => planAddresses(plan), [plan]))
  const planned = useMemo(
    () =>
      planFeePlugin(plan, {
        creator: address,
        usdc: activeChain.usdc,
        suite: LAUNCHPAD.suite,
        architexContracts: [deployment.factory, deployment.router, deployment.lens],
        poolManager: launchSuiteV14.poolManager,
        facts,
      }),
    [address, facts, plan],
  )

  const valid =
    !nameError && !symbolError && !firstBuyInput.error && !fee.error && Object.keys(detailErrors).length === 0 && !imageProblem && Boolean(planned.plan)

  const create = useCreateToken({
    name: name.trim(),
    symbol: symbol.trim(),
    metadataURI: '',
    creatorFeeBps,
    pluginPlan: planned.plan,
    openPool,
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
          {V14
            ? 'Name, symbol, creator fee, where the fees go and who may add to its pool are on-chain forever. The optional first buy happens in the same transaction, so nobody can buy before you.'
            : 'Name, symbol, creator fee and where the fees go are on-chain forever. The optional first buy happens in the same transaction, so nobody can buy before you.'}
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
            launchpad={LAUNCHPAD}
            plan={plan}
            onPlan={setPlan}
            errors={planned.errors}
            showErrors={submitted}
            account={address}
            probed={facts.plugins}
          />

          {V14 && (
            <fieldset className="fee-destination">
              <legend className="text-sm text-g500">Pool after graduation</legend>
              <p className="mt-1 text-xs leading-5 text-g500">
                When the curve sells out, the token moves to its own Uniswap v4 pool. Locked for good at launch, like the fee.
              </p>
              <div className="fee-options">
                {POOL_CHOICES.map((choice) => (
                  <label key={choice.name} className="fee-option" data-selected={openPool === choice.open}>
                    <input
                      type="radio"
                      className="sr-only"
                      name="pool-choice"
                      value={choice.open ? 'open' : 'closed'}
                      checked={openPool === choice.open}
                      onChange={() => setOpenPool(choice.open)}
                    />
                    <span className="fee-option-name">{choice.name}</span>
                    <span className="fee-option-tagline">{choice.tagline}</span>
                  </label>
                ))}
              </div>
              <p className="mt-3 text-sm leading-6 text-g700">
                {openPool
                  ? 'Anyone can add liquidity to the pool and take their own back out. The launch liquidity is locked either way: nobody can ever withdraw it.'
                  : 'Nobody else can add liquidity to the pool. The launch liquidity is locked either way: nobody can ever withdraw it.'}
              </p>
              <p className="mt-1 text-xs leading-5 text-g500">
                The pool charges no liquidity fee of its own, so liquidity added to an open pool earns nothing from trades.
              </p>
            </fieldset>
          )}

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
              {V14
                ? 'Optional. This buy happens in the same transaction as the create, so nobody can buy before you, and it pays no anti-sniping fee. It pays both fees like any other buy.'
                : 'Optional. This buy happens in the same transaction as the create, so nobody can buy before you. It pays both fees like any other buy.'}
            </p>
            {V14 && (
              <p className="mt-1 text-xs leading-5 text-g500">
                For the first 20 blocks after launch (about 10 seconds), and again for 20 blocks after its pool opens, every buy also pays an anti-sniping fee that starts at 90% and falls to 0. It stays with the token, locked into its pool as liquidity nobody can withdraw.
              </p>
            )}
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
          {V14 && <div><dt>Pool</dt><dd>{openPool ? 'Uniswap v4 · open' : 'Uniswap v4 · closed'}</dd></div>}
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
