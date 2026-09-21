import type { Address } from 'viem'
import { celebrate } from '../lib/confetti'
import { LaunchCreate } from './LaunchCreate'
import { LaunchDetail } from './LaunchDetail'
import { LaunchList } from './LaunchList'

if (import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1') {
  await import('../lib/launchFixtures')
}

interface LaunchViewProps {
  token?: Address
  /** Which side a token page's trade sheet opens on (Swap links to sell with `?side=sell`). */
  side?: 'buy' | 'sell'
  creating?: boolean
  onOpen: (token?: Address) => void
  onCreate: () => void
  onCreated: (token: Address) => void
}

export function LaunchView({ token, side, creating, onOpen, onCreate, onCreated }: LaunchViewProps) {
  if (creating) {
    return (
      <LaunchCreate
        onCreated={(created) => {
          void celebrate()
          onCreated(created)
        }}
      />
    )
  }
  // Keyed by token: moving between token pages must not carry one token's amounts or transaction line to another.
  if (token) return <LaunchDetail key={token.toLowerCase()} token={token} side={side} onBack={() => onOpen()} />
  return <LaunchList onOpen={(next) => onOpen(next)} onCreate={onCreate} />
}
