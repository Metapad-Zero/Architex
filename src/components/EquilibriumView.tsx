import { useEffect, useState } from 'react'
import { CHAINS, CHAIN_NAMES, ISSUANCE, LIMITS, UNIT, applyDemo, createDemo, displayUnits, gap, quoteCycle, restoreDemo, serializeDemo, spot, supply, treasury, type DemoAction, type DemoChain, type DemoState } from '../lib/equilibrium'
import './equilibrium.css'

const STORAGE = 'architex.equilibrium.v1'
function loadSession(): { state: DemoState; message: string } {
  try {
    const saved = localStorage.getItem(STORAGE)
    return { state: saved ? restoreDemo(saved) : createDemo(), message: saved ? 'Saved simulation restored.' : 'Start with a demand shock, then let the agent respond.' }
  } catch {
    return { state: createDemo(), message: 'The saved simulation could not be read. A fresh simulation is ready.' }
  }
}

function PriceBeam({ state }: { state: DemoState }) {
  const prices = state.markets.map(spot)
  const lower = Math.min(0.95, ...prices)
  const upper = Math.max(1.2, ...prices)
  const y = (price: number) => 142 - ((price - lower) / (upper - lower)) * 116
  const points = prices.map((price, index) => `${80 + index * 200},${y(price)}`).join(' ')
  return (
    <svg className="eq-beam" viewBox="0 0 760 196" role="img" aria-label={`Four market prices. The highest price is ${gap(state).toFixed(2)} percent above the lowest.`}>
      <line x1="48" x2="712" y1={y(1)} y2={y(1)} className="eq-beam-reference" />
      <text x="752" y={y(1) - 8} textAnchor="end" className="eq-beam-label">1.00 reference</text>
      <polyline points={points} className="eq-beam-line" />
      {prices.map((price, index) => <g key={CHAINS[index]}>
        <line x1={80 + index * 200} x2={80 + index * 200} y1={y(price)} y2="164" className="eq-beam-support" />
        <circle cx={80 + index * 200} cy={y(price)} r="6" className="eq-beam-dot" />
        <text x={80 + index * 200} y="191" textAnchor="middle" className="eq-beam-name">{['Arc', 'Base', 'Solana', 'Robinhood'][index]}</text>
      </g>)}
    </svg>
  )
}

