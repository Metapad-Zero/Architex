---
name: Architex
description: A ruled-sheet DEX interface on white paper: large tabular amounts, black hairlines, one yellow button that moves money.
colors:
  paper: "#ffffff"
  ink: "#000000"
  warm-gray-100: "#f1f1ef"
  warm-gray-300: "#d9d9d6"
  warm-gray-500: "#6b6b67"
  warm-gray-700: "#3d3d3a"
  signal-yellow: "#ffd400"
  on-accent: "#000000"
  gain-green: "#0b7a3b"
  loss-red: "#c81e1e"
typography:
  amount:
    fontFamily: "Public Sans Variable, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
    fontVariation: "tabular-nums"
  headline:
    fontFamily: "Public Sans Variable, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Public Sans Variable, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Public Sans Variable, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    fontVariation: "tabular-nums"
  label:
    fontFamily: "Public Sans Variable, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.5
  caption:
    fontFamily: "Public Sans Variable, Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  control: "4px"
spacing:
  half: "4px"
  unit: "8px"
  one-half: "12px"
  double: "16px"
  two-half: "20px"
  triple: "24px"
  three-half: "28px"
  quadruple: "32px"
  six: "48px"
  eight: "64px"
components:
  button-primary:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.on-accent}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 20px"
    height: "56px"
  button-primary-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 20px"
    height: "56px"
  button-primary-loading:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 20px"
    height: "56px"
  button-primary-disabled:
    backgroundColor: "{colors.warm-gray-100}"
    textColor: "{colors.warm-gray-500}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 20px"
    height: "56px"
  button-ghost:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  button-ghost-hover:
    backgroundColor: "{colors.warm-gray-100}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  button-ghost-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  button-ghost-disabled:
    backgroundColor: "{colors.warm-gray-100}"
    textColor: "{colors.warm-gray-500}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  button-ghost-wrong-network:
    backgroundColor: "{colors.signal-yellow}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  button-ghost-destructive:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.loss-red}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  button-choice:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "44px"
  button-choice-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "44px"
  button-icon:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    size: "44px"
  amount-field:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.amount}"
    padding: "28px 0"
    height: "56px"
  field-with-suffix:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "44px"
  token-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "56px"
  token-row-hover:
    backgroundColor: "{colors.warm-gray-100}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "56px"
  token-row-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "56px"
  token-mark:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.control}"
    size: "24px"
  testnet-chip:
    backgroundColor: "{colors.warm-gray-100}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.control}"
    padding: "2px 8px"
  popover:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    width: "320px"
  connect-sheet:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "16px"
    width: "320px"
  inline-form:
    backgroundColor: "{colors.warm-gray-100}"
    textColor: "{colors.ink}"
    padding: "16px"
  hint-line:
    backgroundColor: "transparent"
    textColor: "{colors.warm-gray-500}"
    typography: "{typography.label}"
    padding: "12px 0 0"
  ledger-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "8px 0"
    height: "48px"
  skeleton:
    backgroundColor: "{colors.warm-gray-100}"
    rounded: "{rounded.control}"
    height: "20px"
---

# Design System: Architex

## Overview

**Creative North Star: "The Swiss Settlement Sheet"**

Architex is an International Typographic Style bank form on white paper, not a trading terminal. Amounts are set as large black tabular numerals on a ruled sheet; the only color on the page is the one button that moves money. Its visual authority comes from exact alignment, legible named transaction states, and amounts that never reflow, rather than from category spectacle (dark glass cards, neon glow, gradient pills) or its opposite (pastel neobank blobs). Public Sans, black hairlines, four warm grays and tabular figures make the product read as a familiar form in seconds while keeping an editorial rigor. With all copy removed it should still read as a Swiss form.

The system is one sheet printed two ways. `color-scheme: light dark` is declared on `:root` and in `index.html`; under a dark system preference the same sheet prints in negative through `light-dark()` (paper and ink swap, the four grays invert, gain and loss lighten), while signal yellow stays yellow and keeps its fixed black ink (`--on-accent`). There is no theme toggle and no dark-specific layout: every rule, hairline and inversion below reads identically in either print. White paper and black ink carry nearly the entire interface; signal yellow is reserved for the action that moves money or resolves a wrong-network state. Structure is exposed instead of boxed: the swap sheet, receipt lines, recent ledger, pool table, pool detail, positions list, inline add/remove forms and the connect sheet all share one ruled-sheet grammar. Every status combines wording, a glyph or rule, and semantic ink, so meaning never depends on color alone.

Tokens live as CSS custom properties on `:root` in `src/index.css` (`--paper`, `--ink`, `--g100` … `--g700`, `--accent`, `--on-accent`, `--gain`, `--loss`, `--radius`, `--unit`) and are mapped one-to-one into Tailwind in `tailwind.config.js`; the dark values are `light-dark()` overrides on the same properties under `@supports (color: light-dark(#000, #fff))`, so browsers without `light-dark()` receive the light print. Reusable component classes are authored under `@layer components` in the same stylesheet; components apply those classes rather than ad-hoc utilities.

**Key Characteristics:**

- White paper, black ink, and a warm-neutral gray hierarchy; nine opaque inks per print, no alpha tints.
- One sheet, two prints: the dark variant is the light sheet in negative, following the system preference; yellow and its black ink are the only fixed colors.
- One 4px corner on every rounded surface over an 8px spatial module.
- Large tabular amounts held in fixed-height fields so quotes swap in without counting or reflow; receipt rows are one line at every width.
- 1px hairline rules instead of cards, shadows, gradients, or glass; a single-series price line drawn in the page's own ink.
- Yellow is a scarce transaction signal; pressed and selected controls invert to solid ink with paper text.
- Motion is short and mechanical (150–250ms, `cubic-bezier(0.2, 0, 0, 1)`); the one authored motion is an ink rule-sweep along a sheet's top rule while the chain confirms.
- The keyboard is a first-class instrument: ⌘K/Ctrl+K, Enter, Escape and arrow keys drive the sheet without a pointer.

## Colors

The palette is a fixed set of nine opaque inks in each print, plus one fixed black for text on yellow: paper and ink establish the document, four warm grays organize hierarchy, yellow signals the next consequential action, and green/red report transaction outcomes. The frontmatter carries the light print; the dark print for each token is recorded beside it below and in the sidecar.

### Primary

- **Signal Yellow** (`signal-yellow`, `--accent`): The primary transaction button at rest (Connect wallet / Approve X / Swap / Add liquidity / Remove liquidity), the wrong-network wallet button as a deliberate intervention, and browser text selection (`::selection`). It never decorates; it always marks the thing to act on. It is the same yellow in both prints. The favicon carries the same yellow bar on black.
- **On-Accent Ink** (`on-accent`, `--on-accent`): Black, fixed in both prints. The only ink ever set on a Signal Yellow ground: the primary button label, the wrong-network label, and selected text. In the light print it coincides with Ink; in the dark print it is the one place black text survives, because yellow-on-black needs black-on-yellow to stay legible.

### Secondary

