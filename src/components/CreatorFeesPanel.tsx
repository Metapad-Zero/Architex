import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { activeChain, addressExplorerUrl } from '../chain'
import { listedPluginAt } from '../content/plugins/registry'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { useCreatorFees, type CreatorFeeAction } from '../hooks/useCreatorFees'
import { useSwitchToArc } from '../hooks/useSwitchToArc'
import { formatAmount, formatPct, shortAddress } from '../lib/format'
import type { LaunchRecord } from '../lib/launch'
import { destinationLabel, destinationName, feeDestination } from '../lib/plugins/destination'
import { claimableAfterDrip } from '../lib/plugins/holders'
import type { BuybackState, ComboEntryState, HolderState, SplitState } from '../lib/plugins/state'
import { FeeGauge } from './FeeGauge'
import { GhostButton } from './GhostButton'
import { ExternalLinkIcon } from './Icons'
import { TxStatus } from './TxStatus'

const GHOST = '—'

function usdc(value: bigint): string {
  return `${formatAmount(value, 6)} USDC`
}

function AddressLink({ address, label }: { address: Address; label?: string }) {
  return (
    <a className="inline-flex items-center gap-1 underline" href={addressExplorerUrl(address)} target="_blank" rel="noreferrer">
      {label ?? shortAddress(address)} <ExternalLinkIcon className="h-4 w-4" />
    </a>
  )
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

function formatWhen(seconds: bigint): string {
  return new Date(Number(seconds) * 1_000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

interface ActionProps {
  action: CreatorFeeAction
  busy: CreatorFeeAction | undefined
  status: { action: CreatorFeeAction; tx: Parameters<typeof TxStatus>[0]['status'] } | undefined
}

function ActionStatus({ action, status }: Omit<ActionProps, 'busy'>) {
  return status?.action === action ? <TxStatus status={status.tx} /> : null
}

type Run = (action: () => Promise<void>) => void

function SplitPanel({ split, symbol, busy, status, run, release, you }: {
  split: SplitState
  symbol: string
  busy: CreatorFeeAction | undefined
  status: ActionProps['status']
  run: Run
  release: (payee: Address) => Promise<void>
  you?: Address
}) {
  return (
    <section className="fee-plugin" aria-label="Split">
      <div className="fee-plugin-head">
        <h3>Split</h3>
        <span>{usdc(split.totalReceived)} received</span>
      </div>
      {split.payees.length === 0 ? (
        <p className="price-history-empty">This Split has no payees for {symbol}.</p>
      ) : (
        <ol className="ledger-list">
          {split.payees.map((payee) => {
            const action: CreatorFeeAction = `release:${payee.address.toLowerCase()}`
            const share = split.totalShares > 0n ? formatPct((payee.share * 10_000n) / split.totalShares) : GHOST
            const mine = you && payee.address.toLowerCase() === you.toLowerCase()
            return (
              <li key={payee.address} className="payee-ledger-row">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    <AddressLink address={payee.address} />
                    {mine && <span className="ml-2 font-normal text-g500">You</span>}
                  </span>
                  <span className="block text-xs text-g500">
                    {share} · {usdc(payee.released)} paid
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block">{usdc(payee.releasable)}</span>
                  <span className="block text-xs text-g500">waiting</span>
                </span>
                <GhostButton
                  className="shrink-0"
                  disabled={payee.releasable === 0n || Boolean(busy)}
                  onClick={() => run(() => release(payee.address))}
                  aria-label={`Release ${usdc(payee.releasable)} to ${shortAddress(payee.address)}`}
                >
                  {busy === action ? 'Releasing…' : 'Release'}
                </GhostButton>
                <div className="basis-full empty:hidden">
                  <ActionStatus action={action} status={status} />
                </div>
              </li>
            )
          })}
        </ol>
      )}
      <p className="fee-plugin-note">Anyone can release a payee’s share. The USDC always goes to that payee.</p>
    </section>
  )
}

function BuybackPanel({ buyback, symbol, graduated, busy, status, run, runBuyback }: {
  buyback: BuybackState
  symbol: string
  graduated: boolean
  busy: CreatorFeeAction | undefined
  status: ActionProps['status']
  run: Run
  runBuyback: () => Promise<void>
}) {
  const next = buyback.offer > 0n
    ? `Up to ${usdc(buyback.offer)}`
    : buyback.held > 0n
      ? 'Ran this block. Try again in a moment.'
      : 'Nothing waiting yet'
  return (
    <section className="fee-plugin" aria-label="Buyback and burn">
      <div className="fee-plugin-head">
        <h3>Buyback &amp; burn</h3>
        <span>{graduated ? 'Buys in the launch pool' : 'Buys on the curve'}</span>
      </div>
      <dl className="receipt-lines">
        <div><dt>USDC waiting</dt><dd>{usdc(buyback.held)}</dd></div>
        <div><dt>Next run</dt><dd className={buyback.offer > 0n ? '' : 'text-g500'}>{next}</dd></div>
        <div><dt>Spent so far</dt><dd>{usdc(buyback.totalSpent)}</dd></div>
        <div><dt>Burned so far</dt><dd>{formatAmount(buyback.totalBurned, 18)} {symbol}</dd></div>
      </dl>
      <div className="mt-4">
        <GhostButton disabled={buyback.offer === 0n || Boolean(busy)} onClick={() => run(runBuyback)}>
          {busy === 'run' ? 'Running buyback…' : 'Run buyback'}
        </GhostButton>
      </div>
      <ActionStatus action="run" status={status} />
      <p className="fee-plugin-note">
        Anyone can run it. Each run spends at most 0.25% of the {graduated ? 'pool’s' : 'curve’s'} USDC side, once a block, and burns every token it buys, so the supply only goes down.
      </p>
    </section>
  )
}

function HoldersPanel({ holders, symbol, busy, status, run, claim, drip, connected }: {
  holders: HolderState
  symbol: string
  busy: CreatorFeeAction | undefined
  status: ActionProps['status']
  run: Run
  claim: (amount: bigint) => Promise<void>
  drip: () => Promise<void>
  connected: boolean
}) {
  const now = useNow()
  const dueNow = holders.streamEnd > 0n && BigInt(Math.floor(now / 1_000)) >= holders.streamEnd
  const dripping = holders.unreleased === 0n
    ? 'Nothing waiting'
    : dueNow
      ? `${usdc(holders.unreleased)}, all due now`
      : `${usdc(holders.unreleased)} until ${formatWhen(holders.streamEnd)}`
  const you = holders.you
  const yours = you ? claimableAfterDrip({ claimable: you.claimable, releasable: holders.releasable, balance: you.balance, eligibleSupply: holders.eligibleSupply }) : 0n
  return (
    <section className="fee-plugin" aria-label="Distribute to holders">
      <div className="fee-plugin-head">
        <h3>Distribute to holders</h3>
        <span>Paid in USDC, pro rata</span>
      </div>
      <dl className="receipt-lines">
        <div><dt>Releasing</dt><dd className={holders.unreleased === 0n ? 'text-g500' : ''}>{dripping}</dd></div>
        <div><dt>Ready to drip now</dt><dd>{usdc(holders.releasable)}</dd></div>
        <div><dt>Paid to holders</dt><dd>{usdc(holders.totalDistributed)}</dd></div>
        <div>
          <dt>Your claimable</dt>
          <dd className={you ? '' : 'text-g500'}>{you ? usdc(yours) : 'Connect a wallet to see yours'}</dd>
        </div>
        {you && <div><dt>You hold</dt><dd>{formatAmount(you.balance, 18)} {symbol}</dd></div>}
      </dl>
      <div className="mt-4 flex flex-wrap gap-3">
        <GhostButton disabled={(connected && yours === 0n) || Boolean(busy)} onClick={() => run(() => claim(yours))}>
          {busy === 'claim' ? 'Claiming…' : 'Claim'}
        </GhostButton>
        <GhostButton disabled={holders.releasable === 0n || Boolean(busy)} onClick={() => run(drip)}>
          {busy === 'drip' ? 'Dripping…' : 'Drip to holders'}
        </GhostButton>
      </div>
      <ActionStatus action="claim" status={status} />
      <ActionStatus action="drip" status={status} />
      <p className="fee-plugin-note">
        Fees reach holders gradually, not all at once, so nobody can buy, collect and sell in one go. Anyone can drip what is due to every holder, and claiming drips it too. What drips goes to whoever holds at that moment.
      </p>
      {holders.eligibleSupply === 0n && holders.unreleased > 0n && (
        <p className="fee-plugin-note">Nobody holds a whole token yet, so nothing is released until someone does.</p>
      )}
    </section>
  )
}

function ComboAllocation({ entries }: { entries: ComboEntryState[] }) {
  return (
    <section className="fee-plugin" aria-label="Combo allocation">
      <div className="fee-plugin-head">
        <h3>Combo</h3>
        <span>{entries.length} {entries.length === 1 ? 'destination' : 'destinations'}</span>
      </div>
      <dl className="receipt-lines">
        {entries.map((entry) => {
          const listed = listedPluginAt(entry.target)
          return (
            <div key={entry.target}>
              <dt>
                {listed ? listed.name : entry.isPlugin ? 'Custom plugin' : 'Wallet'}
                {!listed && <span className="ml-2"><AddressLink address={entry.target} /></span>}
              </dt>
              <dd>{formatPct(entry.bps)}</dd>
            </div>
          )
        })}
      </dl>
      <p className="fee-plugin-note">Every collection is split by these shares; the last destination takes any rounding.</p>
    </section>
  )
}

interface CreatorFeesPanelProps {
  launch: LaunchRecord
  onChanged: () => void | Promise<void>
}

/**
 * The token page's creator fees: the fee on its gauge, where the fees go, what waits in the launchpad and a
 * Collect button anyone can press, then the chosen plugin's own view (a Combo's listed entries each get theirs).
 */
export function CreatorFeesPanel({ launch, onChanged }: CreatorFeesPanelProps) {
  const { address, chainId, isConnected } = useAccount()
  const { open } = useConnectSheet()
  const switchToArc = useSwitchToArc()
  const fees = useCreatorFees(launch, onChanged)
  const state = fees.state
  const destination = feeDestination(launch)

  // Every action here is permissionless but still a transaction: it needs a connected wallet on Arc first.
  const run: Run = (action) => {
    if (!isConnected || !address) {
      open()
      return
    }
    if (chainId !== activeChain.id) {
      void switchToArc()
      return
    }
    void action()
  }

  const hooks = launch.pluginHooks
  const where =
    destination.kind === 'listed'
      ? `It sends them to ${destination.plugin.name}.`
      : hooks
        ? `It sends them to ${shortAddress(destination.address)} through that contract’s own hooks.`
        : `It sends them to ${shortAddress(destination.address)} by plain transfer.`

  return (
    <section className="ruled-section mt-14" aria-labelledby="creator-fees-title">
      <div className="section-heading-row">
        <h2 id="creator-fees-title">Creator fees</h2>
        <span>{formatPct(launch.creatorFeeBps)} of every buy and sell</span>
      </div>
      <div className="creator-fees-summary">
        <FeeGauge bps={launch.creatorFeeBps} size="lg" label={`${launch.symbol} creator fee`} />
        <div className="min-w-0">
          <dl className="receipt-lines">
            <div>
              <dt>Fees go to</dt>
              <dd>
                {destination.kind === 'listed' ? (
                  <AddressLink address={destination.address} label={destinationName(destination)} />
                ) : (
                  <AddressLink address={destination.address} label={destinationLabel(destination)} />
                )}
              </dd>
            </div>
            <div>
              <dt>Waiting to collect</dt>
              <dd className={state ? '' : 'text-g500'}>{state ? usdc(state.pending) : GHOST}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <GhostButton disabled={!state || state.pending === 0n || Boolean(fees.busy)} onClick={() => run(fees.collect)}>
              {fees.busy === 'collect' ? 'Collecting…' : 'Collect creator fees'}
            </GhostButton>
          </div>
          <ActionStatus action="collect" status={fees.status} />
          <p className="fee-plugin-note">
            Anyone can collect a token’s creator fees, at any time. {where}{' '}
            {destination.kind === 'custom' && 'Architex has not reviewed this address.'}
          </p>
          {fees.error && <p className="fee-plugin-note text-loss" role="alert">The creator fees could not be read. Retrying.</p>}
        </div>
      </div>

      {state?.combo && <ComboAllocation entries={state.combo} />}
      {state?.split && (
        <SplitPanel split={state.split} symbol={launch.symbol} busy={fees.busy} status={fees.status} run={run} release={fees.release} you={address} />
      )}
      {state?.buyback && (
        <BuybackPanel buyback={state.buyback} symbol={launch.symbol} graduated={launch.graduated} busy={fees.busy} status={fees.status} run={run} runBuyback={fees.runBuyback} />
      )}
      {state?.holders && (
        <HoldersPanel
          holders={state.holders}
          symbol={launch.symbol}
          busy={fees.busy}
          status={fees.status}
          run={run}
          claim={fees.claim}
          drip={fees.drip}
          connected={Boolean(address)}
        />
      )}
    </section>
  )
}
