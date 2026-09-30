---
name: equilibrium-launch
description: Quote, authorize and track an EQUILIBRIUM shared-supply launch against the local Architex rehearsal service. Use when asked to try the EQUILIBRIUM x402 launch flow, get a free launch quote, run an authorized local launch, or read a launch job's settlement and fulfillment. Local synthetic rehearsal only; public paid launches are closed.
---

# EQUILIBRIUM launch (local rehearsal)

Everything this skill signs is **synthetic**: the local service settles on chain id 31337 with a placeholder asset, and every address it records is `local:`. Nothing here broadcasts, spends or deploys. Public paid routes are closed (`api/equilibrium.ts` answers POST with 503), and the client refuses to sign for any service that is not on loopback and reporting `mode: local`.

Settlement and fulfillment are different facts. A settled payment pays for the plan; only `state: complete` means the launch was fulfilled. Report them separately.

## 1. Install and start the service

```bash
bun install --frozen-lockfile
EQUILIBRIUM_DB=./output/equilibrium/jobs.sqlite bun run equilibrium:server   # http://127.0.0.1:4042
```

Keep `EQUILIBRIUM_DB` on durable disk; the service refuses temporary paths. Optional browser record: `EQUILIBRIUM_JOB_SERVER=http://127.0.0.1:4042 bun run dev`, then open `/#equilibrium`.

## 2. Write a request

```bash
export EQUILIBRIUM_LOCAL_KEY=0x<local test key>     # never a key that holds real funds
bun run equilibrium:client init --out request.json
```

The template launches 1,000,000 EQL on Arc and Base (the only routes the rehearsal enables). Amounts are six-decimal atoms: `27200000` is 27.2 USDC. `quote.expires` is 240 s ahead; the service accepts at most 300 s.

## 3. Free quote

```bash
bun run equilibrium:client quote --request request.json
```

Signs nothing. Shows the job id, total with the pool quote inventory broken out, pay-to, expiry and per-step budgets. The default template quotes 27.2 synthetic USDC. Confirm the total and expiry with the person before continuing.

## 4. Authorize the launch

```bash
bun run equilibrium:client launch --request request.json --max-total 27200000 --yes
```

`--max-total` is the most you authorize, in atoms. The client refuses when the total exceeds it or `quote.costCap`, when the quote expired, when the signing key is not the payer, or when the authorization nonce is not the job hash (x402 `extra.authorizationNonce`). HTTP 200 means fulfilled; 202 means settled or held with fulfillment incomplete.

## 5. Status, retries and recovery

```bash
bun run equilibrium:client status <jobId>
```

- **Retry**: resend the identical request. It resumes the same job and is never charged or signed twice.
- **409 identity_conflict**: that `requestId` is bound to a different payload. Read the existing job, or use a new `requestId`.
- **409 quote_expired** before signing: nothing was charged. New `requestId`, fresh expiry.
- **503 reconciliation_required**: an external step has an unknown result. Do not sign again; read status. The service sweeps interrupted jobs on its own (`EQUILIBRIUM_RECONCILE_MS`, default 30 s) once the dead worker's lease expires.
- **Partial**: `funds.unresolvedEffects` names outstanding operations. No refund can be decided until they resolve, and no refund path is open.

Add `--json` to any command for the raw record. `--server <url>` changes the target; `launch` still requires loopback.
