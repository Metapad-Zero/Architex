# Architex frontend — build spec

Single-page React 18 + Vite + TypeScript + Tailwind 3 app inside the Arc Studio template (this repo).
Wallet stack: wagmi v2, viem v2, ConnectKit (already in `package.json`). Runtime: `bun`.
Read `PRODUCT.md` and `docs/surface-brief-app.md` (the design direction) before writing any UI.
The contracts are being built in parallel against `contracts/interfaces/*.sol` — those interfaces are the ABI truth.

## Non-negotiables

1. **Local quoting.** Quotes come from pool reserves with bigint math in `src/lib/amm.ts` that mirrors the router exactly (see "Math"). Never call `getAmountsOut` on the wire to render a quote; call it only as a pre-flight check right before sending a swap (compare; if the chain says less than the quote minus slippage, abort with a "Quote moved" state).
2. **One read per screen.** `ArchitexLens.pairs(0, 200)` feeds the whole app (polled every 4s via react-query `refetchInterval`, and refetched after every confirmed tx). Balances and allowances via `lens.balances` / `lens.allowances` in one call each. No per-token `balanceOf` waterfalls.
3. **No spinners in content.** Skeleton rows/blocks while loading; the swap sheet renders immediately with ghost zeros.
4. **No new runtime deps** except `@fontsource-variable/public-sans` (add it with `bun add @fontsource-variable/public-sans`). Do not import `framer-motion` or `@circle-fin/*` in the app.
5. **Chain-agnostic wiring.** `VITE_ARC_NETWORK=testnet|mainnet` (default `testnet`) picks the chain and the deployment file. Never hardcode an address in a component.
6. **Every amount is a bigint** until formatting. Parse user input with `parseAmount(str, decimals)` — never `parseFloat` on money.
7. Keep `src/main.tsx`'s providers, the Studio watermark, `src/tracing.ts`, `src/console-capture.ts`, `src/onchain-*.ts` untouched (except: `src/config.ts` is yours to rewrite).
8. `bun run typecheck`, `bun run lint`, and `bun test` must pass before you stop. Do not start a dev server or open a browser.

## Files to create

