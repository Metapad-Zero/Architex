import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { useAccount } from 'wagmi'
import { activeChain, addressExplorerUrl } from '../chain'
import { listedPlugin, listedPluginAt } from '../content/plugins/registry'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { useCreatorFees, type CreatorFeeAction } from '../hooks/useCreatorFees'
import { useSwitchToArc } from '../hooks/useSwitchToArc'
import { GHOST, formatAmount, formatLp, formatPct, shortAddress } from '../lib/format'
import type { LaunchRecord } from '../lib/launch'
import { destinationLabel, destinationName, feeDestination } from '../lib/plugins/destination'
import { dividendStatus, roughly } from '../lib/plugins/holders'
import {
  BUYBACK_MIN_RUN_USDC,
  BUYBACK_RUN_INTERVAL,
  DEEPEN_MIN_RUN_USDC,
  DEEPEN_RUN_INTERVAL,
  type BuybackState,
  type ComboEntryState,
  type DeepenState,
  type HolderState,
  type SplitState,
} from '../lib/plugins/state'
import { FeeGauge } from './FeeGauge'
import { GhostButton } from './GhostButton'
import { ExternalLinkIcon } from './Icons'
import { TxStatus } from './TxStatus'

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

function formatTime(seconds: bigint): string {
  return new Date(Number(seconds) * 1_000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
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

function BuybackPanel({ buyback, symbol, graduated, alsoPaysHolders, busy, status, run, runBuyback }: {
  buyback: BuybackState
  symbol: string
  graduated: boolean
  /** The token also pays holders (a Combo): say that burning does not raise their share. */
  alsoPaysHolders: boolean
  busy: CreatorFeeAction | undefined
  status: ActionProps['status']
  run: Run
  runBuyback: () => Promise<void>
}) {
  // previewRun is the plugin's own answer for this block: the paced budget, the one-run-a-block limit and the
  // smallest run all included. When it is 0 with USDC waiting, the budget is refilling since the last run.
  const next = buyback.offer > 0n
    ? `Up to ${usdc(buyback.offer)}`
    : buyback.held >= BUYBACK_MIN_RUN_USDC
      ? 'Builds up over the next hour'
      : 'Nothing waiting yet'
  const fullAt = buyback.lastRunAt > 0n ? buyback.lastRunAt + BUYBACK_RUN_INTERVAL : 0n
  const now = BigInt(Math.floor(useNow() / 1_000))
  const side = graduated ? 'pool’s' : 'curve’s'
  return (
    <section className="fee-plugin" aria-label="Buyback and burn">
      <div className="fee-plugin-head">
        <h3>Buyback &amp; burn</h3>
        <span>{graduated ? 'Buys in the launch pool' : 'Buys on the curve'}</span>
      </div>
      <dl className="receipt-lines">
        <div><dt>USDC waiting</dt><dd>{usdc(buyback.held)}</dd></div>
        <div><dt>Next run</dt><dd className={buyback.offer > 0n ? '' : 'text-g500'}>{next}</dd></div>
        <div>
          <dt>Last run</dt>
          <dd className={buyback.lastRunAt > 0n ? '' : 'text-g500'}>
            {buyback.lastRunAt === 0n
              ? 'Never'
              : fullAt > now
                ? `${formatWhen(buyback.lastRunAt)} · full budget again at ${formatTime(fullAt)}`
                : formatWhen(buyback.lastRunAt)}
          </dd>
        </div>
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
        Anyone can run it. It spends at most 0.25% of the {side} USDC side per hour and burns every token it buys, so the supply only goes down.
        {alsoPaysHolders && ' It doesn’t raise anyone’s share of holder dividends: the tokens it buys come from the curve or the pool, which earn none.'}
        {listedPlugin('buyback').paused && ' This version is paused for new launches, and an updated one is coming.'}
      </p>
    </section>
  )
}

function DeepenPanel({ deepen, symbol, graduated, alsoPaysHolders, busy, status, run, runDeepen }: {
  deepen: DeepenState
  symbol: string
  graduated: boolean
  /** The token also pays holders (a Combo): say that neither burning nor adding raises their share. */
  alsoPaysHolders: boolean
  busy: CreatorFeeAction | undefined
  status: ActionProps['status']
  run: Run
  runDeepen: () => Promise<void>
}) {
  // previewRun is the plugin's own answer for this block, as Buyback & burn's is, and says how the offer divides.
  const next = deepen.offer > 0n
    ? `Up to ${usdc(deepen.offer)}`
    : deepen.held >= DEEPEN_MIN_RUN_USDC
      ? 'Builds up over the next hour'
      : 'Nothing waiting yet'
  const fullAt = deepen.lastRunAt > 0n ? deepen.lastRunAt + DEEPEN_RUN_INTERVAL : 0n
  const now = BigInt(Math.floor(useNow() / 1_000))
  return (
    <section className="fee-plugin" aria-label="Deepen pool">
      <div className="fee-plugin-head">
        <h3>Deepen pool</h3>
        <span>{graduated ? 'Burns and adds to the pool' : 'Buys on the curve and burns'}</span>
      </div>
      <dl className="receipt-lines">
        <div><dt>Burn share</dt><dd>{formatPct(deepen.burnBps)}</dd></div>
        <div><dt>USDC waiting</dt><dd>{usdc(deepen.held)}</dd></div>
        <div><dt>Next run</dt><dd className={deepen.offer > 0n ? '' : 'text-g500'}>{next}</dd></div>
        {/* On the curve a run burns all it buys, so only a pool run has a split to show. */}
        {graduated && deepen.offer > 0n && (
          <>
            <div><dt>Buys and burns</dt><dd>{usdc(deepen.toBurn)}</dd></div>
            <div><dt>Buys and adds to the pool</dt><dd>{usdc(deepen.toDeepen)}</dd></div>
          </>
        )}
        <div>
          <dt>Last run</dt>
          <dd className={deepen.lastRunAt > 0n ? '' : 'text-g500'}>
            {deepen.lastRunAt === 0n
              ? 'Never'
              : fullAt > now
                ? `${formatWhen(deepen.lastRunAt)} · full budget again at ${formatTime(fullAt)}`
                : formatWhen(deepen.lastRunAt)}
          </dd>
        </div>
        <div><dt>Spent so far</dt><dd>{usdc(deepen.totalSpent)}</dd></div>
        <div><dt>Burned so far</dt><dd>{formatAmount(deepen.totalBurned, 18)} {symbol}</dd></div>
        <div>
          <dt>Added to the pool</dt>
          <dd className={graduated ? '' : 'text-g500'}>
            {graduated ? `${usdc(deepen.totalUsdcAdded)} + ${formatAmount(deepen.totalTokensAdded, 18)} ${symbol}` : 'Starts once it graduates'}
          </dd>
        </div>
        {graduated && <div><dt>Liquidity locked</dt><dd>{formatLp(deepen.totalLiquidity)} LP</dd></div>}
      </dl>
      <div className="mt-4">
        <GhostButton disabled={deepen.offer === 0n || Boolean(busy)} onClick={() => run(runDeepen)}>
          {busy === 'deepen' ? 'Running…' : 'Run'}
        </GhostButton>
      </div>
      <ActionStatus action="deepen" status={status} />
      <p className="fee-plugin-note">
        Anyone can run it. It spends at most 0.25% of the {graduated ? 'pool’s locked USDC' : 'curve’s USDC side'} per hour. On the curve it buys the token and burns it; once the token graduates, each run burns its burn share and adds the rest to the pool, with the new liquidity locked at the burn address for good.
        {alsoPaysHolders && ' It doesn’t raise anyone’s share of holder dividends: the tokens it buys come from the curve or the pool, which earn none.'}
      </p>
    </section>
  )
}

/** A running stream's rate, to three significant figures; never a bare 0, since a running stream always pays something. */
function perHourText(perHour: bigint): string {
  return perHour === 0n ? 'Under 0.000001 USDC/hour to all holders' : `≈ ${usdc(roughly(perHour))}/hour to all holders`
}

function HoldersPanel({ holders, symbol, busy, status, run, claim, connected }: {
  holders: HolderState
  symbol: string
  busy: CreatorFeeAction | undefined
  status: ActionProps['status']
  run: Run
  claim: (amount: bigint) => Promise<void>
  connected: boolean
}) {
  // Read, not ticked: live financial values never animate, so the figures refresh with each poll (every ~10s).
  const stream = dividendStatus(holders)
  const you = holders.you
  const yours = you?.claimable ?? 0n
  return (
    <section className="fee-plugin" aria-label="Holder dividends">
      <div className="fee-plugin-head">
        <h3>Holder dividends</h3>
        <span>Paid in USDC, by the second</span>
      </div>
      <dl className="receipt-lines">
        <div>
          <dt>Your dividends</dt>
          <dd className={you ? '' : 'text-g500'}>{you ? usdc(yours) : 'Connect a wallet to see yours'}</dd>
        </div>
        {you && <div><dt>You hold</dt><dd>{formatAmount(you.balance, 18)} {symbol}</dd></div>}
        {/* One fact per line, so each fits a phone's width. */}
        <div>
          <dt>Streaming</dt>
          <dd className={stream.kind === 'none' ? 'text-g500' : ''}>{stream.kind === 'none' ? 'Nothing right now' : `${usdc(stream.left)} left`}</dd>
        </div>
        {stream.kind === 'streaming' && <div><dt>Ends</dt><dd>{formatWhen(stream.endsAt)}</dd></div>}
        {stream.kind !== 'none' && (
          <div>
            <dt>Rate</dt>
            <dd className={stream.kind === 'paused' ? 'text-g500' : ''}>
              {stream.kind === 'paused' ? 'Paused (no holders yet)' : perHourText(stream.perHour)}
            </dd>
          </div>
        )}
        {/* totalDistributed counts every USDC paid in for holders, streamed out yet or not. */}
        <div><dt>Paid in so far</dt><dd>{usdc(holders.totalDistributed)}</dd></div>
      </dl>
      <div className="mt-4">
        <GhostButton disabled={(connected && yours === 0n) || Boolean(busy)} onClick={() => run(() => claim(yours))}>
          {busy === 'claim' ? 'Claiming…' : 'Claim'}
        </GhostButton>
      </div>
      <ActionStatus action="claim" status={status} />
      <p className="fee-plugin-note">
        You earn for every second you hold, in proportion to what you hold, so buying just before a payout earns nothing extra. Each payment to holders streams out over about a day{holders.fromFees ? '; collecting creator fees adds to the stream' : ''}. Tokens on the curve, in the launch pool or burned earn nothing.
      </p>
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
          // From allocationOf alone: its isPlugin flag is the Combo's stored decision to pay through hooks.
          const listed = entry.isPlugin ? listedPluginAt(entry.target) : undefined
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
        <BuybackPanel
          buyback={state.buyback}
          symbol={launch.symbol}
          graduated={launch.graduated}
          alsoPaysHolders={Boolean(state.holders)}
          busy={fees.busy}
          status={fees.status}
          run={run}
          runBuyback={fees.runBuyback}
        />
      )}
      {state?.deepen && (
        <DeepenPanel
          deepen={state.deepen}
          symbol={launch.symbol}
          graduated={launch.graduated}
          alsoPaysHolders={Boolean(state.holders)}
          busy={fees.busy}
          status={fees.status}
          run={run}
          runDeepen={fees.runDeepen}
        />
      )}
      {state?.holders && (
        <HoldersPanel
          holders={state.holders}
          symbol={launch.symbol}
          busy={fees.busy}
          status={fees.status}
          run={run}
          claim={fees.claim}
          connected={Boolean(address)}
        />
      )}
    </section>
  )
}
