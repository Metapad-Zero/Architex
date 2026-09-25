import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { activeChain } from '../chain'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { useSwitchToArc } from '../hooks/useSwitchToArc'
import type { SwapTxStatus } from '../hooks/useSwap'
import { launchHookAbi } from '../lib/abi'
import { launchSuiteV14 } from '../lib/deployment'
import { isUserRejection, revertReason } from '../lib/errors'
import { GHOST, formatAmount, formatPct } from '../lib/format'
import type { LaunchRecord } from '../lib/launch'
import { launchFixtureApi } from '../lib/launchFixtureApi'
import { secondsUntil, snipeBps, snipeWindowEnd } from '../lib/launchV14'
import { pushRecent } from '../lib/recent'
import { GhostButton } from './GhostButton'
import { TxStatus } from './TxStatus'

const fixtureOn = import.meta.env.DEV && import.meta.env.VITE_LAUNCHPAD_FIXTURE === '1'

interface AntiSnipePanelProps {
  launch: LaunchRecord
  /** The chain's latest block (hooks/useChainBlock.ts); undefined until read. */
  block: bigint | undefined
  /** USDC of anti-sniping fees held for the pool: the launchpad's before graduation, the hook's after. */
  held: bigint | undefined
  onChanged: () => void | Promise<void>
}

/**
 * A v1.4 token's anti-sniping fee (V14-SPEC §5): what a buy pays now while a window is open, and what the fee has
 * collected for the token's pool. On the curve the launchpad holds it and the hook locks it in at graduation; in the
 * pool the hook holds it until anyone presses Lock, which adds it to the pool as a bid nobody can withdraw.
 */
export function AntiSnipePanel({ launch, block, held, onChanged }: AntiSnipePanelProps) {
  const { address: account, isConnected, chainId } = useAccount()
  const { open } = useConnectSheet()
  const switchToArc = useSwitchToArc()
  const publicClient = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<SwapTxStatus>()

  const opened = launch.graduated ? launch.v4?.openBlock : launch.createdBlock
  const end = opened === undefined ? undefined : snipeWindowEnd(opened)
  const rate = opened === undefined || block === undefined ? undefined : snipeBps(opened, block, launch.creatorFeeBps)
  const windowOpen = rate !== undefined && rate > 0

  const lock = useCallback(async () => {
    if (!isConnected || !account) {
      open()
      return
    }
    if (chainId !== activeChain.id) {
      await switchToArc()
      return
    }
    const summary = `Locked ${formatAmount(held ?? 0n, 6)} USDC into the ${launch.symbol} pool`
    setBusy(true)
    setStatus({ kind: 'pending' })
    try {
      let hash
      if (fixtureOn) {
        const api = launchFixtureApi()
        if (!api) return
        hash = api.lock(launch.token)
      } else {
        if (!publicClient) return
        hash = await writeContractAsync({
          chainId: activeChain.id,
          address: launchSuiteV14.hook,
          abi: launchHookAbi,
          functionName: 'lock',
          args: [launch.token],
        })
        setStatus({ kind: 'pending', hash })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Transaction reverted')
      }
      setStatus({ kind: 'confirmed', hash, summary })
      pushRecent(activeChain.id, { hash, kind: 'launch', summary })
      await onChanged()
    } catch (error) {
      setStatus(isUserRejection(error) ? { kind: 'cancelled' } : { kind: 'failed', reason: revertReason(error) })
    } finally {
      setBusy(false)
    }
  }, [account, chainId, held, isConnected, launch.symbol, launch.token, onChanged, open, publicClient, switchToArc, writeContractAsync])

  const where = launch.graduated ? 'after its pool opened' : 'after launch'
  return (
    <section className="ruled-section mt-14" aria-labelledby="anti-snipe-title">
      <div className="section-heading-row">
        <h2 id="anti-snipe-title">Anti-sniping fee</h2>
        <span>Locked into the pool</span>
      </div>
      <dl className="receipt-lines">
        <div>
          <dt>Fee on a buy now</dt>
          <dd className={windowOpen ? '' : 'text-g500'}>{rate === undefined ? GHOST : windowOpen ? formatPct(rate) : 'None'}</dd>
        </div>
        {windowOpen && end !== undefined && block !== undefined && (
          <div>
            <dt>Falls to 0</dt>
            <dd>{`At block ${end.toLocaleString('en-US')}, in about ${secondsUntil(end, block)}s`}</dd>
          </div>
        )}
        <div>
          <dt>{launch.graduated ? 'Waiting to lock' : 'Held for the pool'}</dt>
          <dd className={held === undefined ? 'text-g500' : ''}>{held === undefined ? GHOST : `${formatAmount(held, 6)} USDC`}</dd>
        </div>
      </dl>
      {launch.graduated && (
        <>
          <div className="mt-4">
            <GhostButton disabled={!held || busy} onClick={() => void lock()}>
              {busy ? 'Locking…' : 'Lock into the pool'}
            </GhostButton>
          </div>
          <TxStatus status={status} />
        </>
      )}
      <p className="fee-plugin-note">
        {`For 20 blocks ${where} (about 10 seconds), every buy pays an extra fee that starts at 90% and falls to 0; sells never do. `}
        {launch.graduated
          ? 'The hook holds what the pool’s window collects until anyone locks it: it then joins the pool as liquidity that starts at half the price and runs all the way down, which nobody can ever withdraw.'
          : 'The launchpad holds what the curve’s window collects, and it goes into the token’s pool when it graduates, as liquidity nobody can ever withdraw. If the curve never sells out, it stays in the launchpad.'}
      </p>
    </section>
  )
}
