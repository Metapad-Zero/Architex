import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Address, EIP1193Provider, Hash, Hex } from 'viem'
import { useAccount } from 'wagmi'
import { activeChain } from '../chain'
import { destinationContext, evmAdapter, getAppKit, solanaAdapter, sourceContext, totalUsdcFees, type EstimateKitResult } from '../lib/bridgeKit'
import { formatBridgeUrl, parseBridgeUrl } from '../lib/bridgeUrl'
import {
  destChain,
  fetchEvmUsdcBalance,
  fetchIrisMessage,
  fetchSplUsdcBalance,
  FOREIGN_CHAINS,
  messageTransmitterAbi,
  sourceChain,
  switchEvmChain,
  type BridgeSide,
  type ForeignChain,
} from '../lib/cctp'
import { isUserRejection, revertReason } from '../lib/errors'
import { parseAmount } from '../lib/format'
import { pushRecent } from '../lib/recent'
import { spendableBalance } from '../lib/gasReserve'
import { useSwitchToArc } from './useSwitchToArc'

export type BridgeButtonState =
  | 'disconnected'
  | 'needSolana'
  | 'wrongChain'
  | 'enterAmount'
  | 'insufficientBalance'
  | 'balanceUnavailable'
  | 'estimating'
  | 'ready'
  | 'bridging'

export interface BridgeTxStatus {
  kind: 'pending' | 'confirmed' | 'failed' | 'cancelled'
  hash?: Hash
  reason?: string
  summary?: string
  label?: string
  explorerUrl?: string
}

export interface SolanaWallet {
  publicKey?: { toString(): string }
  isPhantom?: boolean
  isConnected?: boolean
  connect: () => Promise<{ publicKey: { toString(): string } }>
  disconnect?: () => Promise<void>
}

declare global {
  interface Window {
    solana?: SolanaWallet
  }
}

function solanaProvider(): SolanaWallet | undefined {
  return typeof window === 'undefined' ? undefined : window.solana
}