```
src/config.ts                      wagmi config from VITE_ARC_NETWORK (arcTestnet | arc from viem/chains; use RPC URLs from src/onchain-facts.ts)
src/chain.ts                       active chain facts: id, name, explorerBase, rpc, usdc address, isTestnet; explorer URL helpers (tx, address)
src/deployments/arc-testnet.json   COPY the shape in docs/CONTRACTS-SPEC.md §Deployment; fill addresses with the ZERO address placeholders + the 4 test tokens listed there (I will overwrite this file with real addresses; keep the exact key names)
src/deployments/arc-mainnet.json   same shape, empty pairs, only USDC in tokens, zero addresses
src/lib/deployment.ts              loads the JSON for the active chain, typed; `isDeployed` = factory != zero
src/lib/abi.ts                     viem `parseAbi` ABIs transcribed from contracts/interfaces/*.sol (factory, pair, router, lens, testToken, erc20 minimal). Use human-readable struct syntax for the Lens structs.
src/lib/amm.ts                     pure bigint math (below) + routing
src/lib/format.ts                  parseAmount, formatAmount (sig figs), formatUsd, formatPct, shortAddress
src/lib/tokens.ts                  token registry: deployment tokens + tokens discovered from pairs (meta via lens.tokenMeta, cached); USDC always first; logo = drawn monogram (first 1–2 letters) in a 24px black-outlined circle — no image downloads
src/lib/__tests__/amm.test.ts      bun test: getAmountOut/In against known Uniswap V2 vectors, quote, priceImpact, minReceived, route selection
src/lib/__tests__/format.test.ts   parse/format round trips, 6-dec vs 18-dec, sig figs, trailing zeros
src/hooks/usePairs.ts              lens.pairs polling → PairInfo[]; derived `pairMap` keyed by sorted token addresses
src/hooks/useTokens.ts             registry + meta
src/hooks/useBalances.ts           lens.balances for the connected account over registry tokens; refetch after tx
src/hooks/useAllowances.ts         lens.allowances(owner, router, tokens)
src/hooks/usePositions.ts          lens.positions(owner, 0, 200)
src/hooks/useQuote.ts              memoized local quote for (tokenIn, tokenOut, amount, mode: exactIn|exactOut) using pairs; returns amounts, route, priceImpactBps, minReceived/maxSent for the slippage setting, and reason when no quote (NoRoute | InsufficientLiquidity | ZeroAmount)
src/hooks/useSwap.ts               the swap state machine (below); writeContractAsync + waitForTransactionReceipt
src/hooks/useLiquidity.ts          add (approve A/B as needed → addLiquidity) and remove (permit signature → removeLiquidityWithPermit; fallback approve → removeLiquidity)
src/hooks/useSettings.ts           slippage bps (default 50; presets 10/50/100; custom 1–5000) + deadline minutes (default 20), persisted in localStorage (try/catch)
src/hooks/useHashRoute.ts          '#swap' | '#pools' | '#pools/<pairAddress>' ; wrap view changes in document.startViewTransition when available
src/components/AppShell.tsx        masthead + nav + wallet + main column
src/components/WalletButton.tsx    ConnectKitButton.Custom → ghost button "Connect wallet" / "0x12…abcd"; wrong chain → yellow "Switch to Arc Testnet" (useSwitchChain)
src/components/SwapSheet.tsx       the swap form
src/components/AmountField.tsx     label, big numeral input (inputmode="decimal", pattern, sanitize to one decimal point and ≤ decimals fraction digits), token select trigger, balance + Max
src/components/TokenSelect.tsx     popover (native `popover="auto"` + position:fixed placement computed from getBoundingClientRect; on <640px render as a bottom sheet) with search (symbol/name/address), keyboard nav (ArrowUp/Down, Enter, Escape), selected row inverted, balances right-aligned
src/components/ReceiptLines.tsx    Rate (click to flip direction) / Price impact / Fee / Minimum received or Maximum sent / Route
src/components/SettingsPopover.tsx slippage + deadline
src/components/PrimaryButton.tsx   yellow primary; states default/hover/pressed/disabled/loading (loading = black with the top sweep)
src/components/GhostButton.tsx     black outline secondary
src/components/TxStatus.tsx        Pending sweep + "Confirmed · View on ArcScan" / "Failed · <reason>" line under the button
src/components/PoolsView.tsx       table + positions + create-pool
src/components/PoolRow.tsx         row; expands inline (no modal) to AddLiquidityForm
src/components/AddLiquidityForm.tsx two amount fields locked to the pool ratio (typing one computes the other via quote), expected LP + share, approve/add button
src/components/PositionRow.tsx     LP balance, pooled amounts, share %; inline RemoveLiquidityForm with 25/50/75/100% buttons
src/components/FaucetPanel.tsx     testnet only: "Get 10 WETH" etc. (testToken.faucet()) + link to https://faucet.circle.com for USDC
src/components/Skeleton.tsx        gray blocks matching the type scale
src/components/Icons.tsx           inline SVG icons drawn in one 1.5px stroke: chevron, flip (two arrows), settings (sliders), external link, check, x, wallet, search
src/App.tsx                        view switch
src/index.css                      tokens + base + browser-surface theming (below)
tailwind.config.js                 map tokens to Tailwind theme
```

## Math (mirror exactly; test it)

```
quote(amountA, rA, rB)         = amountA * rB / rA
getAmountOut(aIn, rIn, rOut)   = (aIn*997n * rOut) / (rIn*1000n + aIn*997n)
getAmountIn(aOut, rIn, rOut)   = (rIn * aOut * 1000n) / ((rOut - aOut) * 997n) + 1n   (throws if aOut >= rOut)
priceImpactBps: midPrice = rOut/rIn (as a ratio); execPrice = amountOut/amountIn; impact = 1 - exec/mid, in bps, computed in bigint with 1e18 scaling, never floats
minReceived = amountOut * (10000n - slippageBps) / 10000n ; maxSent = amountIn * (10000n + slippageBps) / 10000n
Routing: candidates = direct pair, and 2-hop via USDC (tokenIn→USDC→tokenOut) when both legs exist; for exactIn pick max amountOut, for exactOut pick min amountIn. Return the path as address[].
Add liquidity: given amountA on pair with reserves, amountB = quote(amountA, rA, rB); lpOut = totalSupply == 0 ? sqrt(a*b) - 1000n : min(a*ts/rA, b*ts/rB); share = lpOut / (ts + lpOut)
Remove: amountX = liquidity * reserveX / totalSupply
```

