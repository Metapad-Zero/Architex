import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export function ChevronIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m7 9 5 5 5-5" /></svg>
}

export function FlipIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M7 7h11l-3-3M17 17H6l3 3M18 7l-3 3M6 17l3-3" /></svg>
}

export function SettingsIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6" /></svg>
}

export function ExternalLinkIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M14 5h5v5M19 5l-9 9M19 14v5H5V5h5" /></svg>
}

export function CheckIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="m5 12 4 4L19 6" /></svg>
}

export function XIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M6 6l12 12M18 6 6 18" /></svg>
}

export function WalletIcon(props: IconProps) {
  return <svg {...base} {...props}><path d="M4 7h16v12H4zM4 7l3-3h10l3 3M15 12h5v4h-5z" /></svg>
}

export function SearchIcon(props: IconProps) {
  return <svg {...base} {...props}><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 4 4" /></svg>
}
