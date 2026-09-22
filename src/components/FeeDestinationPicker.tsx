import { useId, useRef } from 'react'
import type { Address } from 'viem'
import { LISTED_PLUGINS, isPluginDeployed, listedPlugin, type ListedPluginKind } from '../content/plugins/registry'
import { GHOST, formatPct, shortAddress } from '../lib/format'
import {
  MAX_COMBO_ENTRIES,
  MAX_PAYEES,
  TOTAL_BPS,
  bpsToPercentText,
  emptyTarget,
  parsePercentBps,
  rowId,
  type ComboEntry,
  type FeePlan,
  type FeePlanKind,
  type PayeeRow,
  type SimpleTarget,
} from '../lib/plugins/plan'
import { GhostButton } from './GhostButton'

interface Option {
  kind: FeePlanKind
  name: string
  tagline: string
}

const WALLET: Option = { kind: 'wallet', name: 'Creator wallet', tagline: 'Your wallet, or one you name.' }
const CUSTOM: Option = { kind: 'custom', name: 'Custom address', tagline: 'Any address. Architex has not reviewed it.' }
const OPTIONS: readonly Option[] = [WALLET, ...LISTED_PLUGINS.map((plugin) => ({ kind: plugin.kind, name: plugin.name, tagline: plugin.tagline })), CUSTOM]
/** What a Combo entry can be: anything but another Combo (a Combo cannot include itself). */
const ENTRY_KINDS: readonly SimpleTarget['kind'][] = ['wallet', 'split', 'buyback', 'holders', 'custom']

function isListedKind(kind: string): kind is ListedPluginKind {
  return kind === 'split' || kind === 'buyback' || kind === 'holders' || kind === 'combo'
}

function available(kind: FeePlanKind): boolean {
  return !isListedKind(kind) || isPluginDeployed(listedPlugin(kind))
}

function kindName(kind: FeePlanKind): string {
  return OPTIONS.find((option) => option.kind === kind)?.name ?? kind
}

/** A new plan of `kind`, as the picker shows it when that kind is chosen. */
export function initialPlan(kind: FeePlanKind, creator?: Address): FeePlan {
  if (kind !== 'combo') return emptyTarget(kind, creator)
  const second: SimpleTarget['kind'] = available('buyback') ? 'buyback' : 'custom'
  return {
    kind: 'combo',
    entries: [
      { id: rowId('e'), target: emptyTarget('wallet', creator), percent: '50' },
      { id: rowId('e'), target: emptyTarget(second, creator), percent: '50' },
    ],
  }
}

interface FieldErrorsProps {
  errors: Record<string, string>
  keys: string[]
  show: boolean
  idPrefix: string
}

function FieldErrors({ errors, keys, show, idPrefix }: FieldErrorsProps) {
  if (!show) return null
  return (
    <>
      {keys.map((key) =>
        errors[key] ? (
          <p key={key} id={`${idPrefix}-${key}`} className="mt-2 text-sm text-loss" role="alert">
            {errors[key]}
          </p>
        ) : null,
      )}
    </>
  )
}

interface AddressFieldProps {
  id: string
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  error?: string
  showError: boolean
  hint?: string
}