## Swap state machine (`useSwap`)

States (label shown on the primary button unless noted):
- `disconnected` → button "Connect wallet" (opens ConnectKit)
- `wrongChain` → yellow "Switch to Arc Testnet"
- `enterAmount` → disabled "Enter an amount"
- `noRoute` → disabled "No pool for this pair" ; `insufficientLiquidity` → disabled "Not enough liquidity"
- `insufficientBalance` → disabled "Not enough WETH"
- `needsApproval` → "Approve WETH" (approve router for exactly the amount needed: amountIn for exactIn, maxSent for exactOut)
- `approving` → loading "Approving WETH…" (sweep)
- `ready` → "Swap" ; if priceImpactBps > 500 the button reads "Swap anyway" and the impact line is loss-red with "High price impact"
- `quoteMoved` → "Quote moved — review" (re-arms to ready after the user acknowledges)
- `pending` → loading "Swapping…" ; button disabled; TxStatus shows "Pending on Arc Testnet"
- `confirmed` → TxStatus "Confirmed · View on ArcScan" (link), amounts cleared, balances refetched; button back to ready/enterAmount
- `failed` → TxStatus "Failed · <short reason>" ; button back to ready
Pre-flight before `swapExactTokensForTokens`: `router.getAmountsOut(amountIn, path)` once; if last < minReceived → `quoteMoved`. Deadline = now + deadlineMinutes*60. `to` = account.
Errors: user rejection → return to previous state silently (toast "Transaction cancelled"). Revert → `failed` with the custom error name when decodable (viem `BaseError.walk`), else "Transaction reverted".
Toasts (sonner): only for confirmed ("Swapped 0.5 WETH for 1,251.20 USDC") and cancelled; everything else lives in TxStatus.

## Liquidity flows

Add: fields A and B locked to pool ratio (the last-edited field drives). New pool (no pair): both free, show "You are creating this pool — the ratio you enter sets the initial price." Approvals for A and/or B as needed (one button that steps: "Approve WETH" → "Approve USDC" → "Add liquidity"). Mins = amount * (1 - slippage). Success: "Added liquidity · View on ArcScan".
Remove: choose 25/50/75/100% (or type LP amount); shows the two amounts you'll get back; button "Remove liquidity" → `signTypedData` EIP-2612 permit for the pair (domain: name "Architex LP", version "1", chainId, verifyingContract = pair; types Permit{owner,spender,value,nonce,deadline}; nonce from `pair.nonces(owner)`) → `removeLiquidityWithPermit(..., approveMax=false, v, r, s)`. If signing fails (wallet unsupported), fall back to approve LP → `removeLiquidity`.

## Formatting rules

- `formatAmount(value, decimals)`: up to 6 significant figures, at most `decimals` fraction digits, no trailing zeros, thousands separators, "<0.000001" for dust, "0" for zero. Tabular numerals via CSS.
- Rate line: "1 WETH = 2,512.40 USDC" (6 sig figs); click flips to "1 USDC = 0.000398 WETH".
- USD line under each amount: token price in USDC derived from the token's USDC pool mid-price (USDC itself = 1). Hide when no USDC pool.
- Price impact: two decimals, "<0.01%" floor. Fee: "0.30%".
- Addresses: `0x1234…abcd`.

## Design tokens (write these into `src/index.css` as CSS custom properties and map them in `tailwind.config.js`)

