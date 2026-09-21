---
version: 1
slug: "src-components-updatessheet-tsx"
primary_target: "src/components/UpdatesSheet.tsx"
related_targets: ["src/lib/updates.ts","src/index.css","src/components/AppShell.tsx","src/main.tsx"]
---

# Surface brief — Updates bulletin (src/components/UpdatesSheet.tsx)

Scope: the unread-product overlay that appears after the logo splash, plus the masthead "Updates" reopen on large screens and the `#updates` hash. Visitor mode: **Operate** (an interruption on the app, not a marketing page).

Audience and job: a returning or first-time visitor who should learn what shipped without leaving the swap sheet. Frequency: once per new item id, then on demand.

Content/proof: authored from shipped work only (docs, CCTP bridge, launchpad). Specimens are labelled "Example". No volume, TVL, or unaudited-except-where-true claims.

Success: after the curtain, the newest bulletin is readable in one viewport; Next pages without reflow; Later or Done dismisses until a new id ships; Open … lands on the real task. Untouchable: quote math, wallet confirm sheet stacking above this (z-60 vs z-55). Wrong-feeling: Axiom dark glass cards, illustrated PNLs, "just Updated!" hype, kickers, emoji.

## Direction contract

THESIS: A product bulletin, not a marketing carousel. Each unread ship is a ruled sheet you page through on landing, then the app. It refuses Axiom's dark glass cards, painted feature art, and slogan footer.

OWN-WORLD: The Swiss settlement sheet. Paper, ink, hairlines, one 4px corner, one yellow Next. Specimens are fragments of the real UI (meter, receipt, docs list), not paintings. Later is a quiet underlined dismiss. No cards, shadows, gradients, or kickers.

STORY: After the logo curtain, if this browser has not dismissed the current stack, the visitor reads the newest item, can page older ones, open the feature, or say Later. The app is already live underneath.

FIRST VIEWPORT: Centered 512px outlined paper sheet on a 40% black scrim (bottom sheet below 640px). Fixed-height figure opened by ink hairlines, captioned Example. Title at 20px semibold, body at 16px, ghost "Open …". Footer hairline pinned: "Architex updated · 1 of n" and Later on the left, yellow Next (Done on the last page) on the right.

FORM: Confirm-sheet grammar (existing scrim modal) used as a bulletin. Local extension of the app surface; no concept-seed. Signature interaction: Next replaces figure and copy in a fixed slot with no reflow; Escape is Later; arrow keys page.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
