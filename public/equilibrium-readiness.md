## EQUILIBRIUM implementation checklist

One global supply, four markets, bounded automatic price-gap reduction.

The shipped `/app/#equilibrium` page is a local simulation. Its four chain labels describe modeled markets. It makes no network requests for trading or bridging, signs no payments, and has no deployed token addresses.

### Delivered: the local demonstration

- Four fee-inclusive constant-product markets using the DEX's bigint AMM math, six-decimal units.
- Fixed 1,000,000-token illustrative issuance; canonical bridge custody is excluded from economic supply.
- Arc-to-spoke and return transfers with pending claims, duplicate-message handling and browser restart persistence.
- Size search up to 80 whole tokens, fresh-market selection, pre-positioned inventory, operating costs, risk buffer, spending and loss limits.
- Failed second-leg simulation, halt, bounded unwind and a full downloadable action record.
- Separate keeper net and combined pool/keeper holdings. These values do not establish campaign profitability.

### Needed: infrastructure proof

Select and pin a bridge implementation; configure token authorities and peers; test actual debit/credit round trips, finality, decimal normalization, replay and authorization rejection, pause/rate limits and restart recovery. The local transfer reducer is an accounting model, not a bridge verifier.

Prove the first two chains before expanding. A route without an available public test network must be identified as a local or fork proof, never reported as a public testnet result.

### Needed: payment-to-fulfillment integration

The inspected `agent-launch` worktree remains a separate, uncommitted draft. Its four venue adapters return closed and its Arc ledger addresses are zero. Reconcile that work explicitly before reusing it.

Add a dedicated promotional-token job adapter. Bind payer, canonical issuance, requested chains, recipients, cost cap and quote expiry to a stable request identity. Persist payment and each fulfillment step. Repeating the same request resumes the same job; it must not charge again, issue again or deploy a second token. Conflicting payloads for the same identity must fail.

Model partial completion and distinguish spent deployment fees from unspent funds. A payment receipt does not prove that four markets were created. Keep the supply and action record free to read.

### Needed: market and quote-asset compatibility

For each of Arc, Base, Solana and Robinhood Chain, name the actual token manager, token address/mint, pool venue and version, fee/transfer rules, executable quote source, signing authority and quote-inventory replenishment route.

Verify each pool accepts the shared asset. Four ordinary launchpad creations create separate assets; shared names and tickers do not establish fungibility. Do not assume the Argus, Bankr, Pump and Pons gateway adapters can create the shared-supply token.

### Needed: funded release decision

Before deployment, produce a concrete release preview with verified routes, contract/authority configuration, pool ownership and lock terms, a capped budget (deployments, pools, keeper inventory, quote refills, gas and recovery), loss limits, failure runbook and public copy. Angus must approve deployment and spending for that specific preview.

Readiness means successful supply reconciliation and verified execution, not a promise of equal prices, guaranteed returns or customer demand. Measure skill installations, first paid external launches and repeat creators separately from keeper volume.