```
--paper #FFFFFF  --ink #000000
--g100 #F1F1EF   --g300 #D9D9D6   --g500 #6B6B67   --g700 #3D3D3A
--accent #FFD400 --gain #0B7A3B   --loss #C81E1E
--radius 4px     --unit 8px
font-family: "Public Sans Variable", "Helvetica Neue", Helvetica, Arial, sans-serif  (import '@fontsource-variable/public-sans' once in main.css; font-display swap)
font sizes: 12 / 14 / 16 / 20 / 28 / 40 px (rem-based); weights 400 and 600 only; line-heights 1.25 for 28+, 1.5 otherwise
font-variant-numeric: tabular-nums on body
```
Browser surfaces: `::selection { background: var(--accent); color: var(--ink) }`, `caret-color: var(--ink)`, `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px }`, thin scrollbars with `--g300` thumbs, `color-scheme: light`, `accent-color: var(--ink)`, `text-underline-offset: 3px`.
Motion: 150–250ms `cubic-bezier(0.2, 0, 0, 1)`; `@media (prefers-reduced-motion: reduce)` disables the flip rotation, the sweep animation (show static "Pending…" text), and view transitions.
No box-shadows, no gradients, no border-radius other than 4px, no colored left borders, no cards inside cards, no ALL-CAPS labels, no icon+heading+text card grids, no emoji.

## Component states (all must exist)

Buttons: default / hover (primary: 2px inset black ring; ghost: g100 fill) / pressed (invert: black bg, white text) / focus-visible / disabled (g100 bg, g500 text, no ring) / loading (black bg, white text, 2px accent sweep along the top edge).
Inputs: empty (ghost "0" in g300), typing, invalid character rejected (no red — just ignored), over-balance (amount turns loss-red, balance line says "Not enough WETH"), disabled.
Token rows: default / hover g100 / keyboard-active g100 + 2px black outline / selected inverted.
Pools table: loading skeleton (5 rows), empty ("No pools yet. Add liquidity to create the first one." + inline create form), rows sorted by TVL desc.
Positions: empty ("No positions yet. Add liquidity to a pool to start earning fees."), rows.
Wallet: disconnected / connecting / connected / wrong chain.
Faucet (testnet): idle "Get 10 WETH" / pending / done "Sent 10 WETH".

## Copy (use verbatim)

Nav: "Swap", "Pools". Labels: "You pay", "You receive", "Balance", "Max", "Rate", "Price impact", "Fee", "Minimum received", "Maximum sent", "Route", "Slippage", "Deadline", "Your positions", "Pool", "TVL", "Reserves", "Your share", "Add liquidity", "Remove liquidity", "Create a pool".
Buttons as in the state machine. Wallet: "Connect wallet", "Switch to Arc Testnet" / "Switch to Arc".
Errors: "Not enough liquidity in this pool for that amount.", "No pool connects these tokens yet.", "Transaction reverted", "Transaction cancelled".
Settings help: "Your swap fails if the price moves more than this while it confirms."
Testnet chip: "Testnet". Faucet: "Test tokens", "Get 10 WETH", "Get USDC from Circle's faucet".
Confirmed toast: "Swapped {in} {SYM} for {out} {SYM}".

## Accessibility

Labels on every input (visually shown), `aria-live="polite"` region announcing the receive amount after typing settles (debounce 300ms), popover returns focus to its trigger, Escape closes, table uses real `<table>` semantics, min 44px targets on mobile, contrast: g500 on paper ≥ 4.5:1 (it is), never color-only state.

## Responsive

≥ 640px: centered 480px sheet, table full width up to 960px. < 640px: sheet full width with 16px gutters, amount numerals 32px, token select as bottom sheet, table collapses to two-line rows (pool + TVL, reserves under). No horizontal scroll at 360px.

## Acceptance (self-check before finishing)

- `bun run typecheck` clean; `bun run lint` clean; `bun test` green with the math vectors.
- `bun run build` succeeds.
- Every state in "Component states" reachable in code (grep for the copy strings).
- No hardcoded addresses outside `src/deployments/*.json`.
- Summarize what you built, what you could not, and any assumption in your final message.