export function EquilibriumView() {
  const [session, setSession] = useState(loadSession)
  const [demandChain, setDemandChain] = useState<DemoChain>('solana')
  const [demandAmount, setDemandAmount] = useState('200')
  const [transferFrom, setTransferFrom] = useState<DemoChain>('arc')
  const [transferTo, setTransferTo] = useState<DemoChain>('base')
  const [transferAmount, setTransferAmount] = useState('80')
  const [costInput, setCostInput] = useState(() => displayUnits(session.state.cost))
  const [error, setError] = useState('')
  const { state, message } = session
  const proof = supply(state)
  const decision = quoteCycle(state)
  const funds = treasury(state)

  useEffect(() => {
    try { localStorage.setItem(STORAGE, serializeDemo(state)) }
    catch { /* The active model still works when browser storage is unavailable. */ }
  }, [state])

  function run(action: DemoAction) {
    try {
      const next = applyDemo(state, action)
      setSession({ state: next, message: next === state ? 'Duplicate message ignored. The destination was credited once.' : next.receipts[next.receipts.length - 1]?.summary ?? 'Simulation updated.' })
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The simulation could not complete this action.') }
  }
  function parseInput(value: string): bigint {
    if (!/^\d+(\.\d{1,6})?$/.test(value)) throw new Error('Enter a positive number with at most six decimal places.')
    const [whole, fraction = ''] = value.split('.')
    return BigInt(whole) * UNIT + BigInt(fraction.padEnd(6, '0'))
  }
  function withAmount(value: string, action: (amount: bigint) => DemoAction) {
    try { run(action(parseInput(value))) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Enter a valid amount.') }
  }
  function reset() {
    setSession({ state: createDemo(), message: 'Simulation reset. All four markets start at 1.00 simulated USDC.' })
    setCostInput('3.00'); setError('')
  }
  function download() {
    const url = URL.createObjectURL(new Blob([serializeDemo(state)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'equilibrium-simulation.json'; anchor.click()
    URL.revokeObjectURL(url)
  }

  return <article className="eq-page">
    <header className="eq-heading">
      <div><h1>EQUILIBRIUM</h1><p>One supply. Four chains. Watch it rebalance.</p></div>
      <span className="eq-mode">Simulation</span>
    </header>
    <p className="eq-intro">Make one market move. Watch a bounded agent buy on the cheaper chain and sell on the dearer one. Every number here comes from the local model; no real funds move.</p>

    <section className="eq-markets" aria-labelledby="eq-market-title">
      <div className="eq-section-head"><h2 id="eq-market-title">Four markets, one asset</h2><span>Price gap <strong>{gap(state).toFixed(2)}%</strong></span></div>
      <PriceBeam state={state} />
      <div className="eq-market-grid">{state.markets.map((item) => <div key={item.chain} className="eq-market">
        <h3>{CHAIN_NAMES[item.chain]}</h3>
        <p className="eq-price">{spot(item).toFixed(4)}</p><p className="eq-muted">simulated USDC / token</p>
        <span className="eq-health" data-health={item.health}>{item.health === 'healthy' ? 'Fresh quotes' : item.health === 'stale' ? 'Stale quotes · excluded' : 'Offline · excluded'}</span>
        <dl><div><dt>Pool tokens</dt><dd>{displayUnits(item.tokens)}</dd></div><div><dt>Pool USDC</dt><dd>{displayUnits(item.quote)}</dd></div>
          <div><dt>Agent tokens</dt><dd>{displayUnits(item.keeperTokens)}</dd></div><div><dt>Agent USDC</dt><dd>{displayUnits(item.keeperQuote)}</dd></div></dl>
      </div>)}</div>
    </section>

    <section className="eq-play" aria-labelledby="eq-play-title">
      <div><h2 id="eq-play-title">Put it to work</h2><p className="eq-muted">A customer buy opens a gap. The agent trades only when the executable edge covers its costs.</p></div>
      <form className="eq-demand" onSubmit={(event) => { event.preventDefault(); withAmount(demandAmount, (quote) => ({ type: 'demand', chain: demandChain, quote })) }}>
        <label>Demand on<select value={demandChain} onChange={(event) => setDemandChain(event.target.value as DemoChain)}>{CHAINS.map((chain) => <option key={chain} value={chain}>{CHAIN_NAMES[chain]}</option>)}</select></label>
        <label>Simulated USDC<input inputMode="decimal" value={demandAmount} onChange={(event) => setDemandAmount(event.target.value)} /></label>
        <button className="ghost-button" type="submit">Create demand</button>
      </form>
      <div className="eq-decision">
        <div><strong>{state.halted ? 'Keeper paused' : decision.candidate ? `${CHAIN_NAMES[decision.candidate.buy]} → ${CHAIN_NAMES[decision.candidate.sell]}` : 'Waiting for an executable gap'}</strong>
          <p>{decision.candidate ? `Trade ${displayUnits(decision.candidate.amount)} tokens. Net edge ${displayUnits(decision.candidate.edge)} after ${displayUnits(state.cost)} costs and a ${displayUnits(LIMITS.buffer)} risk buffer.` : decision.reason}</p></div>
        {state.halted ? <button type="button" className="eq-primary" onClick={() => run({ type: 'recover' })}>Recover failed trade</button>
          : <button type="button" className="eq-primary" onClick={() => run({ type: 'balance' })}>{decision.candidate ? 'Run balancing agent' : 'Check balancing decision'}</button>}
      </div>
      <p className="eq-status" role="status" aria-live="polite">{message}</p>
      {error && <p className="eq-error" role="alert">{error}</p>}
    </section>

    <div className="eq-proof-grid">
      <section aria-labelledby="eq-supply-title"><div className="eq-section-head"><h2 id="eq-supply-title">Inspect the supply</h2><span className="eq-reconciled">{proof.reconciled ? 'Reconciled' : 'Mismatch'}</span></div>
        <dl className="eq-ledger"><div><dt>Arc, outside bridge custody</dt><dd>{displayUnits(proof.arc)}</dd></div><div><dt>Remote representations</dt><dd>{displayUnits(proof.remote)}</dd></div><div><dt>Transfers awaiting credit</dt><dd>{displayUnits(proof.pending)}</dd></div><div className="eq-total"><dt>One global supply</dt><dd>{displayUnits(proof.economic, 0)}</dd></div></dl>
        <p className="eq-muted">{displayUnits(proof.backing, 0)} canonical tokens in bridge custody back remote and pending claims. They are excluded from the total. Fixed issuance: {displayUnits(ISSUANCE, 0)}.</p>
      </section>
      <section aria-labelledby="eq-costs-title"><div className="eq-section-head"><h2 id="eq-costs-title">Count the costs</h2><span>Simulated USDC</span></div>
        <dl className="eq-ledger"><div><dt>Agent net, closed cycles</dt><dd>{displayUnits(state.net, 6)}</dd></div><div><dt>Pool + agent quote holdings</dt><dd>{displayUnits(funds.quote)}</dd></div><div><dt>Session spend / limit</dt><dd>{displayUnits(state.spent)} / {displayUnits(LIMITS.dailySpend, 0)}</dd></div><div><dt>Realized loss / limit</dt><dd>{displayUnits(state.loss)} / {displayUnits(LIMITS.dailyLoss, 0)}</dd></div></dl>
        <p className="eq-muted">Agent profit can be offset by pool losses. Combined quote holdings also reflect customer demand; this is an accounting view, not a return forecast. {state.recovery ? 'One purchase remains open and is excluded from closed-cycle net.' : 'No open trade exposure.'}</p>
      </section>
    </div>

    <details className="eq-tools"><summary>Test the guardrails and bridge</summary><div className="eq-tools-content">
      <section><h3>Execution limits</h3><form className="eq-control-row" onSubmit={(event) => { event.preventDefault(); withAmount(costInput, (amount) => ({ type: 'cost', amount })) }}><label>Operating cost per cycle<input inputMode="decimal" value={costInput} onChange={(event) => setCostInput(event.target.value)} /></label><button type="submit" className="ghost-button">Set cost</button></form>
        <p className="eq-muted">Pool fees are included in quotes. The agent tests whole-token sizes up to 80 tokens and reserves a 1 USDC buffer. Limits apply to this saved session.</p>
        <button type="button" className="ghost-button" disabled={!decision.candidate} onClick={() => run({ type: 'balance', failSell: true })}>Simulate failed sale</button>
      </section>
      <section><h3>Market availability</h3><div className="eq-health-controls">{state.markets.map((item) => <label key={item.chain}>{CHAIN_NAMES[item.chain]}<select value={item.health} onChange={(event) => run({ type: 'health', chain: item.chain, health: event.target.value as typeof item.health })}><option value="healthy">Fresh</option><option value="stale">Stale</option><option value="offline">Offline</option></select></label>)}</div></section>
      <section className="eq-transfer-tools"><h3>Move agent inventory</h3><p className="eq-muted">Arc is the hub. A debit creates a pending claim; a separate completion credits the destination exactly once. This models accounting, not an authenticated bridge.</p>
        <form className="eq-control-row" onSubmit={(event) => { event.preventDefault(); withAmount(transferAmount, (amount) => ({ type: 'bridge', from: transferFrom, to: transferTo, amount })) }}>
          <label>From<select value={transferFrom} onChange={(event) => setTransferFrom(event.target.value as DemoChain)}>{CHAINS.map((chain) => <option key={chain} value={chain}>{CHAIN_NAMES[chain]}</option>)}</select></label>
          <label>To<select value={transferTo} onChange={(event) => setTransferTo(event.target.value as DemoChain)}>{CHAINS.map((chain) => <option key={chain} value={chain}>{CHAIN_NAMES[chain]}</option>)}</select></label>
          <label>Tokens<input inputMode="decimal" value={transferAmount} onChange={(event) => setTransferAmount(event.target.value)} /></label><button type="submit" className="ghost-button">Start transfer</button>
        </form>
        {state.transfers.length === 0 ? <p className="eq-muted">No transfers yet.</p> : <ul className="eq-transfers">{state.transfers.slice(-10).reverse().map((transfer) => <li key={transfer.id}><span>{transfer.id} · {CHAIN_NAMES[transfer.from]} → {CHAIN_NAMES[transfer.to]} · {displayUnits(transfer.amount)} · {transfer.status}</span><button type="button" className="ghost-button" onClick={() => run({ type: 'complete', id: transfer.id })}>{transfer.status === 'pending' ? 'Complete transfer' : 'Replay message'}</button></li>)}</ul>}
      </section>
    </div></details>

    <section className="eq-record" aria-labelledby="eq-record-title"><div className="eq-section-head"><h2 id="eq-record-title">The action record</h2><button type="button" className="ghost-button" onClick={download}>Download session</button></div>
      {state.receipts.length === 0 ? <p className="eq-empty">All four markets begin at the same price. Create demand to record the first action.</p> : <ol className="eq-receipts">{state.receipts.slice(-20).reverse().map((receipt) => <li key={receipt.id} data-kind={receipt.kind}>
        <span className="eq-receipt-kind">{receipt.kind}</span><div><p>{receipt.summary}</p>{['demand', 'balance', 'failure', 'recovery'].includes(receipt.kind) && <p className="eq-muted">Gap {receipt.gapBefore.toFixed(2)}% → {receipt.gapAfter.toFixed(2)}%{receipt.kind === 'balance' || receipt.kind === 'recovery' ? ` · net ${displayUnits(receipt.net, 6)} simulated USDC` : ''}</p>}</div><span className="eq-receipt-id">#{receipt.id}</span>
      </li>)}</ol>}
      {state.receipts.length > 20 && <p className="eq-muted">Showing the latest 20 actions. The download includes the complete session.</p>}
    </section>
    <section className="eq-next"><h2>From demonstration to a paid launch</h2><p>This proves the local mechanism. The four-chain x402 gateway still needs a deployed payment ledger, working venue adapters, verified token routes and funded markets. Four ordinary launches would create four separate assets; EQUILIBRIUM needs a dedicated shared-supply path.</p><a href="/equilibrium-readiness.md" download="equilibrium-readiness.md">Download the implementation checklist</a></section>
    <div className="eq-bottom"><p className="eq-muted">Saved in this browser when storage is available. Reset clears this simulation’s actions and balances.</p><button type="button" className="ghost-button" onClick={reset}>Reset simulation</button></div>
  </article>
}
