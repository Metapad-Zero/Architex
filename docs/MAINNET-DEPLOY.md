# Deploying Architex to Arc mainnet (chain 5042)

Mainnet deployment spends real USDC (Arc's gas token) and cannot be undone. Nothing in this repo
does it automatically; a human runs one of the two paths below.

## What gets deployed, in order

| # | Contract | Constructor args | Notes |
|---|---|---|---|
| 1 | `ArchitexFactory` | `(feeToSetter)` | Use the address that should control the protocol-fee switch (a multisig or your cold wallet). `feeTo` starts off. |
| 2 | `ArchitexRouter` | `(factory)` | Address from step 1. |
| 3 | `ArchitexLens` | `(factory, router)` | Read-only helper the frontend calls. |

Do **not** deploy `TestToken` to mainnet (the deploy script refuses; the faucet is testnet-only).

After deploying, fill `src/deployments/arc-mainnet.json` (factory / router / lens / deployer / txs),
set `VITE_ARC_NETWORK=mainnet`, rebuild, and create the first pools from the Pools view
("Create a pool") with real USDC and the tokens you want listed.

## Path A — Foundry script with your own key (non-custodial, recommended)

Requires Foundry locally (`curl -L https://foundry.paradigm.xyz | bash && foundryup`).

```bash
# from the repo root (foundry.toml lives here: src = contracts, script = contracts/script)
export FEE_TO_SETTER=0xYourAdminAddress
forge script contracts/script/DeployArchitex.s.sol:DeployArchitex \
  --rpc-url https://rpc.mainnet.arc.io \
  --broadcast \
  --interactive          # prompts for the deployer private key; never put it in a file
```

With a hardware wallet, replace `--interactive` with `--ledger --sender 0xYourLedgerAddress` (Ethereum
app open, blind signing enabled). Drop `--broadcast` for a free simulation against any RPC: on
2026-09-19 the mainnet simulation estimated ~6.5M gas, about 0.27 USDC for all three contracts.
`lib/forge-std` is vendored in the repo, so a fresh clone builds after `bun install`.

Rehearse first against the testnet with `--rpc-url https://rpc.testnet.arc.io` (it costs only faucet USDC).
`contracts/script/DeployArchitex.s.sol` deploys the three contracts in order and prints one JSON line
with the addresses. Copy them into `src/deployments/arc-mainnet.json`. Gas: the deployer needs a few
USDC on Arc mainnet.

## Path B — Arc Studio's Compass deploy (inside the Arc Studio sandbox)

From the app's terminal in Arc Studio, with a funded key in `.env` as `DEPLOYER_PRIVATE_KEY`:

```bash
bun run compass:deploy ArchitexFactory '["0xYourAdminAddress"]' --signer private-key --mode live --blockchain ARC --compass-chain Arc --rpc https://rpc.mainnet.arc.io
bun run compass:deploy ArchitexRouter  '["<factory>"]'            --signer private-key --mode live --blockchain ARC --compass-chain Arc --rpc https://rpc.mainnet.arc.io
bun run compass:deploy ArchitexLens    '["<factory>","<router>"]' --signer private-key --mode live --blockchain ARC --compass-chain Arc --rpc https://rpc.mainnet.arc.io
```

`--mode live` refuses to broadcast without a prior `--mode verify` receipt (fork rehearsal) unless
you pass `--skip-verify "<reason>"`. Check `bun run compass:deploy --help` for the exact mainnet
chain ids the Compass registry expects; the Circle developer-controlled-wallet (`--signer dcw`) path
only works on chains listed with an `scpBlockchain` in `src/onchain-facts.ts`, and Arc mainnet is not.

## Serving the app (any network)

Set these response headers at the host (they cannot live in `index.html`):

- Serve over HTTPS only, from ONE canonical hostname, decided before launch. Passkeys (WebAuthn PRF)
  exist only in a secure context and are bound to the site's hostname (`rpId`). A passkey wallet's
  key is *derived from the passkey*, so on another domain the same passkey cannot produce it: moving
  the app orphans every passkey wallet whose owner has no key backup. If a move is ever unavoidable,
  keep the old origin serving the app until users have backed up or swept their wallets.
- Never change `WALLET_PRF_SALT`, `WALLET_HKDF_SALT` or `WALLET_KEY_INFO` in `src/lib/keystore.ts`:
  wallet addresses are a function of them (a test vector in `src/lib/__tests__/keystore.test.ts`
  fails if they drift).
- WalletConnect (Reown): add the production domain to the project's allowlist at dashboard.reown.com
  (project id in `src/lib/walletConnect.ts`, or your own via `VITE_REOWN_PROJECT_ID`); a domain that
  is not on the list is refused by the relay. If you ship a `connect-src` policy, it must also allow
  `wss://relay.walletconnect.org https://*.walletconnect.org https://*.walletconnect.com https://api.web3modal.org https://pulse.walletconnect.org`,
  plus `frame-src https://verify.walletconnect.org https://verify.walletconnect.com` and wallet icons
  under `img-src https://api.web3modal.org https://*.walletconnect.com`.
- `Content-Security-Policy: frame-ancestors 'self' https://studio.arc.io` — the app creates and signs
  with browser-wallet keys, so no other site may frame it (clickjacking the confirm sheet or the
  "Back up private key" button). Add `default-src 'self'; connect-src 'self' https://rpc.testnet.arc.io https://rpc.mainnet.arc.io https://explorer.testnet.arc.io https://explorer.arc.io; img-src 'self' data:; style-src 'self' 'unsafe-inline'` once you have verified the wallet-extension icons you want to allow.
- Production builds ship without Arc Studio's trace panel and console capture (dev-only imports) and
  without `VITE_DEV_BURNER_KEY` (a statically dead branch); `scripts/verify-deploy.ts` and a grep of
  `dist/` for the seed value are the checks.

## After deploy

1. Verify each contract on `https://explorer.arc.io` (Foundry: `forge verify-contract`).
2. Transfer `feeToSetter` to the multisig if you deployed from a hot key: `setFeeToSetter(newAddress)`.
3. Seed at least one USDC pool so the app has something to quote.
4. Smoke test one small swap and one add/remove liquidity with the production build.
