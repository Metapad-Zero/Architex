import { clsx } from 'clsx'

export function Skeleton({ className }: { className?: string }) {
  return <span className={clsx('skeleton block', className)} aria-hidden="true" />
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="border-t border-ink" aria-label="Loading pools">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid grid-cols-[1fr_7rem] gap-4 border-b border-g300 py-5 sm:grid-cols-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-20 justify-self-end sm:justify-self-start" />
          <Skeleton className="hidden h-5 w-32 sm:block" />
        </div>
      ))}
    </div>
  )
}
