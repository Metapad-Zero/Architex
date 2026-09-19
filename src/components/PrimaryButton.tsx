import type { ButtonHTMLAttributes } from 'react'
import { clsx } from 'clsx'

interface PrimaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean
}

export function PrimaryButton({ loading = false, className, children, ...props }: PrimaryButtonProps) {
  return (
    <button
      type="button"
      className={clsx('primary-button', loading && 'is-loading', className)}
      aria-busy={loading}
      {...props}
    >
      <span>{children}</span>
    </button>
  )
}
