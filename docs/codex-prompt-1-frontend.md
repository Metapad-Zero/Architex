You are building the ArcSwap DEX frontend in this repository (an Arc Studio Vite + React + TypeScript + Tailwind app; runtime `bun`, deps already installed in node_modules).

This is a NON-INTERACTIVE run. Approval to write code is granted in advance: do not propose a plan and wait — read the specs, then implement everything, run the checks, fix what fails, and finish with a summary. Nobody will answer questions; make sensible assumptions and list them at the end.

Read, in this order, before writing code:
1. `docs/FRONTEND-SPEC.md` — the complete build spec (files, math, state machine, tokens, copy, states, acceptance). It is binding.
2. `PRODUCT.md` and `docs/surface-brief-app.md` — product truth and the design direction contract (Swiss bank-form on white paper; yellow primary; hairline rules; tabular numerals).
3. `.agents/skills/impeccable/reference/craft-floor.md` and `.agents/skills/impeccable/reference/operate.md` — the design quality floor. Apply them; do not announce the checklist.
4. `contracts/interfaces/*.sol` — the ABI truth for `src/lib/abi.ts`.
5. `docs/guides/popover-anchor.md` — how to do the token picker popover (native popover + fallbacks).
6. `src/main.tsx`, `src/onchain-facts.ts`, `vite.config.ts`, `tailwind.config.js`, `package.json` — template conventions to keep.

Then build every file listed in the spec's "Files to create". Write real, complete, production-quality code — no placeholders, no TODO stubs, no "coming soon". Use Tailwind utilities mapped to the tokens; write the tokens and browser-surface theming in `src/index.css`.

Checks you must run and get green before finishing: `bun add @fontsource-variable/public-sans`, then `bun run typecheck`, `bun run lint`, `bun test`, `bun run build`. Do NOT run `bun run dev`, do not open a browser, do not touch `contracts/` or `deployments/` or `scripts/`, do not modify `src/main.tsx` beyond adding the font import if you choose to put it there (prefer `src/index.css` `@import`).

Design bar: an award-level Operate surface. Precise hairlines, generous whitespace, big black numerals, one yellow button, skeletons not spinners, every state designed. No cards-in-cards, no shadows, no gradients, no ALL-CAPS labels, no emoji, no purple, no glassmorphism. If a spec detail and the craft floor conflict, the spec wins; if the spec is silent, the craft floor decides.

Finish with: files created, checks output summary (pass/fail lines), assumptions, and anything left undone.
