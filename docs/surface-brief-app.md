# Surface brief — Architex app (src/App.tsx: Swap + Pools views)

Scope: the whole product surface (one SPA: Swap view, Pools view with inline add/remove liquidity and positions). Visitor mode: **Operate**.

Audience and job: a USDC holder on Arc with a wallet, swapping or providing liquidity; judges the product by whether the quote appears instantly and the transaction goes through without surprises. Task frequency: several swaps a session; positions checked weekly.

Content/proof: only numbers read from chain (reserves, balances, quotes). No invented stats. Constraints: template stack, Arc Studio watermark stays, no Circle/USDC brand blue, light-only in v1 (declared color-scheme).

Success: land → quote → confirmed swap in under a minute, no dead ends, category-fluent trust in seconds. Untouchable: on-chain math parity, slippage/deadline safety, explorer links. Wrong-feeling: dark neon glass, gradient buttons, crypto hype copy, spinners in content.

## Direction contract

THESIS: Architex is a bank form on white paper, not a trading terminal. Amounts are set as large black numerals on a ruled sheet and the only color on the page is the one button that moves money. It refuses the category default (dark glass card, neon glow, gradient "Swap" pill) and its opposite (pastel neobank blobs).

OWN-WORLD: International Typographic Style. Paper #FFFFFF, ink #000000, four warm-neutral grays (#F1F1EF, #D9D9D6, #6B6B67, #3D3D3A), one accent signal yellow #FFD400, two semantic inks (gain #0B7A3B, loss #C81E1E). Public Sans variable at 400/600, tabular numerals, fixed rem scale 12/14/16/20/28/40. Structure is 1px black hairline rules; no cards, no shadows, no gradients; one 4px radius on every corner; 8px module. Controls: yellow primary, black-outline ghost secondary; pressed/selected invert to solid black with white text. With all copy removed it still reads as a Swiss form.
Raises: accent budget — yellow appears at most three times per screen (from monochrome product marketing). Fixed ink set — nine inks, no alpha tints, states change by ink swap (from the WPA poster). Named states — Enter amount / Quoting / Approve X / Swap / Pending / Confirmed / Failed, each with label + glyph + ink, never color alone (from the cyclorama). One module — 8px and 4px rule every gap and corner (from the drawcord cape). Fixed slots — tabular numerals, ghost "0" in empty fields, instant quote swaps with no counting or reflow (from the seven-segment display). Inversion — pressed and selected controls go solid black (from the one-bit desktop).

STORY: the visitor sees "You pay / You receive", types, watches the receive amount appear as they type, reads rate, price impact, fee and minimum received as receipt lines, presses the yellow button, watches a thin black sweep run along the sheet's top rule while Arc confirms, and gets a "Confirmed" line with an explorer link. Pools is a ruled table; add/remove happen inline under a row.

FIRST VIEWPORT: 56px masthead under a black hairline: "Architex" wordmark left (+ small "Testnet" chip on testnet), Swap | Pools beside it with a 3px black underline on the active view, network state + "Connect wallet" ghost button right. Centered 480px column: the swap sheet. "You pay" (14px gray) → 40px amount numerals left, token selector ghost button right → balance + "Max" under. Black hairline with a 36px square flip button sitting on it. "You receive" mirror. Receipt block: Rate / Price impact / Fee 0.30% / Minimum received / Route in 14px tabular rows separated by #D9D9D6 hairlines. Full-width 56px yellow "Swap" button. Nothing else on the paper.

FORM: Swiss bank annual-report grid (International Typographic Style), candidate 7 of 7 on the ordered grounded list; seed key 039f3941. Signature interaction: the flip button rotates 180° and the two amounts exchange in 200ms; the pending sweep is the one authored motion. Motion grammar: 150–250ms, ease-out, reduced-motion swaps to static labels.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## v2 extensions (same world, more information on the sheet)

- Native connect sheet in the popover grammar (EIP-6963 rows, connected view with copy/explorer/balance/disconnect); ConnectKit removed.
- Browser wallet: there is no wallet without keys, so the sheet can make them — "Create a browser wallet" / "Import a private key" when no extension is present; the connected view for that wallet adds "Back up private key" (reveal + copy, with the warning) and a two-step "Forget this wallet". Keys live in this browser's storage only; the copy says so before funding.
- Dark variant = inverted print, following `prefers-color-scheme` (paper↔ink, grays inverted, yellow unchanged with `--on-accent` black ink).
- Shareable swap URL (`#swap?in=&out=&amount=`), remembered pair, ⌘K token picker, Enter-to-act, approve→swap step hint, pool-share context on price impact, human revert copy.
- Recent ledger under the sheet (this browser's confirmed transactions).
- Pool detail: stats receipt + real price-history line from the pair's Sync logs (explorer API, RPC fallback), crosshair/keyboard readout, table view.

## Unresolved

- Protocol fee switch (feeTo) — off until the user decides.
- Mainnet deployment — user's explicit go.
