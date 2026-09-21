import { useAccount, useSwitchChain } from 'wagmi'
import { activeChain } from '../chain'
import { shortAddress } from '../lib/format'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { WalletIcon } from './Icons'
import { GhostButton } from './GhostButton'

export function WalletButton() {
  const { address, isConnected, isConnecting, chainId } = useAccount()
  const { switchChain } = useSwitchChain()
  const { isOpen, open, close, triggerRef } = useConnectSheet()
  const wrongChain = isConnected && chainId !== activeChain.id
  const label = wrongChain
    ? activeChain.isTestnet
      ? 'Switch to Arc Testnet'
      : 'Switch to Arc'
    : isConnecting
      ? 'Connecting…'
      : isConnected && address
        ? shortAddress(address)
        : 'Connect wallet'

  return (
    <GhostButton
      ref={triggerRef}
      className={wrongChain ? 'border-accent bg-accent hover:bg-accent' : ''}
      aria-controls="connect-sheet"
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      onClick={() => {
        if (wrongChain) switchChain({ chainId: activeChain.id })
        else if (isOpen) close()
        else open()
      }}
    >
      <WalletIcon className="h-4 w-4" />
      <span>{label}</span>
    </GhostButton>
  )
}