- **Gain Green** (`gain-green`, `--gain`; dark print #4fcf7f): Confirmed transaction lines only: the check glyph, the summary text ("Swapped 0.5 WETH for 1,251.20 USDC"), and the explorer link that follows it.
- **Loss Red** (`loss-red`, `--loss`; dark print #ff6b62): Failed transaction lines (X glyph + "Failed · reason"), over-balance amount numerals and their "Not enough X" balance line, "Not enough LP tokens", the "High price impact" receipt value above 5%, the connect sheet's form and unlock errors ("A private key is 64 hex characters, with or without 0x.", "Use at least 8 characters.", "The two passwords differ.", "Passkey request cancelled.", "That password did not unlock the wallet.") and the confirm sheet's ("That password did not unlock the wallet.", "Passkey request cancelled. Try again or cancel below."), each a 14px sentence with `role="alert"` under its field, and the label of the one destructive confirm ghost, "Forget for good".

### Neutral

- **Paper** (`paper`, `--paper`; dark print #000000): The page, every control at rest, popovers, bottom sheets and the connect sheet, the scrollbar track, and the 2px ring around price-history markers.
- **Ink** (`ink`, `--ink`; dark print #ffffff): All primary copy, black hairline rules, control outlines, the 3px active-tab underline, the focus outline, the caret, form-control `accent-color`, every inverted (pressed / selected / loading) surface, the price-history series, its markers and its crosshair.
- **Warm Gray 100** (`warm-gray-100`, `--g100`; dark print #161616): Hover fills on ghost, icon, choice and nav controls and token or wallet rows; the inline add/remove liquidity form background; the Testnet chip fill; disabled control fills; the skeleton's resting tone.
- **Warm Gray 300** (`warm-gray-300`, `--g300`; dark print #2e2e2c): Secondary hairlines between receipt rows, ledger rows, table rows, price-table rows, position rows and around empty states; the price-history grid lines; the suffix divider inside compact fields; disabled outlines and the disabled flip glyph; the scrollbar thumb; the skeleton's pulse peak.
- **Warm Gray 500** (`warm-gray-500`, `--g500`; dark print #9c9c98): Field labels ("You pay"), balance and USD lines, receipt keys, table headings, section counts, placeholders, ghost dashes and ghost zeros, empty-state and helper copy, disabled text, the network name in the masthead, the step hint under the primary button, the "Connected wallet" / "Browser wallet" labels, the "Detected" status, the browser wallet's short address in its row, the "Private key", "Unlock with", "Wallet password" and "Repeat password" labels in the connect sheet and the confirm sheet's "Signing as 0x7212…1D46 · browser wallet" footer, ledger timestamps, the price-history heading and axis text, and the loading state of the price series and markers.
- **Warm Gray 700** (`warm-gray-700`, `--g700`; dark print #c9c9c5): Explanatory messages that need more weight than metadata: the quote message under the receipt ("Not enough liquidity in this pool for that amount."), the pending and cancelled transaction lines, the "You are creating this pool" note, and connect-sheet messages ("No wallet extension found…", "Request rejected in your wallet."), including the browser wallet's custody sentences, the protection sentence under its create/import form, the confirm sheet's note and passkey sentence, the "Private key — never share it." warning, the "Forget this wallet" text link and its confirm sentence.

### Named Rules

**The Nine-Ink Rule.** Use the fixed opaque palette; do not create alpha tints, near-duplicate grays, or decorative colors. State changes are ink swaps (paper → gray 100 → ink), never opacity changes. Each print has exactly nine inks; the dark print is a value swap on the same nine tokens, not a tenth color.

**The Three-Signal Rule.** Signal yellow appears at most three times on a screen and must correspond to the money-moving action, a wrong-network intervention, or text selection. Typical screens carry one yellow surface.

**The Meaning-Plus-Ink Rule.** Green and red reinforce an explicit label and glyph; color never carries transaction meaning by itself.

**The Inverted-Print Rule.** The dark variant is the light sheet in negative and nothing more: it is produced by `light-dark()` on the existing tokens, follows `prefers-color-scheme` with no in-app toggle, and changes no layout, hairline weight, motion or component. Signal Yellow and On-Accent Ink are the only tokens that do not flip. Anything on a yellow ground uses `--on-accent`, never `--ink`.

**The Own-Ink Chart Rule.** Data visualisation draws with the page's own inks: the series, markers and crosshair are Ink, the grid is Warm Gray 300, axis text is Warm Gray 500, and loading dims the series to Warm Gray 500. There is no categorical palette and no fill under the line.

**The Destructive-Confirm Rule.** A destructive action is never a primary or a plain ghost: it is a 14px underlined text link in Warm Gray 700 ("Forget this wallet") set behind a Warm Gray 300 hairline below the last ordinary action, and it confirms in two steps. The second step carries all three of a one-sentence consequence in Warm Gray 700 ("This deletes the encrypted key from this browser. Without a backup the wallet is gone for good.", or for a passkey-derived wallet "This removes the wallet from this browser. Your passkey can sign in again; without the passkey or a backup the wallet is gone for good."), Loss Red on the confirming label ("Forget for good"), and an equal-width return path ("Keep it"). Loss Red on a control label is reserved for this confirm; it never appears on a first-step control.

## Typography

**Display Font:** Public Sans Variable (with Helvetica Neue, Helvetica, Arial, sans-serif), self-hosted via `@fontsource-variable/public-sans` and imported at the top of `src/index.css`
**Body Font:** Public Sans Variable (same stack)
**Label/Mono Font:** Public Sans Variable with `font-variant-numeric: tabular-nums` inherited from `body` into buttons and inputs; no separate monospace face. Wallet addresses are set in the same face, broken with `break-all`.

**Character:** A single-family, two-weight system that reads as administrative rather than promotional. Weight 400 carries content and weight 600 establishes hierarchy; `font-synthesis: none` prevents faux weights. Every figure on the page is tabular so balances, quotes, table values, chart axes and state labels stay spatially stable while the chain answers.

### Hierarchy

The scale is a fixed rem ramp of six sizes: 12 / 14 / 16 / 20 / 28 / 40px.

- **Amount** (600, `amount` 2.5rem, 1.25, -0.025em): The pay/receive numerals in the swap sheet. Below 640px the numerals step down to 1.75rem (the 28px step; a deliberate, recorded choice) while the 56px input height is unchanged. Inside the inline liquidity form the same field renders at the 1.75rem headline size.
- **Headline** (600, `headline` 1.75rem, 1.25, -0.02em): The Pools page title and the amount fields inside inline liquidity forms (without the tracking).
- **Title** (600, `title` 1.25rem, 1.5): The "Architex" wordmark (tracked to -0.03em), section headings ("All pools", "Your positions", "Test tokens", "Recent"), the "Add liquidity" / "Remove liquidity" headings inside expanded rows, the connected wallet's full address in the connect sheet (line-height 1.25, tracked -0.01em, wrapped `break-all` under a 14px "Connected wallet" or "Browser wallet" label), and the confirm sheet's action heading ("Swap", "Approve WBTC"; the same line-height and tracking).
- **Body** (400, `body` 1rem, 1.5): Default copy, the primary button label (600), the token-selector trigger, popover and connect-sheet headings ("Connect a wallet", 600), wallet names in connect rows (600, including the "Browser wallet" row), and compact field inputs.
- **Label** (600, `label` 0.875rem, 1.5): Ghost, choice and nav-tab labels, token symbols in rows, the "Max" link, explorer links, ledger "View" links, the current price reading in the price-history head, the "Browser wallet" block heading in the connect sheet's empty face, and the revealed private key (14px semibold, line-height 1.375, `break-all`). The same 14px size at weight 400 in Warm Gray 500 is the metadata voice: field labels, balances, receipt keys, table headings, helper copy, the step hint, chart headings, the "Show as table" toggle (in Ink, underlined), and the "Forget this wallet" and "Import a private key" links (in Warm Gray 700, underlined).
- **Caption** (400, `caption` 0.75rem, 1.5): Token names under symbols, position sub-lines ("12.5 LP", "Pooled amounts"), the slippage explanation, ledger relative times ("2 min ago"), and the price-history axis text (12px, tabular). At weight 600 it is the Testnet chip and the two-letter token or wallet monogram.

### Named Rules

**The Fixed-Slot Rule.** Every number is tabular; empty amount fields show a ghost "0" in Warm Gray 500; the receipt block always renders its five rows (Rate / Price impact / Fee / Minimum received / Route) with a ghost "—" until a quote exists, so nothing counts, jitters or reflows while the user types. A receipt row is one line at every width: keys never wrap (`dt` nowrap), values never wrap and clip with an ellipsis (`dd` nowrap + ellipsis), and a value that would not fit below 640px is written in its short form ("9.06% · High impact · 10% of pool") rather than allowed to grow the row.

**The Two-Weight Rule.** Use only regular (400) and semibold (600); hierarchy comes from size, placement and rules before weight proliferation.

**The Plain-Sentence Rule.** Guidance under a control is one quiet sentence in the metadata voice, never a title, badge or kicker: "Step 1 of 2 — approve USDC once, then swap." / "Step 2 of 2 — approved. Swap when you are ready." / "The pool moved while you were reading. Check the new amounts, then swap again." Revert reasons and empty states are written the same way ("No trades yet — the first swap starts the price history."). Custody copy follows the same rule and states the custody fact and what approves each signature before the wallet can be funded: "Your passkey is the wallet: the key is derived from it for each signature and never stored. Sign in with it in any browser where it syncs." in the connect sheet's empty face where passkeys are available ("Made on this device and stored encrypted. Every signature asks for your password first, so nothing spends without you." where they are not, or once Password is chosen), and over the connected browser wallet "This wallet is your passkey: the key is derived from it for each signature and never stored. Lose the passkey and the wallet goes with it, so back up the key before you fund it." for a passkey-derived wallet or "The key is stored encrypted on this device and your passkey unlocks it for each signature; nothing spends without that. Clearing site data deletes the wallet, so back up the key before you fund it." ("your password" for a password wallet) for a stored key; a sentence in Warm Gray 700, never a warning badge or icon. The confirm sheet speaks the same way: its passkey line is "Your passkey approves this one signature; the key is not kept afterwards." and its footer is "Signing as 0x7212…1D46 · browser wallet".

## Layout

The interface follows an 8px module (`--unit`) with 4px half-steps where dense rows or mobile controls need them; observed gaps are 4, 8, 12, 16, 20, 24, 28, 32, 40, 48 and 64px. The masthead is a 56px band closed by a black hairline, with 16px side padding rising to 24px from 640px. The Swap task is a single centered column capped at 512px including 16px gutters (a 480px sheet), starting 48px below the masthead on compact screens and 64px from 640px, with 144px of bottom padding so the sheet clears the fixed watermark. The recent ledger sits 56px beneath the sheet as its own ruled section. The Pools task widens the same grammar to 1008px with 16px / 24px gutters and 40px between the page title and the first section.

Hairlines define regions: a black rule opens every major section (the swap sheet, the recent ledger, "All pools", "Your positions", an expanded row's stats receipt and price history, an expanded row's form) and frames consequential controls; Warm Gray 300 rules separate repeated rows (receipt lines at 40px minimum, ledger rows at 48px minimum, table rows, price-table rows, position rows). The swap sheet's tools (settings) sit in a `sheet-tools` seat at the right end of its top rule, centered on the rule by a half-height upward translate; the flip button sits centered on the rule between the two amount fields. Amount fields keep 28px vertical padding and a 56px numeral line, and the field and its input are `min-width: 0` so a long numeral compresses instead of pushing the token trigger out of the sheet. The receipt block's five fixed rows keep the primary button stationary while local quotes resolve; the step hint, when present, is one 24px line 12px under the button. Liquidity actions expand inline beneath their pool or position row: first a two-column pool detail (stats receipt left, price history right; `minmax(0,1fr) minmax(0,1.4fr)` from 640px with a 40px gap, one column with a 24px gap below, 32px bottom padding), then the Warm Gray 100 form. The pools table rules its numeric columns to fixed widths (TVL 160px, Reserves 224px) so figures align down the sheet regardless of pair-name length; there are no task modals.

Popover placement is one rule for every floating surface: 8px below its trigger, right-aligned to it, never closer than 16px to the viewport edge, 320px wide (the token picker grows from 320px to fit; the settings and connect sheets are fixed at 320px). The connect sheet's height cap has two owners: from 640px the anchored popover takes an inline, viewport-relative `max-height: calc(100dvh − top − 16px)` (applied only when `(min-width: 640px)` matches); below 640px the stylesheet's bottom-sheet cap `min(70dvh, 560px)` governs. Either way the sheet scrolls its own content (`overflow-y: auto`), so the browser-wallet faces stay inside one outlined panel.

Responsive rules, as built:

- **≤ 639px:** amount numerals drop to 1.75rem; anchored popovers (token picker, settings, connect sheet) become bottom sheets inset 16px from the viewport edges with a maximum height of `min(70dvh, 560px)`; receipt values switch to their short form; the pool detail stacks to one column; the pools table hides its header row and each pool becomes a two-line record (pair + TVL on line one, reserves joined with " · " in Warm Gray 500 on line two); position rows hide their pooled-amount and share columns behind the disclosure; the primary button is full-width (from 640px it is auto-width with a 224px minimum in liquidity forms).
- **≤ 479px:** the Testnet chip and the wallet-button glyph disappear, masthead padding tightens to 12px, the wordmark drops to 1rem, tabs keep a 44px minimum width.
- **≥ 1024px:** the network name ("Arc Testnet") appears beside the wallet button.
- Every interactive control keeps a 44px minimum target; the primary button is 56px tall.

**The One-Module Rule.** Derive layout, gaps and padding from 8px or its 4px half-step; preserve the 12px dense inset only where the implementation already uses it (ghost padding, table cells, compact field inset).

**The Inline-Task Rule.** Swap, add and remove operations remain on one surface; use inline disclosure under a ruled row rather than a task modal. Connecting a wallet is the one floating task, and it uses the popover grammar, not a modal; the browser wallet's confirm sheet is the one true modal, because a signature needs protected focus and a scrim, and it exists only for that.

## Elevation & Depth

Architex is flat by design and uses no box shadows, gradients or blur anywhere in the system, in either print; the only translucency is the confirm sheet's 40% black scrim, which exists because a signature prompt is the one modal (see Confirm Sheet). Depth is conveyed by ink weight (black rules open sections, Warm Gray 300 rules separate rows), by tonal layering (paper versus a Warm Gray 100 inline form), and by temporary ink inversion on pressed or selected controls. Popovers, bottom sheets and the connect sheet float by placement alone: a paper fill and a single 1px ink outline, with a transparent `::backdrop` (the confirm sheet alone backs itself with the scrim); in the dark print that is white-on-black, and the outline is what separates the sheet from the page. The only animated depth cue is the 2px ink rule-sweep that runs along a sheet's top rule while a transaction is pending.

### Named Rules

**The Ruled-Paper Rule.** Establish hierarchy with hairlines, spacing and tonal blocks; never introduce shadows, gradients, glass or raised cards.

**The Outline-Is-Elevation Rule.** A floating surface earns exactly one 1px ink outline and a paper fill; do not simulate physical lift.

## Shapes

The form language is rectilinear. There is a single radius, 4px (`--radius`, Tailwind `rounded`), and it is applied to every rounded surface: buttons, choice and icon squares, popovers, the connect sheet, compact fields, token and wallet rows, the Testnet chip, skeleton bars and the 24px token monogram. Nothing is pill-shaped or circular except the price-history markers, which are 4px-radius data points (5px when active) on a chart, not controls. Rules are 1px and continuous; the active nav underline is a 3px ink bar inset 8px from the tab edges. Controls use a 1px ink border at rest; the primary button adds a 2px inset ink ring on hover without changing its outer size. Glyphs are 18px (16px inline) open line icons at 1.5px stroke with round caps, drawn as inline SVG in `src/components/Icons.tsx`; they take `currentColor` so they invert with their control. Token identity is a two-letter uppercase monogram in a 24px outlined square, not a logo; wallet identity in the connect sheet is the same square, filled with the connector's own EIP-6963 icon when it provides one and the two-letter monogram when it does not.

**The One-Corner Rule.** Use the shared 4px radius for every rounded surface, including token marks; there is no second radius and no circle among controls. Chart markers are the one round mark, and they are data, not chrome.

**The Hairline Rule.** Default borders and separators are 1px; the 2px focus outline, the 2px primary hover ring, the 2px inset outline on the keyboard-active token row, the 2px price series and the 2px paper ring around chart markers are the only thicker strokes, and each is explicit state or data feedback.

## Components

### Buttons

Buttons feel stamped rather than lifted: flat fills, one hairline, and an instant inversion when pressed.

- **Shape:** 4px corners; 56px primary height, 44px minimum for every other control; 200ms `ease-out` color transitions.
- **Primary** (`button-primary`): Signal Yellow fill, On-Accent (black) text in both prints, 1px ink border, 20px horizontal padding, 16px semibold label. Hover adds a 2px inset ink ring; active inverts to ink with paper text; disabled turns the fill and border Warm Gray 100 with Warm Gray 500 text and a not-allowed cursor. The label is the state: Connect wallet → Switch to Arc Testnet → Enter an amount → No pool for this pair / Not enough liquidity / Not enough USDC → Approve USDC → Approving USDC… → Quote moved — review → Swap / Swap anyway → Swapping…. Liquidity forms use Enter amounts → Approve X → Add liquidity / Create a pool → Adding liquidity…, and Remove liquidity. The confirm sheet's primary reads Confirm with passkey or Confirm → Unlocking…, disabled until a password wallet has a password typed. In the swap sheet, Enter inside either amount field fires the same action when the button is enabled and not loading.
- **Loading** (`button-primary-loading`): The button inverts to solid ink with paper text (`is-loading`, `aria-busy`) while a 2px ink rule-sweep runs along the enclosing sheet's top rule. No spinner is placed inside the button.
- **Step hint** (`hint-line`): A 14px Warm Gray 500 sentence with a 24px line, 12px under the primary button, `role="status"`, present only during a two-step approve → swap ("Step 1 of 2 — approve USDC once, then swap." / "Step 1 of 2 — waiting for the USDC approval to confirm." / "Step 2 of 2 — approved. Swap when you are ready.") or when the quote moved. It is the only copy allowed between the button and the transaction line.
- **Ghost** (`button-ghost`): Paper fill, 1px ink outline, 12px horizontal padding, 8px icon gap, 14px semibold label. Hover fills Warm Gray 100; active inverts to ink and paper; disabled uses a Warm Gray 300 outline, Warm Gray 100 fill and Warm Gray 500 text. Used for the wallet button, token-selector trigger (7rem minimum width, 16px label), "Create a pool", faucet buttons, the external faucet link, and the connect sheet's actions (Copy address / Copied, View on ArcScan, Get MetaMask, a full-width Disconnect, and the browser wallet's Create a browser wallet / Import a private key stacked full-width in an 8px grid, Create wallet / Import wallet (Creating… / Importing…) beside Cancel and Reveal key (Unlocking…) / Cancel as two equal halves, Back up private key (Unlocking… while a passkey answers), Copy key / Copied, and the confirm pair Forget for good / Keep it in a two-column 8px grid). The one destructive variant (`button-ghost-destructive`) is the plain ghost with a Loss Red label, used only for "Forget for good" as the second step of a confirm. When the wallet is on the wrong network the ghost's fill and border become Signal Yellow with On-Accent text (`button-ghost-wrong-network`) and the label reads "Switch to Arc Testnet".
- **Choice** (`button-choice`): Same grammar as ghost at 8px horizontal padding, laid out in equal-column grids (slippage 0.1% / 0.5% / 1%; remove-liquidity 25 / 50 / 75 / 100%; the connect sheet's "Unlock with" Passkey / Password pair, with `aria-pressed`). The selected choice stays inverted ink with paper text.
- **Icon and Flip:** 44px squares. The settings trigger is a ghost square sitting on the sheet's top rule in the `sheet-tools` seat; the close button inside the popover is a borderless icon square that fills Warm Gray 100 on hover. The flip button is a ghost square centered on the rule between the two amount fields; its glyph rotates 180° per press over 200ms, and when disabled the outline and glyph go Warm Gray 300.
- **Text links:** "Max", the reversible rate, "View on ArcScan", the ledger's "View", the pair-contract address and "Show as table" / "Hide table" are underlined inline buttons/links in the inherited ink with a 3px underline offset; "Forget this wallet" is the same underlined link at 14px regular in Warm Gray 700, the only text link that starts a destructive action (see The Destructive-Confirm Rule), and "Import a private key" takes the same treatment as the tertiary path under the connect sheet's two browser-wallet ghosts; "Max", explorer links and ledger links are semibold. External links carry the 16px external glyph after the text.
- **Focus:** Every interactive element receives the global 2px ink `:focus-visible` outline offset 2px.

### Chips

- **Style:** The Testnet chip is Warm Gray 100 with a 1px ink outline, 4px corners, 8px horizontal and 2px vertical padding, 12px semibold text.
- **State:** Static and informational; it hides below 480px to protect masthead priority. It is the only chip in the system.

### Cards / Containers

- **Corner Style:** There are no cards. Swap and pool content is organized as open ruled sections opened by a black hairline (`ruled-section`, `swap-sheet`, `ledger`).
- **Background:** Paper by default; Warm Gray 100 marks the inline add/remove liquidity form (`inline-form`, 16px padding, 24px from 640px).
- **Shadow Strategy:** None; see Elevation & Depth.
- **Border:** 1px ink rules open sections; 1px Warm Gray 300 rules separate repeated rows; empty states are bounded top and bottom by Warm Gray 300.
- **Internal Padding:** Section heading rows are 56px tall; amount fields use 28px vertical padding; expanded pool rows use 24px vertical padding; the connected view of the connect sheet uses 16px all round.

### Inputs / Fields

- **Amount fields** (`amount-field`): Borderless and transparent inside the ruled sheet, `min-width: 0`. A 14px Warm Gray 500 label ("You pay" / "You receive" / "Amount"), then a 56px row with the 40px semibold numeral input on the left and the token-selector ghost on the right, then a 24px metadata row with the USD value left and "Balance 1,250.00 Max" right. The placeholder is a ghost "0"; `inputMode="decimal"`. Over-balance turns the numerals and the balance line Loss Red ("Not enough USDC"). Disabled numerals go Warm Gray 500. The input suppresses its own outline because the caret and the sheet already identify focus. Enter fires the sheet's primary action; ⌘K / Ctrl+K opens the pay-token picker from anywhere on the sheet.
- **Compact fields** (`field-with-suffix`): A 44px paper container with a 1px ink outline and 4px corners, 12px input inset, and a Warm Gray 300 divider before a 14px Warm Gray 500 suffix ("%", "minutes", "LP"). The wallet forms use the same container through `PasswordField` (`src/components/PasswordField.tsx`): a 14px Warm Gray 500 label 4px over the field, and in the suffix slot a "Show" / "Hide" toggle (`field-toggle`) instead of a unit: a button the full height of the field behind the Warm Gray 300 hairline, 12px horizontal padding, 14px semibold Warm Gray 700, Warm Gray 100 on hover, inverted to ink while pressed, carrying `aria-pressed` and `aria-controls` and switching the input between `type="password"` and `type="text"` (spellcheck, autocapitalize and autocorrect off). The private-key import (`import-key`) is one, placeholder "0x… (64 hex characters)", `autocomplete="off"`, focused as it opens; "Wallet password" (`new-password`) and "Repeat password" (`confirm-password`) are `autocomplete="new-password"` when a wallet is made, and "Wallet password" is `"current-password"` when it is unlocked again (`reveal-password` for Reveal key, `current-password` in the confirm sheet). Every one is `required` with a stable `name` and `id`, and every wallet-password form carries `WalletUsernameHint`, a hidden read-only `autocomplete="username"` input with the constant value "Architex browser wallet", so a browser password manager can save and fill the wallet password. Each lives inside a form, so Enter submits.
- **Search** (`token-search`): A 48px row under the popover's top edge closed by an ink hairline, with a 16px search glyph and a borderless 14px input.
- **Error / Disabled:** Errors are explicit red sentences under the field; disabled controls use Warm Gray 100 fills, Warm Gray 300 outlines, Warm Gray 500 text and a not-allowed cursor.

### Logo

The mark is an arch crossed by the accent rule: together they draw the letter A, and the rule is the same ink-and-yellow line the sheets are built on. Three forms, all from `brand/` (the source of truth; `bash scripts/brand-assets.sh` renders everything in `public/` from it):

- **Mark** (`brand/mark.svg`): a 9-unit arch stroke on a 64 grid (`M18 58V28a14 14 0 0 1 28 0v30`), square ends, no fill, crossed by a 60 × 8 rule at y 36. The arch takes the ink of its surface (`currentColor`: black on the light print, white on the dark); the rule is always Signal Yellow and always drawn over the arch.
- **Lockup** (masthead): the mark at 24px, an 8px gap, then "Architex" in the wordmark style. The mark is deliberately taller than the capitals and centred on them, so it reads as an emblem and never as a doubled letter A. Below 480px the mark stands alone at 26px inside a 44px target and the name stays in the accessible tree.
- **App icon** (`brand/icon.svg`): white arch, 8-unit stroke, on a black tile with a 12-unit corner radius; the rule runs edge to edge. Rendered to `icon-32.png`, `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`; `icon-maskable-512.png` keeps the arch inside the maskable safe zone on a full-bleed tile.

The link-preview card (`brand/og.html` → `public/og-2.png`, 1200 × 630) sets the lockup at 148px over the one-line description, a 3px ink rule, and a 22px yellow rule on the bottom edge. Social sites cache cards by URL, so a changed card gets a new file name. Never recolour the arch, never put the rule behind it, never set the mark at cap height beside the wordmark, and never place the yellow rule on a yellow surface.

### Navigation

The 56px masthead holds the logo lockup (the mark plus the semibold "Architex" wordmark, one button back to Swap), the optional Testnet chip, the Swap | Pools tabs, the network name from 1024px, and the wallet ghost button. Tabs are 14px semibold, full masthead height, at least 48px wide (64px from 640px) with 12px horizontal padding; hover fills Warm Gray 100; the active tab carries a 3px ink underline inset 8px from each edge plus `aria-current="page"`. No colored tab state exists. Route changes run through `document.startViewTransition` where supported; the default cross-fade is disabled under reduced motion.

The wallet button (`WalletButton`) is the connect sheet's trigger: a ghost with the 16px wallet glyph and a state label (Connect wallet → Connecting… → 0x7212…1D46, or Switch to Arc Testnet in the yellow wrong-network variant; it reads "Connecting…" for as long as Reown's QR modal is open), `aria-haspopup="dialog"`, `aria-controls="connect-sheet"` and `aria-expanded`. Pressing it toggles the sheet; on the wrong network it switches chains instead.

### Token Selector

The trigger is a ghost button with a 24px outlined monogram square, the symbol, and a 16px chevron; the pay-side trigger is marked `data-hotkey="pay-token"` and opens on ⌘K / Ctrl+K. The popover (`token-popover`) is a native `popover="auto"` panel: fixed, paper, one 1px ink outline, 4px corners, at least 320px wide, placed 8px below the trigger, capped at `min(520px, 100dvh − 32px)`. Inside: the search row, then a 4px-padded list of 56px rows (monogram, semibold symbol over a 12px Warm Gray 500 name, right-aligned balance). Hover and keyboard-active rows fill Warm Gray 100; the keyboard-active row also shows a 2px inset ink outline; the selected token inverts to ink with paper text. Escape closes and returns focus to the trigger. Below 640px it becomes a bottom sheet inset 16px with a `min(70dvh, 560px)` height cap. "No matching tokens." is the empty result.

### Settings Popover

Same panel grammar at a fixed 320px, anchored to the right edge of the settings square. A 16px semibold "Swap settings" heading row closed by an ink hairline, then 16px-padded fieldsets separated by 24px: Slippage (three choice buttons, a compact "%" field, a 12px Warm Gray 500 explanation) and Deadline (a compact "minutes" field).

### Connect Sheet

The connect sheet (`connect-sheet`) is the native wallet dialog in the popover grammar: a `popover="auto"` panel with `role="dialog"`, paper fill, one 1px ink outline, 4px corners, fixed at 320px, placed 8px below the wallet button and right-aligned to it (never closer than 16px to the viewport edge), a bottom sheet below 640px. It has two faces, and the browser wallet adds a ruled block to each:

- **Choosing** ("Connect a wallet", a 16px semibold heading row with 16px / 12px padding closed by an ink hairline): the 4px-padded `token-list` always renders; EIP-6963 connectors are listed in it as `token-row`s, each a 24px monogram square (the connector's icon, or its two-letter monogram), the wallet name in 16px semibold, and a right-aligned 14px Warm Gray 500 status ("Detected" → "Connecting…", `aria-busy`). A browser wallet that already exists is one more row, named "Browser wallet", with its short address ("0x53e2…FBfC") as the status. The list always ends with the dedicated WalletConnect row: the same `token-row` with the monogram "WC", the name "WalletConnect" in 16px semibold and the status "Phone wallet" where injected rows say "Detected"; it exists before its connector does, and the WalletConnect connector is filtered out of the generic rows so it never appears twice. Hover fills Warm Gray 100. A failed WalletConnect attempt is a 14px Loss Red sentence (`role="alert"`) 12px under the rows at the 16px inset. With no injected wallet, a Warm Gray 700 sentence in a 16px / 12px inset ("No wallet extension found. Use a phone wallet above or a browser wallet below, or install MetaMask or Rabby and reload.", or "No wallet extension found. Your browser wallet is above." once one exists) with the "Get MetaMask" ghost link 12px under it follows the list; rejection and connector errors from the listed rows are a Warm Gray 700 sentence in the same inset.
- **Browser wallet block** (choosing face, only while no browser wallet exists): a ruled block under the rows, opened by an ink hairline, 16px padding all round: a 14px semibold "Browser wallet" heading, then the custody sentence 4px under it in 14px Warm Gray 700 on a 24px line, which follows the protection in play: "Your passkey is the wallet: the key is derived from it for each signature and never stored. Sign in with it in any browser where it syncs." where passkeys are available, in the menu and while Passkey is chosen in the create form; "The imported key is stored encrypted in this browser, and your passkey unlocks it for each signature, so nothing spends without you." in the import form with Passkey chosen; and "Made on this device and stored encrypted. Every signature asks for your password first, so nothing spends without you." where passkeys are not available or once Password is chosen. 12px under it the menu is an 8px stack: a full-width ghost "Sign in with passkey" (only where passkeys are available; "Waiting for your passkey…" with `aria-busy` while the browser's own passkey chooser is up), a full-width ghost "Create a browser wallet", any sign-in error as a 14px Loss Red `role="alert"` sentence ("No passkey was chosen. New here? Create a browser wallet.", "That passkey protects an imported key in the browser that made it, so it cannot sign in here."), and last the tertiary path, "Import a private key", as a 44px-tall 14px underlined Warm Gray 700 text button (3px underline offset, left-aligned, the same treatment as "Forget this wallet"). Create or import swaps the menu for an inline form 12px under the sentence, its groups 12px apart: for import, the "Private key" field (placeholder "0x… (64 hex characters)", focused as it opens); where passkeys are available, an "Unlock with" fieldset (14px Warm Gray 500 legend, a two-column 8px grid of choice buttons "Passkey" / "Password", Passkey selected by default; without them the form is password-only and the fieldset is absent); for Password, a "Wallet password" field and 8px under it a "Repeat password" field (`autocomplete="new-password"`, the first focused as a create form opens), each with its Show / Hide toggle; then 8px below a 14px Warm Gray 700 sentence for the chosen protection ("At least 8 characters. There is no reset: without the password the wallet cannot be unlocked." / for a created passkey wallet "Touch ID, Face ID or a security key makes the wallet and approves each signature. The same passkey signs you in on your other devices." / for an imported key "Touch ID, Face ID or a security key unlocks each signature. The imported key stays encrypted in this browser."), an optional 14px Loss Red `role="alert"` sentence 8px under it ("Use at least 8 characters.", "The two passwords differ.", "A private key is 64 hex characters, with or without 0x.", "Passkey request cancelled."), and two equal ghosts 12px below, "Create wallet" / "Import wallet" ("Creating…" / "Importing…" while busy) beside "Cancel". Create with a passkey registers the passkey on the press and derives the wallet from it, storing no key; create with a password and every import encrypt the key (an import behind a passkey registers its own wrapping passkey on the press); each connects at once.
- **Connected** (16px padding): a 14px Warm Gray 500 label ("Connected wallet", or "Browser wallet" when the local connector is active) over the full address at the 20px title step (semibold, 1.25 line-height, -0.01em, `break-all`), then a wrapping row of ghost actions 8px apart ("Copy address" → "Copied" for 1.5s, "View on ArcScan" with the external glyph), then a `receipt-lines` list (Network / USDC balance formatted with the balance's own decimals, ghost "—" until read, and for the browser wallet a third row, Unlocked by — Passkey for both passkey kinds, or Password), then a full-width "Disconnect" ghost, disabled while wagmi is still restoring a session after a reload (`isReconnecting`), because a disconnect during the restore would be undone when it lands. Each group is 16px below the last.
- **Browser wallet custody** (connected face, local connector only), between the receipt and Disconnect: an ink hairline with 16px above and below, the connected custody sentence in 14px Warm Gray 700, one per custody kind ("This wallet is your passkey: the key is derived from it for each signature and never stored. Lose the passkey and the wallet goes with it, so back up the key before you fund it." for a passkey-derived wallet; "The key is stored encrypted on this device and your passkey unlocks it for each signature; nothing spends without that. Clearing site data deletes the wallet, so back up the key before you fund it." for an imported key behind a passkey, "your password" for a password wallet), and a "Back up private key" ghost 12px under it. The key is derived or decrypted before it is shown: either passkey kind asks the authenticator on the press (the ghost reads "Unlocking…" meanwhile, and a refusal shows "Passkey request cancelled." in Loss Red 8px under it); a password wallet swaps the ghost for a "Wallet password" field with its Show / Hide toggle (`reveal-password`, focused as it opens), an optional Loss Red `role="alert"` sentence 8px under it ("That password did not unlock the wallet."), and two equal ghosts 12px below, "Reveal key" ("Unlocking…") / "Cancel". Reveal then replaces the control with a 14px Warm Gray 700 warning ("Private key — never share it. Anyone holding it controls the wallet."), the key 4px under it at 14px semibold `break-all` (line-height 1.375), and a "Copy key" ghost 12px below ("Copied" for 1.5s). Nothing in the reveal is colored: the key is ink on paper.
- **Forget** (connected face, local connector only), 12px under Disconnect behind a Warm Gray 300 hairline with 12px padding above: "Forget this wallet" as a 14px underlined Warm Gray 700 text link. Pressing it swaps in the confirm: "This deletes the encrypted key from this browser. Without a backup the wallet is gone for good." (for a passkey-derived wallet, "This removes the wallet from this browser. Your passkey can sign in again; without the passkey or a backup the wallet is gone for good.") in 14px Warm Gray 700, and 8px under it a two-column 8px grid of ghosts, "Forget for good" with a Loss Red label and "Keep it". Forget for good disconnects, deletes the keystore entry and closes the sheet; Keep it returns to the link.

An extension connection closes the sheet on its own, and so does a successful "Sign in with passkey", because a returning owner has met the custody terms already; a wallet created or imported here connects but keeps the sheet open, so the owner meets the custody sentence and "Back up private key" before anything else. The sheet body mounts fresh on every open, so import, reveal and confirm states never leak between opens. Escape always closes it and returns focus to the wallet button; light-dismiss falls back to an outside-click listener where the Popover API is absent. The sheet shows itself synchronously once its position is committed (`showPopover()` inside an effect, no animation frame in between), so a hidden or throttled tab never delays a dialog.

The WalletConnect row (`src/lib/walletConnect.ts`) connects a phone wallet by QR code or deep link through Reown's relay, using wagmi's `walletConnect` connector with `showQrModal: true`. Pressing the row closes the connect sheet first, then connects: Reown's QR modal is an ordinary element, and nothing ordinary can draw above a top-layer popover. Closing the QR modal is a silent cancel; any other failure reopens the sheet with the message in Loss Red under the rows. The connector joins the wagmi config on demand (`ensureWalletConnectConnector`), and at startup only when this browser's last connection was WalletConnect (`hadWalletConnectSession` in `src/config.ts`, so the session is restored after a reload), which keeps the large provider and modal chunks lazy. The Reown project id is a public identifier with a default in source, overridable by `VITE_REOWN_PROJECT_ID`; `public/icon-512.png` (the app icon: white arch and yellow rule on black; most wallets cannot draw SVG, so the PNG is listed before `icon.svg`) is what wallets show in their connection prompt.

Reown's QR modal is a third-party surface, themed but not part of the Architex component system: Public Sans as its font family, a 1px container radius, `z-index` 2147483000, `themeMode` following `prefers-color-scheme` at the moment the connector is made, and an accent of #000000 in the light print only. The accent also colours the QR dots, which sit on a white card in both themes, so the dark print keeps Reown's default accent to stay scannable. Its layout, overlay, radius, icons and motion are Reown's own; none of them is precedent for an Architex surface, and the One-Corner Rule's 4px still governs everything Architex draws.

The browser wallet itself is a viem private key held under one of three custody kinds, recorded in `localStorage` under `architex.wallet.keystore` (`src/lib/keystore.ts`, `src/lib/localWallet.ts`). `passkey-derived` is the default for Create with a passkey and for sign-in: the key is derived from the passkey's WebAuthn PRF output (fixed PRF salt `architex:wallet:v1`, then HKDF-SHA-256 with salt `architex:wallet:hkdf:v1` and info `secp256k1:<counter>`, range-checked against the secp256k1 order) and is never stored; the entry is only a public hint (`version` 1, `kind`, `address`, `credentialId`, `rpId`), so clearing site data removes the hint, not the wallet. The derivation constants are frozen and pinned by a test vector in `src/lib/__tests__/keystore.test.ts`. `passkey` is an imported key kept as AES-256-GCM ciphertext (`salt`, `iv`, `ciphertext`, `credentialId`, `rpId`) wrapped by HKDF-SHA-256 over the PRF output with a per-keystore random salt; `password` is a created or imported key kept as ciphertext wrapped by PBKDF2-SHA-256 with the per-keystore salt and `iterations` 600,000; for these two the ciphertext is the only copy, and clearing site data deletes the wallet. `isPasskeyKind()` groups the two passkey kinds for the interface. Every passkey is a resident credential with user verification required, so the page cannot derive or decrypt on its own, and its user handle is purpose-tagged in its first four bytes (`atx1` wallet, `atxw` wrap) so sign-in refuses a wrapping passkey. `passkeysAvailable()` requires a secure context and a user-verifying platform authenticator and also consults `PublicKeyCredential.getClientCapabilities()`, hiding the Passkey option when `extension:prf` is false; `labelWalletPasskey()` renames a new wallet passkey to "Architex 0x1234…abcd" through the WebAuthn Signal API (`signalCurrentUserDetails`) where it exists. Sign-in (`signInWithPasskey`) runs a discoverable-credential `navigator.credentials.get` (empty `allowCredentials`, user verification required), so the browser's own passkey chooser picks the wallet, then stores the hint; every later unlock of a derived wallet pins the assertion to the stored `credentialId` and checks that the derived address equals the stored one ("That passkey belongs to a different wallet."). Only the address and the protection kind live in React state (`useLocalWallet`); an unlock (`unlockLocalWallet`) derives or decrypts the key for one signature or one reveal and the caller drops it. The `local` wagmi connector (`src/lib/localWalletConnector.ts`, named "Browser wallet") reads the address at connect time, asserts that a transaction's `from` or a signer address matches the wallet, then routes every signing method (`eth_sendTransaction`, `eth_signTypedData_v4`, `personal_sign`) through `requestUnlock()` in `src/lib/unlock.ts`, which the confirm sheet answers one request at a time in arrival order; it refuses `eth_sign` and `eth_signTransaction`, forwards every other call to the chain RPC, follows the app chain and cannot switch. A known testnet key is seeded into storage once by `seedLocalWallet`, password-protected like any other wallet, called only from a statically dead `import.meta.env.DEV` branch in `src/config.ts`; the seed also clears the retired plaintext slot, and a wallet forgotten in this session is not re-seeded (`sessionStorage` `architex.wallet.forgotten`); the `architex:wallet` event refreshes every reader. Arc Studio's trace panel and console capture are likewise dev-only dynamic imports.

### Confirm Sheet

The confirm sheet (`unlock-sheet`, `src/components/UnlockSheet.tsx`, mounted once in `src/main.tsx`) is the browser wallet's signing prompt and the one true modal in the system: a `popover="manual"` panel with `role="dialog"`, `aria-modal="true"`, labelled by its heading, paper fill, one 1px ink outline, 4px corners, `z-index` 60 above every popover, centered in the viewport at `min(400px, 100vw − 32px)` wide and capped at `calc(100dvh − 32px)` from 640px, and the same 16px-inset bottom sheet as the popovers below 640px (`min(70dvh, 560px)`). Its `::backdrop` is a 40% black scrim (`rgb(0 0 0 / 0.4)`, the same in both prints), the only translucent surface in the system. It opens synchronously (`showPopover()` in an effect, no animation frame) whenever the local connector needs a signature or the connect sheet needs the key, one request at a time in arrival order (`requestUnlock` in `src/lib/unlock.ts`), and its body remounts per request so no password or error leaks between them. It never appears for an external wallet, injected or WalletConnect: the wallet itself confirms.

The body (16px padding) is a form: the action as a 20px semibold heading (line-height 1.25, -0.01em) that `src/lib/signingIntent.ts` decodes from the request ("Swap", "Approve WBTC", "Add liquidity", "Remove liquidity", "Create a pool", "Claim test WETH", "Send WETH", "Approve by signature", "Sign typed data", "Sign message", "Send transaction", "Back up private key"); 12px under it a `receipt-lines` list of exactly what will be signed (You pay / You receive at least / Valid until; Spender / Allowance; Pool / Deposit up to / And up to / At least; Token / Spender / Allowance; Message; To / Value / Data), in the same 14px keys-left values-right grammar as the swap receipt; an optional 14px Warm Gray 700 note 12px below ("Nothing moves yet: this signature lets the spender take up to the allowance in the next step."); then, 16px below, either the passkey sentence in 14px Warm Gray 700 for both passkey kinds ("Your passkey approves this one signature; the key is not kept afterwards.") or a "Wallet password" field with its Show / Hide toggle (`current-password`, `autocomplete="current-password"`, `required`, preceded by the hidden username hint). Errors are a 14px Loss Red sentence 8px under it with `role="alert"` ("That password did not unlock the wallet.", "Passkey request cancelled. Try again or cancel below."). 16px below sits an 8px stack: the full-width primary ("Confirm with passkey" / "Confirm", disabled until a password is typed, "Unlocking…" and inverted while busy) over a ghost "Cancel"; and 12px under that the footer "Signing as 0x7212…1D46 · browser wallet" in 14px Warm Gray 500. Focus moves to the password field or the primary on open and is trapped inside (Tab and Shift+Tab wrap); both skip hidden inputs, so the username hint never takes focus; Escape or Cancel rejects the request with "User rejected the request.", the way an extension wallet would; closing returns focus to the control that asked. The sheet carries no yellow beyond its one primary, and no glyph: the heading and the receipt are the warning.

### Receipt Lines and Transaction Status

Receipt data (`receipt-lines`) is a definition list opened by an ink hairline: 40px-minimum rows separated by Warm Gray 300, 14px throughout, keys in Warm Gray 500 on the left (nowrap), tabular values right-aligned (nowrap, ellipsis). In the swap sheet the five slots are fixed: Rate (an underlined button that reverses the pair), Price impact (Loss Red with " · High price impact" above 5%, and " · 10% of the pool" pool-share context above 1%; below 640px the short form " · High impact · 10% of pool"), Fee 0.30%, Minimum received (or Maximum sent in exact-out mode), Route ("USDC → WETH"). Liquidity forms reuse the same list for Expected LP / Your share and the two "You receive" lines; the pool detail reuses it as a stats receipt (Pair contract as an underlined short address with the external glyph / Price "1 WBTC = 24 WETH" / LP supply "… LP" / Your share "4.2% · 0.1 WBTC + 2.4 WETH" or "None yet"); the connect sheet reuses it for Network / USDC balance. A ghost "—" fills every empty slot.

Transaction status (`tx-line`) is a 32px 14px line under the primary button (and under the step hint when one is present) with a 16px glyph: Pending ("Pending on Arc Testnet" or "Approving USDC…" in Warm Gray 700, with the ink rule-sweep on the sheet), Cancelled ("Transaction cancelled", Warm Gray 700), Confirmed (check glyph, Gain Green summary, "View on ArcScan" link with the external glyph), Failed (X glyph, Loss Red "Failed · reason" in plain words, `role="alert"`).

### Recent Ledger

The recent ledger (`ledger`) is the printed record of what this browser did here: a ruled section 56px below the swap sheet, opened by an ink hairline, with the standard 56px section heading row ("Recent" at the 20px title step, "from this browser" in 14px Warm Gray 500 on the right) and an ordered list of at most five `ledger-row`s newest first. Each row is 48px minimum with 8px vertical padding and a Warm Gray 300 bottom rule: the confirmed summary in 14px on one truncating line over a 12px Warm Gray 500 relative time ("2 min ago", refreshed every 30s), and a right-aligned semibold underlined "View" with the external glyph, 16px from the text. The section is absent, not empty, until the first confirmation.

### Pools, Positions and Empty States

Pools (`pools-table`) is a full-width 14px table opened and closed around its header by ink rules: regular-weight Warm Gray 500 headings (Pool / TVL / Reserves), 12px horizontal and 16px vertical cell padding with the outer gutters removed, tabular right-aligned values in ruled 160px (TVL) and 224px (Reserves) columns, and Warm Gray 300 row separators. The pair name is a 44px toggle with a chevron that rotates 180° over 200ms; an expanded row drops its bottom rule and opens the pool detail (stats receipt and price history, both opened by ink rules) above an ink rule, a 24px-padded "Add liquidity" heading, and the Warm Gray 100 inline form. Positions (`position-row`) are 80px-minimum grid rows (pair + LP amount, pooled amounts, share, chevron) with the same disclosure into a "Remove liquidity" form.

Empty states (`empty-state`) are 128px-minimum bands bounded top and bottom by Warm Gray 300, 28px vertical padding, 14px Warm Gray 500 copy ("No pools yet. Add liquidity to create the first one.", "Connect your wallet to see your positions.") with an optional ghost button; on wide screens copy and button sit on one line, on compact screens they stack. Loading uses skeleton rows (`skeleton`, 4px corners) that pulse between Warm Gray 100 and Warm Gray 300 over 1.4s inside a ruled table shell; there are no spinners in content.

### Price History

The price history (`price-history`) is a single-series line drawn in the page's own inks inside the pool detail. A head row opened by an ink hairline (8px top padding, 32px minimum, baseline-aligned, wrapping) carries "Price history · WETH per WBTC" in 14px Warm Gray 500 on the left and the current reading on the right (the price in 14px semibold, the timestamp 8px after it in Warm Gray 500); the reading follows the crosshair and falls back to the latest point. The plot is an inline SVG 168px tall at the column's width (padding 12 / 12 / 28 / 56px), `role="img"` with a spoken label, `tabIndex=0`, `touch-action: none`, non-selectable: at most three Warm Gray 300 1px grid lines with 12px tabular Warm Gray 500 tick labels right-aligned 8px left of the plot; first and last timestamps at the baseline; the series as a 2px Ink stroke with round joins and caps and no fill; when the series has 24 points or fewer, r=4 Ink markers with a 2px Paper ring at every point; on hover, pointer-down or arrow keys, a 1px Ink crosshair spanning the plot height with an r=5 active marker. Left/Right arrows step the reading; Escape and blur clear it; the crosshair is pointer-following, not animated. Loading dims the series and markers to Warm Gray 500 behind the same head. "Reading the pool's history…" and "No trades yet — the first swap starts the price history." are the 14px Warm Gray 500 sentences shown in place of the plot (24px vertical padding). A right-aligned underlined "Show as table" / "Hide table" (14px, 8px above) toggles a `price-table` under the plot: 14px, 12px top margin, regular Warm Gray 500 headings (Time / Block / unit) on an ink rule, Warm Gray 300 row rules, numeric columns right-aligned, newest first, capped at 50 rows.

### Keyboard

The sheet is fully operable without a pointer, and each shortcut has one meaning: ⌘K / Ctrl+K opens the "You pay" token picker from anywhere; Enter in an amount field fires the primary action when it is enabled; Enter inside the connect sheet's create/import form (private key, wallet password, repeat password) submits it, and inside the confirm sheet's password field confirms; Escape closes any open sheet (token picker, settings, connect) and returns focus to its trigger, rejects the confirm sheet ("User rejected the request.") and returns focus to the control that asked, or clears the chart crosshair; Tab and Shift+Tab wrap inside the confirm sheet while it is open, skipping its hidden username hint; the Show / Hide toggle in a wallet field is an ordinary button in the tab order, never a shortcut; Left/Right read the price history. Focus is always visible through the global 2px ink outline; the keyboard-active token row adds its 2px inset outline. Nothing else is bound.

### Motion

Color and disclosure state changes run for 200ms with `ease-out` or `cubic-bezier(0.2, 0, 0, 1)`; the grammar is 150–250ms, never longer. The flip glyph rotates 180° per press in 200ms; chevrons rotate 180° in 200ms. The one authored motion is the rule-sweep (`rule-sweep`): a 2px-tall ink bar one quarter the sheet's width, sitting on the sheet's top rule (top −1px), translating from −100% to 400% over 1.4s on `cubic-bezier(0.2, 0, 0, 1)`, looping while a transaction is pending. Skeletons pulse over 1.4s `ease-in-out`. Live financial values never animate; quotes swap in whole, the price line redraws without transition, and the crosshair follows the pointer with no easing. Under `prefers-reduced-motion: reduce`, all transitions and animations collapse to 0.01ms and a single iteration, the flip glyph stays unrotated, the rule-sweep is removed from the page, and view transitions are disabled; the named state labels carry the meaning on their own.

### Browser Surfaces

Text selection is Signal Yellow with On-Accent (black) text in both prints; the caret is ink; form-control `accent-color` is ink; scrollbars are thin, Warm Gray 300 on paper (8px WebKit thumb with a 2px paper inset); tap highlights are transparent; `color-scheme` is `light dark` on `:root` and in the document `<meta name="color-scheme">`, so form controls, scrollbars and the canvas follow the same print as the sheet.

## Do's and Don'ts

### Do:

- **Do** make the current task and the next valid action legible before adding any supporting detail; the primary button's label is the state name, and the step hint under it is one plain sentence.
- **Do** keep financial values tabular, stable and traceable to on-chain data; fill empty slots with a ghost "0" or "—" rather than collapsing them, and keep every receipt row on one line (short value form below 640px).
- **Do** separate repeated information with Warm Gray 300 hairlines and open major regions with ink hairlines.
- **Do** use Signal Yellow only for the money-moving action, a wrong-network intervention, or text selection, never more than three times on a screen, and always with On-Accent (black) text on it.
- **Do** pair every pending, confirmed and failed state with a label and a glyph or rule; let ink swaps (paper → Warm Gray 100 → ink) carry hover, pressed and selected states.
- **Do** apply the single 4px radius to every rounded surface, keep 44px minimum targets and the 56px primary button, and honour reduced motion by removing the rule-sweep.
- **Do** let the dark print happen through `light-dark()` on the existing tokens and the system preference; write new colors as `var(--token)` so both prints inherit them.
- **Do** draw charts with the page's inks: Ink series and markers, Warm Gray 300 grid, Warm Gray 500 axis text; give every chart a spoken label, keyboard reading and a table view.
- **Do** state a custody fact as one Warm Gray 700 sentence before a wallet can be funded, and gate every destructive action behind a hairline as a text link with a two-step confirm: a sentence, a Loss Red confirming label, and a "Keep it" return path.

### Don't:

- **Don't** add neon glow, gradients, glass, blur, box shadows, or pastel neobank shapes in either print; the dark variant is the same ruled sheet in negative, not a dark theme.
- **Don't** add a theme toggle, a third color scheme, dark-only layouts, or hard-coded hex values that bypass the `light-dark()` tokens; and never set `--ink` on a Signal Yellow ground, only `--on-accent`.
- **Don't** wrap open ruled sections in cards or floating panels; a popover or sheet gets one 1px outline and nothing else.
- **Don't** invent alpha tints, extra brand colors, categorical chart palettes, area fills under the price line, typefaces, font weights beyond 400/600, a second radius, circles or pills among controls, or spacing off the 8px/4px module.
- **Don't** use Signal Yellow as decoration, on the rule-sweep, or on the loading button; loading is an ink inversion.
- **Don't** animate live financial values or chart series, introduce layout shift while quoting, let a receipt row wrap or grow, or substitute spinners for skeletons and named pending states.
- **Don't** put a title, badge, eyebrow or kicker between the primary button and the transaction line; the step hint is a sentence in the metadata voice.
- **Don't** give a destructive action a primary, a plain ghost, a warning badge or a single step; "Forget for good" is the only Loss Red control label, and it never appears without its sentence and "Keep it".
- **Don't** use hype copy, fabricate financial metrics, or rename product actions with generic labels such as "Submit"; the vocabulary is You pay / You receive / Rate / Price impact / Fee / Minimum received / Route / Swap / Pools / Add liquidity / Remove liquidity / Connect wallet / Connect a wallet / Connected wallet / Copy address / Disconnect / WalletConnect / Phone wallet / Browser wallet / Sign in with passkey / Create a browser wallet / Import a private key / Create wallet / Import wallet / Unlock with / Passkey / Password / Wallet password / Repeat password / Show / Hide / Unlocked by / Back up private key / Reveal key / Copy key / Forget this wallet / Forget for good / Keep it / Confirm with passkey / Confirm / Cancel / Recent / Price history / Show as table.
