import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { clsx } from 'clsx'

export const GhostButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function GhostButton({ className, type = 'button', ...props }, ref) {
    return <button ref={ref} type={type} className={clsx('ghost-button', className)} {...props} />
  },
)
