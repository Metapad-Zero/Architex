# Architex v2 — "the most beautiful, intuitive DEX UI on any chain"

The v1 world is fixed and documented in `DESIGN.md` (Swiss bank form: white paper, black hairlines,
tabular numerals, one yellow button, nine inks, 4px radius, 8px module). v2 does not change the
world; it makes the instrument smarter, faster, and complete. Every addition must read as the same
sheet with more information on it, never as a new surface.

Non-negotiables carried over: local quoting from reserves, one Lens call per screen, no spinners in
content, no toasts, no modals for tasks, every state has label + glyph + ink, accent budget ≤ 3 yellow
per screen, reduced-motion respected, no invented numbers.

## Division of work

### Grok — wallet in the world's grammar + performance
1. **Replace ConnectKit with a native connect sheet.** wagmi's `injected()` connector already performs
   EIP-6963 discovery (one connector per announced wallet, with `connector.name` / `connector.icon`).
   Build `src/components/ConnectSheet.tsx`: a popover (desktop, anchored under the wallet button, using
   the same `.token-popover` mechanics: native `popover="auto"`, `position: fixed` placement, bottom
   sheet ≤639px) that lists discovered wallets as rows (`.token-row` grammar: icon 24px in a 4px square,
   name, "Detected" in g500), the dev burner when present, and states: connecting (row label
   "Connecting…"), error (one g700 line naming the problem: "Request rejected in your wallet." / "No
   wallet extension found. Install MetaMask, Rabby or another wallet and reload."), connected.
   Connected state of the masthead button: `0x12…abcd` (ENS not available on Arc); clicking opens the
   same sheet showing the full address, "Copy address", "View on ArcScan", native USDC balance
   (`useBalance`), the chain, and "Disconnect". Wrong network keeps the yellow "Switch to Arc Testnet".
   Replace every `useModal().setOpen(true)` (SwapSheet, AddLiquidityForm, PositionRow) with a tiny
   context `src/hooks/useConnectSheet.tsx` (`{ open(), close(), isOpen }`) whose provider mounts in
   `src/main.tsx` in place of `ConnectKitProvider`. Remove all `connectkit` imports. Keep the
   "Built with Arc Studio" watermark exactly as is.
2. **Bundle.** Report `bun run build` sizes before/after. Targets: main entry ≤ 260 KB gzip. Do it with
   (a) no ConnectKit/framer-motion in the graph, (b) `React.lazy` + `Suspense` for `PoolsView` (fallback
   = the existing `TableSkeleton` inside the pools page frame), (c) `build.rollupOptions.output.manualChunks`
   splitting `viem`/`wagmi`/`@tanstack` into a `vendor-web3` chunk. Do not remove packages from
   `package.json` (the Arc Studio sandbox scripts still need them); unused packages are not bundled.
3. **Checks**: `bun run typecheck && bun run lint && bun test && bun run build` green. Do not touch
   `src/index.css` tokens or any component outside the wallet path except the three `setOpen` call
   sites and `main.tsx`. Any new CSS goes in `src/index.css` under `@layer components` using the
   existing tokens (`--paper --ink --g100 --g300 --g500 --g700 --accent --gain --loss`, radius 4px).

### Claude — the instrument
- Shareable, remembered state: `#swap?in=WBTC&out=WETH&amount=0.01` (read on load, `replaceState` on
  change; last pair remembered in localStorage).
- Price impact context ("uses 10% of the pool"), approve→swap step line ("Step 1 of 2 — approve WBTC,
  then swap."), human revert copy.
- Printed receipts: a "Recent" ledger under the sheet (last 5 confirmed transactions from this browser,
  amounts, time, explorer link).
- Pool detail (`#pools/<pair>`): reserves, LP supply, your share, and a real price-history line from
  the pair's `Sync` events (eth_getLogs), drawn as a ruled ink line — or the honest "No trades yet" line.
- Dark variant following `prefers-color-scheme`: inverted print (paper→#000, ink→#FFF, grays inverted,
  yellow unchanged with an `--on-accent` ink so black text stays on the button).
- Keyboard: ⌘/Ctrl+K opens the pay-token picker; Enter in an amount field fires the primary action when
  it is ready; visible focus order top-to-bottom.
- Accessibility scan (WCAG 2.2 automated tier) with zero violations on Swap and Pools.

### Arc Studio — integration and fresh eyes
- Round-trip of the final `src/`, checks in the sandbox, and a scripted first-time-user walkthrough of
  the preview reporting anything confusing in plain words.

## Acceptance
- All checks green locally and in the sandbox; Impeccable finish review "ship"; DESIGN.md updated for
  the dark variant and the new components; `.impeccable/review/*.png` recaptured (light + dark,
  desktop + mobile).
