import { useCallback } from 'react'
import { useSwitchChain } from 'wagmi'
import { activeChain } from '../chain'
import { useConnectSheet } from './useConnectSheet'

/** Asks the wallet to move to Arc. If it can't or won't, opens the wallet sheet — the only place to disconnect or pick another wallet, so a user stuck on another network always has a way out. */
export function useSwitchToArc() {
  const { switchChainAsync } = useSwitchChain()
  const { open } = useConnectSheet()
  return useCallback(async () => {
    try {
      await switchChainAsync({ chainId: activeChain.id })
    } catch {
      open()
    }
  }, [open, switchChainAsync])
}