function AddressField({ id, label, value, placeholder, onChange, error, showError, hint }: AddressFieldProps) {
  const describedBy = [showError && error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined
  return (
    <div>
      <label className="block text-sm text-g500" htmlFor={id}>{label}</label>
      <div className="field-with-suffix mt-1">
        <input
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={showError && Boolean(error)}
          aria-describedby={describedBy}
        />
      </div>
      {showError && error && <p id={`${id}-error`} className="mt-2 text-sm text-loss" role="alert">{error}</p>}
      {hint && <p id={`${id}-hint`} className="mt-2 text-xs leading-5 text-g500">{hint}</p>}
    </div>
  )
}

function sharesOf(payees: readonly PayeeRow[]): bigint[] {
  return payees.map((row) => (/^\d+$/.test(row.share.trim()) ? BigInt(row.share.trim()) : 0n))
}

interface PayeeListProps {
  idPrefix: string
  payees: PayeeRow[]
  onChange: (payees: PayeeRow[]) => void
  errors: Record<string, string>
  /** Error keys for these payees start with this ("" for a Split, "entry:{id}:" inside a Combo). */
  prefix: string
  showErrors: boolean
}

function PayeeList({ idPrefix, payees, onChange, errors, prefix, showErrors }: PayeeListProps) {
  const shares = sharesOf(payees)
  const total = shares.reduce((sum, share) => sum + share, 0n)
  const update = (id: string, patch: Partial<PayeeRow>) => onChange(payees.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  return (
    <div className="payee-list">
      <div className="payee-head" aria-hidden="true">
        <span>Payee</span>
        <span>Share</span>
      </div>
      {payees.map((row, index) => {
        const addressKey = `${prefix}payee:${row.id}:address`
        const shareKey = `${prefix}payee:${row.id}:share`
        const share = shares[index] ?? 0n
        const percent = total > 0n && share > 0n ? formatPct((share * 10_000n) / total) : GHOST
        const rowErrors = [addressKey, shareKey].filter((key) => showErrors && errors[key]).map((key) => `${idPrefix}-${key}`)
        return (
          <div key={row.id} className="payee-row">
            <div className="field-with-suffix payee-address">
              <input
                aria-label={`Payee ${index + 1} address`}
                placeholder="0x…"
                value={row.address}
                onChange={(event) => update(row.id, { address: event.target.value })}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={showErrors && Boolean(errors[addressKey])}
                aria-describedby={rowErrors.join(' ') || undefined}
              />
            </div>
            <div className="field-with-suffix payee-share">
              <input
                aria-label={`Payee ${index + 1} share`}
                inputMode="numeric"
                value={row.share}
                onChange={(event) => {
                  const next = event.target.value.trim()
                  if (next === '' || /^\d{0,9}$/.test(next)) update(row.id, { share: next })
                }}
                aria-invalid={showErrors && Boolean(errors[shareKey])}
                aria-describedby={rowErrors.join(' ') || undefined}
              />
              <span aria-label={`${percent} of the fees`}>{percent}</span>
            </div>
            <button
              type="button"
              className="row-remove"
              onClick={() => onChange(payees.filter((item) => item.id !== row.id))}
              disabled={payees.length === 1}
              aria-label={`Remove payee ${index + 1}`}
            >
              Remove
            </button>
            <div className="payee-errors">
              <FieldErrors errors={errors} keys={[addressKey, shareKey]} show={showErrors} idPrefix={idPrefix} />
            </div>
          </div>
        )
      })}
      <div className="mt-3 flex items-center justify-between gap-4">
        <GhostButton onClick={() => onChange([...payees, { id: rowId('p'), address: '', share: '1' }])} disabled={payees.length >= MAX_PAYEES}>
          Add payee
        </GhostButton>
        <span className="text-sm text-g500">{payees.length} of {MAX_PAYEES}</span>
      </div>
      <FieldErrors errors={errors} keys={[`${prefix}payees`]} show={showErrors} idPrefix={idPrefix} />
      <p className="mt-3 text-xs leading-5 text-g500">
        Shares are weights: 1 and 1 split evenly, 3 and 1 split 75% and 25%. Anyone can release a payee’s USDC, and it always goes to that payee. Never add a plugin contract as a payee: USDC sent straight to a plugin is credited to no token and is lost.
      </p>
    </div>
  )
}

interface ComboEditorProps {
  idPrefix: string
  entries: ComboEntry[]
  onChange: (entries: ComboEntry[]) => void
  errors: Record<string, string>
  showErrors: boolean
  account?: Address
  probed: ReadonlySet<string>
}

function ComboEditor({ idPrefix, entries, onChange, errors, showErrors, account, probed }: ComboEditorProps) {
  const allocated = entries.reduce((sum, entry) => sum + (parsePercentBps(entry.percent, TOTAL_BPS).bps ?? 0), 0)
  const usedListed = new Set(entries.map((entry) => entry.target.kind).filter((kind) => isListedKind(kind)))
  const update = (id: string, patch: Partial<ComboEntry>) => onChange(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
  const addKind = ENTRY_KINDS.find((kind) => available(kind) && !(isListedKind(kind) && usedListed.has(kind))) ?? 'custom'

  return (
    <div>
      <div className="combo-total" aria-live="polite">
        <span>Allocated</span>
        <span className={allocated === TOTAL_BPS ? 'font-semibold' : 'font-semibold text-loss'}>{formatPct(allocated)} of 100%</span>
      </div>
      <ol className="combo-entries">
        {entries.map((entry, index) => {
          const prefix = `entry:${entry.id}:`
          const kind = entry.target.kind
          return (
            <li key={entry.id} className="combo-entry">
              <div className="combo-entry-head">
                <div className="field-with-suffix combo-kind">
                  <select
                    aria-label={`Destination ${index + 1}`}
                    value={kind}
                    onChange={(event) => update(entry.id, { target: emptyTarget(event.target.value as SimpleTarget['kind'], account) })}
                  >
                    {ENTRY_KINDS.map((option) => (
                      <option key={option} value={option} disabled={!available(option) || (option !== kind && isListedKind(option) && usedListed.has(option))}>
                        {kindName(option)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field-with-suffix combo-percent">
                  <input
                    aria-label={`Destination ${index + 1} share of the fees`}
                    inputMode="decimal"
                    value={entry.percent}
                    placeholder="0"
                    onChange={(event) => {
                      const next = event.target.value.replace(/,/g, '.').trim()
                      if (next === '' || /^\d{0,3}(?:\.\d{0,2})?$/.test(next)) update(entry.id, { percent: next })
                    }}
                    aria-invalid={showErrors && Boolean(errors[`${prefix}percent`])}
                  />
                  <span>%</span>
                </div>
                <button
                  type="button"
                  className="row-remove"
                  onClick={() => onChange(entries.filter((item) => item.id !== entry.id))}
                  disabled={entries.length === 1}
                  aria-label={`Remove destination ${index + 1}`}
                >
                  Remove
                </button>
              </div>
              <FieldErrors errors={errors} keys={[`${prefix}percent`]} show={showErrors} idPrefix={idPrefix} />
              <div className="combo-entry-body">
                <TargetConfig
                  idPrefix={`${idPrefix}-${entry.id}`}
                  target={entry.target}
                  onTarget={(target) => update(entry.id, { target })}
                  errors={errors}
                  errorKey={`${prefix}target`}
                  prefix={prefix}
                  showErrors={showErrors}
                  account={account}
                  probed={probed}
                  inCombo
                />
              </div>
            </li>
          )
        })}
      </ol>
      <div className="mt-3 flex items-center justify-between gap-4">
        <GhostButton
          onClick={() =>
            onChange([...entries, { id: rowId('e'), target: emptyTarget(addKind, account), percent: bpsToPercentText(Math.max(0, TOTAL_BPS - allocated)) }])
          }
          disabled={entries.length >= MAX_COMBO_ENTRIES}
        >
          Add destination
        </GhostButton>
        <span className="text-sm text-g500">{entries.length} of {MAX_COMBO_ENTRIES}</span>
      </div>
      <FieldErrors errors={errors} keys={['entries', 'combo']} show={showErrors} idPrefix={idPrefix} />
      <p className="mt-3 text-xs leading-5 text-g500">
        Each collection is split by these shares; the last destination takes any rounding. One of each plugin, and up to five destinations in all.
      </p>
    </div>
  )
}

interface TargetConfigProps {
  idPrefix: string
  target: SimpleTarget
  onTarget: (target: SimpleTarget) => void
  errors: Record<string, string>
  /** The error key for this target's own address or availability. */
  errorKey: string
  /** The prefix for nested keys (a Split's payees). */
  prefix: string
  showErrors: boolean
  account?: Address
  probed: ReadonlySet<string>
  inCombo?: boolean
}

function probeNote(address: string, probed: ReadonlySet<string>): string | undefined {
  return probed.has(address.trim().toLowerCase())
    ? 'This address declares the fee-plugin interface. It is configured at launch with no settings, so if it needs settings the launch fails.'
    : undefined
}

function TargetConfig({ idPrefix, target, onTarget, errors, errorKey, prefix, showErrors, account, probed, inCombo = false }: TargetConfigProps) {
  switch (target.kind) {
    case 'wallet':
      return (
        <AddressField
          id={`${idPrefix}-wallet`}
          label={inCombo ? 'Wallet' : 'Wallet address'}
          value={target.address}
          placeholder={account ?? '0x…'}
          onChange={(address) => onTarget({ kind: 'wallet', address })}
          error={errors[errorKey]}
          showError={showErrors}
          hint={
            probeNote(target.address, probed) ??
            (!inCombo && namesAnotherWallet(target.address, account)
              ? 'That is not the wallet you create with, so the token’s page will list it as a custom address. Collected fees reach it by plain transfer.'
              : account
                ? `Leave it empty for your connected wallet, ${shortAddress(account)}. Collected fees reach it by plain transfer.`
                : 'Leave it empty for the wallet you create with. Collected fees reach it by plain transfer.')
          }
        />
      )
    case 'custom':
      return (
        <div>
          <AddressField
            id={`${idPrefix}-custom`}
            label="Custom address"
            value={target.address}
            placeholder="0x…"
            onChange={(address) => onTarget({ kind: 'custom', address })}
            error={errors[errorKey]}
            showError={showErrors}
            hint={probeNote(target.address, probed)}
          />
          <p className="mt-2 text-sm leading-6 text-g700">
            Fees go to this address and nowhere else, for good. Architex has not reviewed it and makes no claim about it. If it is a contract that cannot pass USDC on, the fees are stuck there.
          </p>
        </div>
      )
    case 'split':
      return (
        <>
          <PayeeList
            idPrefix={idPrefix}
            payees={target.payees}
            onChange={(payees) => onTarget({ kind: 'split', payees })}
            errors={errors}
            prefix={prefix}
            showErrors={showErrors}
          />
          <FieldErrors errors={errors} keys={[errorKey]} show={showErrors} idPrefix={idPrefix} />
        </>
      )
    case 'buyback':
    case 'holders': {
      const plugin = listedPlugin(target.kind)
      return (
        <>
          <p className="text-sm leading-6 text-g700">{inCombo ? plugin.tagline : plugin.description}</p>
          <FieldErrors errors={errors} keys={[errorKey]} show={showErrors} idPrefix={idPrefix} />
        </>
      )
    }
  }
}

interface FeeDestinationPickerProps {
  plan: FeePlan
  onPlan: (plan: FeePlan) => void
  errors: Record<string, string>
  showErrors: boolean
  account?: Address
  /** Addresses found to declare the fee-plugin interface (lowercased). */
  probed: ReadonlySet<string>
}

/**
 * The plugin marketplace, in the token builder: where a token's creator fees go, chosen once and locked [D5].
 * Listed plugins are configured here; a wallet or a custom address takes no settings. It says where the fees go
 * and nothing more: no plugin is called safe [D7].
 */
export function FeeDestinationPicker({ plan, onPlan, errors, showErrors, account, probed }: FeeDestinationPickerProps) {
  const id = useId().replace(/:/g, '')
  // Switching between options keeps what was typed in each, so a detour does not lose a Split's payees.
  const drafts = useRef(new Map<FeePlanKind, FeePlan>())
  const choose = (kind: FeePlanKind) => {
    if (kind === plan.kind) return
    drafts.current.set(plan.kind, plan)
    onPlan(drafts.current.get(kind) ?? initialPlan(kind, account))
  }
  const selected = OPTIONS.find((option) => option.kind === plan.kind) ?? WALLET

  return (
    <fieldset className="fee-destination">
      <legend className="text-sm text-g500">Where creator fees go</legend>
      <p className="mt-1 text-xs leading-5 text-g500">
        Locked for good at launch, like the fee. Fees wait in the launchpad until anyone collects them to this destination.
      </p>
      <div className="fee-options">
        {OPTIONS.map((option) => {
          const open = available(option.kind)
          const checked = plan.kind === option.kind
          return (
            <label key={option.kind} className="fee-option" data-selected={checked} data-disabled={!open || undefined}>
              <input
                type="radio"
                className="sr-only"
                name={`${id}-destination`}
                value={option.kind}
                checked={checked}
                disabled={!open}
                onChange={() => choose(option.kind)}
              />
              <span className="fee-option-name">{option.name}</span>
              <span className="fee-option-tagline">{open ? option.tagline : 'Not deployed on this network yet.'}</span>
            </label>
          )
        })}
      </div>
      <div className="fee-config" role="group" aria-label={`${selected.name} settings`}>
        {plan.kind === 'combo' ? (
          <ComboEditor
            idPrefix={id}
            entries={plan.entries}
            onChange={(entries) => onPlan({ kind: 'combo', entries })}
            errors={errors}
            showErrors={showErrors}
            account={account}
            probed={probed}
          />
        ) : (
          <TargetConfig
            idPrefix={id}
            target={plan}
            onTarget={onPlan}
            errors={errors}
            errorKey={plan.kind}
            prefix=""
            showErrors={showErrors}
            account={account}
            probed={probed}
          />
        )}
      </div>
    </fieldset>
  )
}

/** Every address typed into a plan, for the plugin probe. */
export function planAddresses(plan: FeePlan): string[] {
  const of = (target: SimpleTarget): string[] =>
    target.kind === 'wallet' || target.kind === 'custom' ? [target.address] : target.kind === 'split' ? target.payees.map((row) => row.address) : []
  return plan.kind === 'combo' ? plan.entries.flatMap((entry) => of(entry.target)) : of(plan)
}

/** Whether `text` names a wallet other than the connected one (the token page will call it a custom address). */
function namesAnotherWallet(text: string, account?: Address): boolean {
  const typed = text.trim()
  return Boolean(typed) && (!account || typed.toLowerCase() !== account.toLowerCase())
}

/**
 * "Split · 3 payees", "Combo · 3 destinations", "Creator wallet · 0x12…ab": the receipt's short form of a plan,
 * worded the way the token's page will word it: only the creator's own address is a "Creator wallet".
 */
export function planSummary(plan: FeePlan, account?: Address): string {
  switch (plan.kind) {
    case 'wallet': {
      if (namesAnotherWallet(plan.address, account)) return `Custom address · ${shortAddress(plan.address.trim())}`
      return account ? `Creator wallet · ${shortAddress(account)}` : 'Creator wallet'
    }
    case 'custom':
      return plan.address.trim() ? `Custom address · ${shortAddress(plan.address.trim())}` : 'Custom address'
    case 'split':
      return `Split · ${plan.payees.length} ${plan.payees.length === 1 ? 'payee' : 'payees'}`
    case 'combo':
      return `Combo · ${plan.entries.length} ${plan.entries.length === 1 ? 'destination' : 'destinations'}`
    case 'buyback':
    case 'holders':
      return listedPlugin(plan.kind).name
  }
}
