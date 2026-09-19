import { forwardRef, useState, type InputHTMLAttributes } from 'react'

interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'id'> {
  id: string
  label: string
  className?: string
}

/** A labelled secret field in the compact-field grammar, with the Show / Hide toggle a field without a reset needs. */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField({ id, label, className, ...props }, ref) {
  const [shown, setShown] = useState(false)
  return (
    <div className={className}>
      <label className="block text-sm text-g500" htmlFor={id}>{label}</label>
      <div className="field-with-suffix mt-1">
        <input id={id} ref={ref} type={shown ? 'text' : 'password'} spellCheck={false} autoCapitalize="off" autoCorrect="off" {...props} />
        <button type="button" className="field-toggle" aria-pressed={shown} aria-controls={id} onClick={() => setShown((value) => !value)}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  )
})

/**
 * Password managers file a saved password under a username; the browser wallet has none, so every
 * wallet-password form carries this constant one, hidden, to let the browser save and fill it.
 */
export function WalletUsernameHint() {
  return <input hidden readOnly type="text" name="username" autoComplete="username" value="Architex browser wallet" />
}
