# EQUILIBRIUM public record repair (49TH-27)

An unpaid quote now reports fulfillment `not_started`, determinate zero funds and
no automatic recovery. Its planned steps do not imply outstanding external work.
Held authorizations and settled jobs report `recovery.automatic` from the durable
runner's sweep eligibility. Blocked and complete jobs stop automatic reads.
Older records without eligibility require a manual read.

A prepared canonical issuance, debit or credit can already have changed external
supply before its receipt is saved. During that window, `supply.evidence` is
`withheld`, and issuance, custody, remote, pending and canonical-outside-custody
amounts are all `null`. The page and client say these amounts are withheld. They
also hide stale amounts returned by an older service with a prepared supply step.
Recorded receipts restore the vector. No effect or settlement is recreated for
this repair. This projection is evidence from receipts, not a continuous chain
audit or proof of live supply.

The page reads every 10 seconds only for authorized work eligible to progress or
recover. During an outage, it retains the last successful records, labels them
stale, retries after 10 and 20 seconds, then stops after three consecutive failed
reads. An initial unavailable service gets the same bounded retries. Known
unpaid/blocked records do not get automatic outage retries. Check again starts a
manual read and resets the failure count; success restores eligible polling.
Each request has a five-second timeout and only one request can be in flight.

## Repeat the local HTTP and restart journey

Use a new database path; the fixture refuses to overwrite existing jobs. Every
effect, payment, address and quoted USDC amount here is synthetic. It makes no
RPC call and the signing client accepts only the loopback chain-31337 domain.

```sh
bun install --frozen-lockfile
bun run server/equilibrium/repairRehearsal.ts --seed
bun run server/equilibrium/repairRehearsal.ts --serve --port 41428
```

In a second terminal:

```sh
EQUILIBRIUM_JOB_SERVER=http://127.0.0.1:41428 bun run dev --host 127.0.0.1 --port 5198 --strictPort
```

Open `http://127.0.0.1:5198/#equilibrium`, dismiss the updates bulletin if present,
and expand the four job records at 1440×900 and 390×844. The newest job has
settled synthetic payment and a pending credit receipt; all four displayed
supply values say Withheld. The other records show a paid blocked job, an
expired authorization blocked before payment broadcast, and an unpaid quote.
The latter two say fulfillment has not started.

Stop the evidence server with Ctrl-C and restart it against the same database:

```sh
bun run server/equilibrium/repairRehearsal.ts --serve --recover --port 41428
```

Its boot sweep recovers the eligible credit using the existing prepared
operation. Without reloading or clicking Check again, both pages update on
their next read, show reconciled supply and stop polling. Leave them open for
more than 10 seconds to confirm the unpaid/blocked records do not keep polling.
Stop both foreground services after inspecting the result.

The seeder writes `output/equilibrium/repair-http.json` with actual loopback HTTP
and client output: repeated quotes, HTTP 202 pending fulfillment, an unsigned
202 retry retaining the settlement, HTTP 409 conflicting intent, and the
synthetic effect ledger alongside withheld public supply. After recovery,
issuance is 1000000000000 atoms, custody and remote are each 500000000000,
pending is zero, and canonical outside custody plus remote plus pending equals
issuance. Total fixture effects advance from 11 to 12, settlements remain 3;
the recovering job has eight effects and one settlement. The unpaid and blocked
jobs retain their states.

## Regression and evidence scope

```sh
bun test ./src ./server
bun run typecheck
bun run lint
bun run build
```

`publicRecord.test.ts` covers unpaid/expired quotes, expired held authorization,
paid blocked work, pending payment recovery after expiry, and actual synthetic
canonical/debit/credit broadcasts before receipts. SQLite reopen and recovery
must retain the prepared operation, settlement and exact conservation. Client
tests cover withheld-to-reconciled recovery without a second signature; helper
tests cover mixed eligible/unpaid jobs, older records and the outage cap.

The attached evidence pack includes loopback HTTP records, CLI output, browser
scripts, request counts and before/after screenshots at both widths. Browser
restart recovery uses the real service and 10-second timer. Outage checks use
the captured real pending record, injected HTTP 503 responses and a virtual
browser clock: three failures, no more reads for 120 virtual seconds, then a
successful manual read. These are local proofs.
They establish no public settlement, destination stale-worker fence or
four-chain fulfillment. The 49TH-25 release gate and 49TH-26 implementation
remain outside this repair.

## Stack

Repair starts at verifier merge `3d5e01258b145d76f5e80bdc2c7044838e8149b0`, recovered
read-only into a separate checkout. The PR is stacked on client PR #10 at
`629def4307366848dea41cc895610492f658222c`, which depends on backend PR #11 at
`02a35beab3c9d91d3f4c2b65dfcd121657d891e1`. The merge also retains auditor PR #9 at
`fb9e95ad501fefd0909d87f03d267b2ec045fc05`; the audit and frozen backend updates
therefore appear in the PR diff against #10. No source PR head is rewritten. Review the
repair separately with `git diff 3d5e012..HEAD`.
