# Submitting a plugin

A plugin decides what happens to a launch token's **creator fee** (0–10% of every buy and sell, set by the
creator at launch and locked forever). The creator picks the plugin in the token builder, and that choice is
locked forever too. The whole design is in `docs/launchpad/V13-SPEC.md` §2.

Any address that can pass fees on can be a token's plugin (V13-SPEC §2.1 lists the few the launchpad refuses).
A wallet or a Safe just receives USDC, and takes no plugin data. The **marketplace** lists contracts that
implement `IArchitexFeePlugin` (`contracts/interfaces/IArchitexFeePlugin.sol`), were reviewed by pull request,
and can be picked and configured in the builder.

## Why PR-based

A plugin receives real fees, and a token's plugin can never be changed. A listing tells creators the code was
read and tested, so the PR is the review gate. Creators can still paste any address; the site says plainly when
a plugin isn't listed.

## The rules

1. **Declare the interface with ERC-165.** The launchpad calls your hooks only if `supportsInterface`
   returns true at launch, and it stores that answer. Don't make it change later.
2. **`onFees(token, amount)` must pull exactly `amount` USDC** from `msg.sender` with `transferFrom`. The
   launchpad approves exactly that amount and reverts the collection if anything else happens. Credit only
   what you pulled, per token.
3. **Authenticate `onLaunch`.** Launch-token addresses are predictable, so accept configuration only if
   `launchpad.pluginOf(token) == msg.sender` (the Combo case), or if the caller is the launchpad and
   `pluginOf(token) == address(this)`. Configuration is write-once per token. Use `pluginOf`, not `curves()`:
   `curves()` reverts for unknown tokens.
4. **Account per token.** One deployment serves every token that picks it. Never treat your USDC balance as
   one token's balance.
5. **Don't trade inside a hook.** Hooks run under the launchpad's reentrancy guard. Do anything that buys, sells
   or adds liquidity in a separate, permissionless function, as Buyback & burn's `run` does. If anyone can
   trigger it, pace it by time, not by block: a trader can hold across blocks, and on Arc blocks come faster
   than one a second (V13-SPEC §2.2).
6. **Pay out by pull, not push.** One bad recipient must never block the others.
7. **A broken plugin strands fees.** If `onFees` reverts, that token's fees stay with the launchpad forever
   (owner decision D10). Test like it.
8. **Check where you send fees.** Every payee or entry must be able to pass fees on. `_checkRecipient` refuses
   zero, your plugin, the launchpad, USDC, the token, any launch pair (`launchpad.isLaunchPair`; anyone can
   skim a transfer out of one), the launch router, the pair factory and any launch token, reading only the
   launchpad, never the recipient.

The reference plugins in `contracts/plugins/launch/` share these rules through `LaunchFeePluginBase.sol`.
Inherit from it.

## Checklist

1. The contract goes in `contracts/plugins/launch/`, and its interface (the views and actions the site
   calls) in `contracts/interfaces/plugins/`.
2. Tests go in `contracts/test/plugins/launch/`. Cover:
   - the rules above under adversarial input (pre-configuration by an attacker, under- and over-pulling,
     two tokens' fees never mixing);
   - a fuzz test that paid out never exceeds received;
   - an invariant that USDC held equals the per-token balances.
3. Add a registry entry in the site's plugin registry (`src/content/plugins/`) with your plugin's
   configuration fields.
4. Run `bun run contracts:test`, `bun run contracts:solhint` and `bun run contracts:slither`. CI re-runs
   them and fails on high findings.
5. Open the PR with the plugin-submission template (`.github/PULL_REQUEST_TEMPLATE/plugin-submission.md`).

## Protocol-fee distributors

`contracts/plugins/fee-distribution/` (Weighted Split, Equal Split) are a different thing. They are splitters
for Architex's own protocol fee (`feeTo`) and are not creator-fee plugins.
