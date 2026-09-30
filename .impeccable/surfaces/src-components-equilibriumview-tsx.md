---
version: 1
slug: "src-components-equilibriumview-tsx"
primary_target: "src/components/EquilibriumView.tsx"
related_targets: ["src/components/equilibrium.css", "src/lib/equilibrium.ts", "scripts/export-equilibrium.ts"]
---

# EQUILIBRIUM surface

Visitor mode: **Experience**, with controls to inspect the modeled mechanism. Audience: people evaluating Architex's proposed four-chain token showcase. Success means creating a demand shock, seeing a bounded balancing receipt, reconciling the fixed supply, and understanding the cost and deployment limits.

This extends the established ruled-sheet app world. Public Sans, tabular data, paper/ink, warm gray hairlines and signal yellow follow DESIGN.md. The theme follows the system preference. A price beam connects the four actual modeled price observations; a demand shock changes its geometry. There are no invented live metrics, transaction hashes or deployed addresses.

The page labels simulation mode above the markets. Market quotes, pre-positioned inventory, decision/cost receipt, supply reconciliation, guardrail controls and a chronological action record carry the story. Mobile reorganizes the four markets into two rows and names each plotted point. Bridge controls and failure injection are disclosed inline. Yellow identifies the next balancing/recovery action; gain/loss also use explicit text.

Evidence: the same model uses the DEX's bigint AMM math, validated browser snapshots, exact transfer accounting and bounded recovery. Tests cover the example, all spoke round trips, pending credits, duplicate replay, limits and failed legs. The standalone HTML includes its font and checklist and works offline. Desktop and mobile were visually inspected in light/dark; browser flows exercised persistence, recovery, replay, input errors and downloads. Release limits are stated at the end of the page and in the checklist.
