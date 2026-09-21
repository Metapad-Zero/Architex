import { useId } from 'react'
import { bpsToPercentText, MAX_CREATOR_FEE_BPS, parsePercentBps } from '../lib/plugins/plan'
import { FeeGauge } from './FeeGauge'

/** The common choices; any value from 0% to 10% in steps of 0.01% can be typed. */
const PRESETS = [0, 100, 250, 500, 1_000] as const

interface CreatorFeeFieldProps {
  /** What the creator typed, in percent ("2.5"). */
  text: string
  onText: (text: string) => void
  /** Show the error, once the form has been submitted. */
  showError: boolean
}

/** The builder's creator fee: 0% to 10% at basis-point precision, starting at 0% [D4], on the needle gauge [D18]. */
export function CreatorFeeField({ text, onText, showError }: CreatorFeeFieldProps) {
  const id = useId()
  const parsed = parsePercentBps(text, MAX_CREATOR_FEE_BPS, 0)
  const bps = parsed.bps ?? 0
  const errorId = `${id}-error`
  const hintId = `${id}-hint`

  return (
    <div className="creator-fee">
      <label className="block text-sm text-g500" htmlFor={`${id}-input`}>Creator fee</label>
      <div className="creator-fee-body">
        <FeeGauge bps={bps} size="lg" live label="Creator fee" />
        <div className="creator-fee-controls">
          <div className="grid grid-cols-5 gap-2" role="group" aria-label="Common creator fees">
            {PRESETS.map((preset) => {
              const active = parsed.bps === preset
              return (
                <button key={preset} type="button" className="choice-button" data-active={active} aria-pressed={active} onClick={() => onText(bpsToPercentText(preset))}>
                  {bpsToPercentText(preset)}%
                </button>
              )
            })}
          </div>
          <div className="field-with-suffix mt-2">
            <input
              id={`${id}-input`}
              name="creatorFee"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={text}
              onChange={(event) => {
                const next = event.target.value.replace(/,/g, '.').trim()
                if (next === '' || /^\d{0,2}(?:\.\d{0,2})?$/.test(next)) onText(next)
              }}
              aria-invalid={showError && Boolean(parsed.error)}
              aria-describedby={showError && parsed.error ? `${errorId} ${hintId}` : hintId}
            />
            <span>%</span>
          </div>
          {showError && parsed.error && <p id={errorId} className="mt-2 text-sm text-loss" role="alert">{parsed.error}</p>}
          <p id={hintId} className="mt-2 text-xs leading-5 text-g500">
            Charged on every buy and sell, your own first buy included, on top of the 0.5% platform fee. From 0% to 10%, and locked for good at launch.
          </p>
        </div>
      </div>
    </div>
  )
}
