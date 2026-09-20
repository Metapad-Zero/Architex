# Launch view — frontend brief

Build the launchpad UI for Architex against the frozen ABI in
`contracts/interfaces/IArchitexLaunchpad.sol` / `ILaunchToken.sol` (spec: `LAUNCHPAD-SPEC.md`).
Read `PRODUCT.md`, `DESIGN.md` and `.impeccable/surfaces/src-app-tsx.md` first: this is one more view in
the same printed bank-form world (white paper, black ink, one yellow primary, Public Sans, 1px rules,
4px corners, receipt lines, no cards, no gradients, no icons-as-decoration, no kickers). Reuse the
existing components and classes; do not introduce a new visual language.

## Gate

`src/deployments/arc-*.json` gains `"launchpad": "0x…"` (zero address = not deployed). The "Launch" nav
tab, its routes and every launchpad query exist only when `deployment.launchpad` is non-zero, so
mainnet shows nothing until the contracts are live there.

## Routes (extend `src/hooks/useHashRoute.ts`)

`#launch` list · `#launch/new` create · `#launch/<tokenAddress>` detail. Same View Transition as the
other tabs. Lazy-load the whole view like `PoolsView` (keep the entry bundle where it is).

## Data

- `src/lib/abi.ts`: `launchpadAbi`, `launchTokenAbi` via `parseAbi`, mirroring the interfaces exactly
  (including custom errors, so `lib/errors.ts` can explain `SlippageExceeded`, `CurveGraduated`, …).
- `useLaunches()`: `tokensLength` + `curvesPage` (newest first, 50 per page), 4s refetch like `usePairs`;
  token name/symbol through the existing lens `tokenMeta` batch call.
- `useLaunch(token)`: `curves(token)`, `spotPrice`, `marketCap`, `progressBps`, the user's token and
  USDC balances and USDC allowance to the launchpad.
- Quotes are computed **locally** in bigint (`src/lib/curve.ts`, mirroring the spec's formulas and
  rounding exactly, with unit tests against `quoteBuy`/`quoteSell` vectors), the way `lib/amm.ts` mirrors
  the router. No RPC round trip per keystroke.
- Trades list: `Trade` events for the token (same explorer-logs / RPC-window approach as
  `usePriceHistory`), newest first, max 50.

## Screens

1. **List** (`pools-page` width and rhythm): h1 "Launch", one sentence ("Launch a token on a bonding
   curve. When the curve sells out, its liquidity moves to an Architex pool and is locked for good."),
   ghost "Create a token". Table in the `pools-table` grammar: Token (monogram mark + symbol + name) ·
   Market cap · Sold (a flat ruled meter + "412M / 800M") · Age. Graduated rows say "Graduated" and
   link to `#swap?in=USDC&out=<token>`. Empty state: "No launches yet. Create the first token."
2. **Detail**: two columns from 640px (facts left, trade sheet right), one column below.
   Facts as `receipt-lines`: Price · Market cap · Sold · Raised · Graduates at $100,000 · Creator ·
   Contract (ArcScan links). The meter is information, not decoration: one 8px ruled bar, ink fill,
   no animation beyond width. Trade sheet = the swap sheet's grammar: Buy | Sell `choice-button`s,
   `AmountField`, receipt (You receive · Price impact · Fee 0.50% · Minimum received), primary button
   with the same state machine as `useSwap` (connect → switch chain → approve USDC once → buy; sells
   need no approval). Slippage comes from the existing settings. After graduation the sheet is
   replaced by one sentence and a "Trade on Swap" button. Below: "Trades" ledger in the
   `ledger-row` grammar.
3. **Create**: a real `<form>`: Name (≤32 bytes), Symbol (≤10 bytes, uppercased), Image URL (optional,
   https only), "Your first buy" USDC amount (optional, explains it happens in the same transaction so
   nobody can buy before you), receipt (Launch fee · You receive · Total), primary "Create token".
   Byte-length validation (not character count). On success route to the new token's detail page.

## Safety rules (non-negotiable)

- `name`, `symbol`, `metadataURI` are attacker-controlled. Render as text only. `metadataURI` is shown
  as an image only if it parses as an `https:` URL; use `<img referrerpolicy="no-referrer"
  loading="lazy" decoding="async">` with fixed dimensions and a monogram fallback on error. Never
  `dangerouslySetInnerHTML`, never follow it as a link without showing the host.
- Symbols are not unique: always show the short contract address next to a launch token, in the token
  picker too, and never resolve a symbol to an address by name.
- The confirm sheet (`src/lib/signingIntent.ts`) must decode `createToken`, `buy` and `sell` into
  receipt lines, like the router calls.

## Definition of done

Typecheck, lint, `bun test` green (new `curve.ts` tests included), production build entry chunk not
larger than +3 KB gzip, accessibility scan 0 violations on list/detail/create, light + dark, 375px and
1180px, keyboard operable. No new dependencies.
