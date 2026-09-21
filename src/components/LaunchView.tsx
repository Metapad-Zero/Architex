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
  creating?: boolean
  onOpen: (token?: Address) => void
  onCreate: () => void
  onCreated: (token: Address) => void
}

export function LaunchView({ token, creating, onOpen, onCreate, onCreated }: LaunchViewProps) {
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
  if (token) return <LaunchDetail token={token} onBack={() => onOpen()} />
  return <LaunchList onOpen={(next) => onOpen(next)} onCreate={onCreate} />
}
