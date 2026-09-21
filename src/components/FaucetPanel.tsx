import { useState } from 'react'
import type { Address } from 'viem'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { testTokenAbi } from '../lib/abi'
import { pushRecent } from '../lib/recent'
import type { Token } from '../lib/tokens'
import { ExternalLinkIcon } from './Icons'
import { GhostButton } from './GhostButton'

type FaucetState = 'idle' | 'pending' | 'done'

const faucetUnits: Record<string, string> = { WETH: '10', WBTC: '1', ARC: '10,000', EURC: '1,000' }

function faucetLabel(symbol: string, state: FaucetState): string {
  if (symbol === 'WETH') {
    if (state === 'pending') return 'Sending WETH…'
    return state === 'done' ? 'Sent 10 WETH' : 'Get 10 WETH'
  }
  const amount = faucetUnits[symbol] ?? ''
  if (state === 'pending') return `Sending ${symbol}…`
  return state === 'done' ? `Sent ${amount} ${symbol}` : `Get ${amount} ${symbol}`
}

interface FaucetPanelProps {
  tokens: readonly Token[]
  onConfirmed: () => void | Promise<void>
}

export function FaucetPanel({ tokens, onConfirmed }: FaucetPanelProps) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [states, setStates] = useState<Record<Address, FaucetState>>({})

  const request = async (token: Token) => {
    if (!address || !publicClient) return
    setStates((current) => ({ ...current, [token.address]: 'pending' }))
    try {
      const hash = await writeContractAsync({ chainId: activeChain.id, address: token.address, abi: testTokenAbi, functionName: 'faucet' })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transaction reverted')
      setStates((current) => ({ ...current, [token.address]: 'done' }))
      pushRecent(activeChain.id, { hash, kind: 'faucet', summary: `Received ${faucetUnits[token.symbol] ?? ''} ${token.symbol} from the faucet` })
      await onConfirmed()
    } catch {
      setStates((current) => ({ ...current, [token.address]: 'idle' }))
    }
  }

  const faucetTokens = tokens.filter((token) => token.faucet)
  return (
    <section className="ruled-section mt-16">
      <div className="section-heading-row"><h2>Test tokens</h2></div>
      {!address && <p className="pb-2 text-sm text-g500">Connect your wallet to request test tokens.</p>}
      <div className="flex flex-wrap gap-2 py-4">
        {faucetTokens.map((token) => {
          const state = states[token.address] ?? 'idle'
          return (
            <GhostButton key={token.address} disabled={!address || state === 'pending'} onClick={() => void request(token)}>
              {faucetLabel(token.symbol, state)}
            </GhostButton>
          )
        })}
        <a className="ghost-button" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
          Get USDC from Circle&apos;s faucet <ExternalLinkIcon className="h-4 w-4" />
        </a>
      </div>
    </section>
  )
}