export function useBridge() {
  const { address, connector, isConnected, chainId } = useAccount()
  const switchToArc = useSwitchToArc()
  const initial = useMemo(() => parseBridgeUrl(window.location.hash), [])
  const [side, setSide] = useState<BridgeSide>(initial.side)
  const [foreign, setForeign] = useState<ForeignChain>(initial.foreign)
  const [amount, setAmount] = useState(initial.amount ?? '')
  const [solanaAddress, setSolanaAddress] = useState<string | undefined>(() => solanaProvider()?.publicKey?.toString())
  const [sourceBalance, setSourceBalance] = useState<bigint>(0n)
  const [balanceUnavailable, setBalanceUnavailable] = useState(false)
  const [estimate, setEstimate] = useState<EstimateKitResult>()
  const [estimateError, setEstimateError] = useState<string>()
  const [phase, setPhase] = useState<'idle' | 'estimating' | 'bridging'>('idle')
  const [txStatus, setTxStatus] = useState<BridgeTxStatus>()
  const [claimHash, setClaimHash] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)

  const source = sourceChain(side, foreign)
  const dest = destChain(side, foreign)
  const usesSolana = source.kind === 'solana' || dest.kind === 'solana'

  useEffect(() => {
    const next = formatBridgeUrl({ side, foreign, amount: amount || undefined })
    if ((window.location.hash.startsWith('#bridge') || window.location.hash === '') && window.location.hash !== next) {
      window.history.replaceState(null, '', next)
    }
  }, [amount, foreign, side])

  const parsed = useMemo(() => {
    try {
      return amount ? parseAmount(amount, 6) : 0n
    } catch {
      return 0n
    }
  }, [amount])

  const refreshBalance = useCallback(async () => {
    let next = 0n
    let failed = false
    try {
      if (source.kind === 'solana' && solanaAddress) next = await fetchSplUsdcBalance(source, solanaAddress)
      else if (address && source.id === 'arc') {
        const { createPublicClient, http, erc20Abi } = await import('viem')
        const client = createPublicClient({ transport: http(activeChain.rpc) })
        next = await client.readContract({ address: source.usdc as Address, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
      } else if (address && source.kind === 'evm') {
        next = await fetchEvmUsdcBalance(source, address)
      }
    } catch {
      failed = true
    }
    setBalanceUnavailable(failed)
    setSourceBalance(next)
  }, [address, solanaAddress, source])

  useEffect(() => {
    let live = true
    void (async () => {
      await Promise.resolve()
      if (!live) return
      await refreshBalance()
    })()
    return () => {
      live = false
    }
  }, [refreshBalance])

  const canQuote = parsed > 0n && Boolean(address) && (!usesSolana || Boolean(solanaAddress))

  useEffect(() => {
    if (!canQuote) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setPhase('estimating')
        try {
          const kit = await getAppKit()
          const provider = (await connector?.getProvider()) as EIP1193Provider | undefined
          if (!provider) throw new Error('Connect a wallet first')
          const evm = await evmAdapter(provider)
          const fromAdapter = source.kind === 'solana' ? await solanaAdapter(solanaProvider(), source.rpc) : evm
          const toAdapter = dest.kind === 'solana' ? undefined : evm
          const quoted = await kit.estimateBridge({
            from: sourceContext(fromAdapter, source, source.kind === 'solana' ? solanaAddress : address),
            to: destinationContext(toAdapter, dest, dest.kind === 'solana' ? solanaAddress : address),
            amount,
            config: { transferSpeed: 'FAST' },
          })
          if (!cancelled) {
            setEstimate(quoted)
            setEstimateError(undefined)
            setPhase('idle')
          }
        } catch (error) {
          if (!cancelled) {
            setEstimate(undefined)
            setEstimateError(error instanceof Error ? error.message : 'Could not quote that route')
            setPhase('idle')
          }
        }
      })()
    }, 400)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [address, amount, canQuote, connector, dest, solanaAddress, source])

  const liveEstimate = canQuote ? estimate : undefined
  const fee = totalUsdcFees(liveEstimate)
  const receive = parsed > fee ? parsed - fee : 0n

  const buttonState = useMemo<BridgeButtonState>(() => {
    if (!isConnected || !address) return 'disconnected'
    if (usesSolana && !solanaAddress) return 'needSolana'
    if (side === 'out' && chainId !== activeChain.id) return 'wrongChain'
    if (phase === 'bridging') return 'bridging'
    if (parsed === 0n) return 'enterAmount'
    if (balanceUnavailable) return 'balanceUnavailable'
    if (parsed > spendableBalance(source.usdc, sourceBalance)) return 'insufficientBalance'
    if (phase === 'estimating') return 'estimating'
    return 'ready'
  }, [address, balanceUnavailable, chainId, isConnected, parsed, phase, side, solanaAddress, source.usdc, sourceBalance, usesSolana])

  const label = useMemo(() => {
    switch (buttonState) {
      case 'disconnected':
        return 'Connect wallet'
      case 'needSolana':
        return 'Connect Solana wallet'
      case 'wrongChain':
        return `Switch to ${activeChain.name}`
      case 'enterAmount':
        return 'Enter amount'
      case 'insufficientBalance':
        return 'Not enough USDC'
      case 'balanceUnavailable':
        return `Couldn't read your ${source.label} balance`
      case 'estimating':
        return 'Quoting…'
      case 'bridging':
        return txStatus?.label ?? 'Bridging'
      default:
        return side === 'in' ? `Bridge to ${dest.label}` : `Bridge to ${dest.label}`
    }
  }, [buttonState, dest.label, side, source.label, txStatus?.label])

  const connectSolana = useCallback(async () => {
    const wallet = solanaProvider()
    if (!wallet) throw new Error('No Solana wallet found. Install Phantom or another wallet and reload.')
    const connection = await wallet.connect()
    setSolanaAddress(connection.publicKey.toString())
  }, [])

  const execute = useCallback(async () => {
    if (!address || !connector) return
    setPhase('bridging')
    setTxStatus({ kind: 'pending', label: 'Bridging' })
    try {
      const kit = await getAppKit()
      const provider = (await connector.getProvider()) as EIP1193Provider
      const evm = await evmAdapter(provider)
      const fromAdapter = source.kind === 'solana' ? await solanaAdapter(solanaProvider(), source.rpc) : evm
      const toAdapter = dest.kind === 'solana' ? undefined : evm
      const result = await kit.bridge({
        from: sourceContext(fromAdapter, source, source.kind === 'solana' ? solanaAddress : address),
        to: destinationContext(toAdapter, dest, dest.kind === 'solana' ? solanaAddress : address),
        amount,
        config: { transferSpeed: 'FAST' },
      })
      const burn = result.steps.find((step) => step.name === 'burn' && step.txHash)
      const mint = [...result.steps].reverse().find((step) => step.txHash)
      const hash = (mint?.txHash ?? burn?.txHash) as Hash | undefined
      if (result.state === 'error') {
        const failed = result.steps.find((step) => step.error)
        throw failed?.error instanceof Error ? failed.error : new Error('Bridge did not complete')
      }
      const summary = `Bridged ${amount} USDC ${source.label} → ${dest.label}`
      setTxStatus({ kind: 'confirmed', hash, summary, explorerUrl: mint?.explorerUrl ?? (hash ? dest.explorerTx(hash) : undefined) })
      if (hash) pushRecent(activeChain.id, { hash, kind: 'bridge', summary })
      setAmount('')
      await refreshBalance()
    } catch (error) {
      if (isUserRejection(error)) {
        setTxStatus({ kind: 'cancelled' })
      } else {
        setTxStatus({ kind: 'failed', reason: revertReason(error) === 'Transaction reverted' ? (error instanceof Error ? error.message : 'Bridge failed') : revertReason(error) })
      }
    } finally {
      setPhase('idle')
    }
  }, [address, amount, connector, dest, refreshBalance, solanaAddress, source])

  const claim = useCallback(async () => {
    const hash = claimHash.trim()
    if (!hash || !connector) return
    setClaimBusy(true)
    setTxStatus({ kind: 'pending', label: 'Looking up attestation' })
    try {
      const message = await fetchIrisMessage(source.domain, hash)
      if (!message) throw new Error('No attestation yet. Wait a minute and try again.')
      if (message.status !== 'complete') throw new Error('Circle has not attested this burn yet.')
      if (!dest.messageTransmitter) throw new Error(`Claim on ${dest.label} needs a retry of the original bridge.`)
      if (!address) throw new Error('Connect a wallet first')
      const provider = (await connector.getProvider()) as EIP1193Provider
      await switchEvmChain(provider, dest)
      const { createWalletClient, custom } = await import('viem')
      const wallet = createWalletClient({ transport: custom(provider) })
      const tx = await wallet.writeContract({
        account: address,
        chain: null,
        address: dest.messageTransmitter,
        abi: messageTransmitterAbi,
        functionName: 'receiveMessage',
        args: [message.message as Hex, message.attestation as Hex],
      })
      setTxStatus({ kind: 'confirmed', hash: tx, summary: `Claimed USDC on ${dest.label}`, explorerUrl: dest.explorerTx(tx) })
      pushRecent(activeChain.id, { hash: tx, kind: 'bridge', summary: `Claimed USDC on ${dest.label}` })
      setClaimHash('')
      await refreshBalance()
    } catch (error) {
      if (isUserRejection(error)) setTxStatus({ kind: 'cancelled' })
      else setTxStatus({ kind: 'failed', reason: error instanceof Error ? error.message : 'Claim failed' })
    } finally {
      setClaimBusy(false)
    }
  }, [address, claimHash, connector, dest, refreshBalance, source.domain])

  return {
    side,
    setSide,
    foreign,
    setForeign,
    amount,
    setAmount,
    source,
    dest,
    foreignChains: FOREIGN_CHAINS,
    parsed,
    receive,
    fee,
    estimateError: canQuote ? estimateError : undefined,
    sourceBalance,
    balanceUnavailable,
    solanaAddress,
    buttonState,
    label,
    isDisabled: buttonState !== 'ready' && buttonState !== 'disconnected' && buttonState !== 'needSolana' && buttonState !== 'wrongChain',
    isLoading: phase === 'bridging' || claimBusy,
    txStatus,
    claimHash,
    setClaimHash,
    claimBusy,
    execute,
    claim,
    connectSolana,
    switchToArc,
  }
}
