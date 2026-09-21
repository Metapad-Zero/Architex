import { useState } from 'react'
import type { Address } from 'viem'
import { useConnectSheet } from '../hooks/useConnectSheet'
import { useBridge } from '../hooks/useBridge'
import { formatAmount } from '../lib/format'
import type { BridgeSide, ForeignChain } from '../lib/cctp'
import type { Token } from '../lib/tokens'
import { AmountField } from './AmountField'
import { FlipIcon } from './Icons'
import { GhostButton } from './GhostButton'
import { PrimaryButton } from './PrimaryButton'
import { TxStatus } from './TxStatus'

const GHOST = '—'

function usdcToken(address: string): Token {
  return { address: address as Address, symbol: 'USDC', name: 'USD Coin', decimals: 6, faucet: false }
}

export function BridgeView() {
  const { open } = useConnectSheet()
  const bridge = useBridge()
  const [solanaProblem, setSolanaProblem] = useState<string>()
  const pay = usdcToken(bridge.source.usdc)
  const receive = usdcToken(bridge.dest.usdc)
  // A failed read is not a zero balance: show no balance line rather than 'Balance 0 / Not enough USDC'.
  const balances = bridge.balanceUnavailable ? new Map<string, bigint>() : new Map<string, bigint>([[pay.address.toLowerCase(), bridge.sourceBalance]])
  const receiveAmount = bridge.parsed > 0n ? formatAmount(bridge.receive, 6) : ''
  const feeLine = bridge.parsed > 0n && bridge.fee >= 0n ? `${formatAmount(bridge.fee, 6)} USDC` : GHOST
  const route = `${bridge.source.label} → ${bridge.dest.label}`
  const arrival = bridge.source.id === 'ethereum' ? 'About a minute, longer if Ethereum is slow' : 'Usually under a minute'

  const handlePrimary = async () => {
    if (bridge.buttonState === 'disconnected') {
      open()
      return
    }
    if (bridge.buttonState === 'needSolana') {
      try {
        await bridge.connectSolana()
      } catch (error) {
        setSolanaProblem(error instanceof Error ? error.message : 'No Solana wallet found. Install Phantom and reload.')
      }
      return
    }
    if (bridge.buttonState === 'wrongChain') {
      await bridge.switchToArc()
      return
    }
    await bridge.execute()
  }

  const setSide = (side: BridgeSide) => {
    bridge.setSide(side)
    bridge.setAmount('')
  }
  const setForeign = (foreign: ForeignChain) => {
    bridge.setForeign(foreign)
  }

  return (
    <div className="swap-column">
      <h1 className="sr-only">Bridge</h1>
      <div className="swap-sheet">
        {bridge.isLoading && <span className="rule-sweep" aria-hidden="true" />}
        <p className="pt-6 text-sm leading-6 text-g700">
          Native USDC. Burned on the source chain, minted on the destination. Same dollar, no wrapped token.
        </p>
        <div className="grid grid-cols-2 gap-2 pb-2 pt-4">
          {(['in', 'out'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="choice-button"
              data-active={bridge.side === value}
              aria-pressed={bridge.side === value}
              onClick={() => setSide(value)}
            >
              {value === 'in' ? 'Into Arc' : 'Out of Arc'}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 pb-4">
          {bridge.foreignChains.map((value) => (
            <button
              key={value}
              type="button"
              className="choice-button"
              data-active={bridge.foreign === value}
              aria-pressed={bridge.foreign === value}
              onClick={() => setForeign(value)}
            >
              {value === 'ethereum' ? 'Ethereum' : 'Solana'}
            </button>
          ))}
        </div>

        <AmountField
          id="bridge-pay"
          label={`You pay · ${bridge.source.label}`}
          amount={bridge.amount}
          onAmount={bridge.setAmount}
          token={pay}
          tokens={[pay]}
          onToken={() => undefined}
          balances={balances}
          usdValue={bridge.parsed > 0n ? formatAmount(bridge.parsed, 6) : undefined}
          checkBalance={!bridge.balanceUnavailable}
          disableTokenSelect
          onSubmit={() => { if (!bridge.isDisabled && !bridge.isLoading) void handlePrimary() }}
        />

        <div className="flip-rule">
          <button
            type="button"
            className="flip-button"
            onClick={() => setSide(bridge.side === 'in' ? 'out' : 'in')}
            aria-label="Flip direction"
          >
            <FlipIcon />
          </button>
        </div>

        <AmountField
          id="bridge-receive"
          label={`You receive · ${bridge.dest.label}`}
          amount={receiveAmount.replace(/,/g, '')}
          onAmount={() => undefined}
          token={receive}
          tokens={[receive]}
          onToken={() => undefined}
          balances={new Map()}
          checkBalance={false}
          readOnly
          disableTokenSelect
        />

        <dl className="receipt-lines" data-live={bridge.parsed > 0n}>
          <div><dt>Route</dt><dd>{route}</dd></div>
          <div>
            <dt>Fee</dt>
            <dd className={bridge.parsed > 0n ? '' : 'text-g500'}>{feeLine}</dd>
          </div>
          <div>
            <dt>You receive</dt>
            <dd className={bridge.parsed > 0n ? '' : 'text-g500'}>
              {bridge.parsed > 0n ? `${formatAmount(bridge.receive, 6)} USDC` : GHOST}
            </dd>
          </div>
          <div>
            <dt>Arrival</dt>
            <dd>{arrival}</dd>
          </div>
        </dl>
        {bridge.estimateError && bridge.parsed > 0n && (
          <p className="quote-message" role="status">{bridge.estimateError}</p>
        )}
        {solanaProblem && (
          <p className="quote-message" role="status">{solanaProblem}</p>
        )}

        <PrimaryButton className="mt-6 w-full" loading={bridge.isLoading} disabled={bridge.isDisabled} onClick={() => void handlePrimary()}>
          {bridge.label}
        </PrimaryButton>
        {bridge.buttonState === 'needSolana' && (
          <p className="hint-line" role="status">A Solana wallet (Phantom or similar) has to sign the {bridge.side === 'in' ? 'burn' : 'receive'} on Solana.</p>
        )}
        <TxStatus status={bridge.txStatus} />
      </div>

      <section className="ledger" aria-label="Claim a stuck transfer">
        <div className="section-heading-row"><h2>Stuck transfer</h2><span>anyone can claim</span></div>
        <p className="mb-3 text-sm leading-6 text-g700">
          If a burn confirmed and the mint did not, paste the burn transaction hash. The USDC always goes to the wallet the burn named.
        </p>
        <label htmlFor="bridge-claim" className="amount-label">Burn transaction</label>
        <div className="mt-2 flex gap-2">
          <div className="field-with-suffix min-w-0 flex-1">
            <input
              id="bridge-claim"
              placeholder="0x… or Solana signature"
              value={bridge.claimHash}
              onChange={(event) => bridge.setClaimHash(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <GhostButton disabled={!bridge.claimHash.trim() || bridge.claimBusy} onClick={() => void bridge.claim()}>
            {bridge.claimBusy ? 'Claiming…' : 'Claim'}
          </GhostButton>
        </div>
      </section>
    </div>
  )
}
