## EQUILIBRIUM keeper inventory maintenance preview

Mode **fork** — local fork rehearsal, not public approval.

Existing launch: 0x7caf9cd5c67436417fff688c36af750af1a61bdeb94fd63f264a9000383c7096. No issuance, pool reseeding or holder inventory changes.

- Token route: Base executor 0xbf0fe883bbaa0565af4b02fa9d6a6a85c96a2924 → authenticated NTT burn/Arc unlock → Arc keeper 0xf57971edebb18bfc75638465a10d623d90bd5e7e.
- USDC route: Arc executor 0x9c409262efa8e122e00b1c6efaf5e1135325b7ca → authenticated CCTP V2 burn/mint → Base executor 0xbf0fe883bbaa0565af4b02fa9d6a6a85c96a2924 → replay-protected deposit to Base keeper 0x4720960b18ffe44b284eef86357ecfa6f935891e.
- Canonical/spoke assets: Arc 0x922159d26A6D96773861463BF7Af87c9Ed4B41f0, Base 0x4D6f793D19029E85bB372a774Ac1d53133095627.
- NTT managers: Arc 0xdd6Dd2fCC9f8ECbB1CDdf17662a136Dd3bec891e, Base 0x7F7B15CF7d50eC27bbB197eedbf25C5Fe61f2Df6.
- CCTP domains: Arc 26, Base 6; attestation source local-attester.
- CCTP transmitters: Arc 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275, Base 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275.
- Token bounds: 500000000 atoms per transfer, 500000000 total.
- USDC bounds: 3000000 atoms per transfer, 3000000 total.
- Underlying transfer bounds: return 500000000 atoms; CCTP 6000000 per transfer and 12000000 total.
- Transfer operator gas caps: Arc 100000000000000000 wei; Base 1000000000000000 wei, L1 fee included.
- Protocol fees: zero-message-fee NTT and zero-fee CCTP only. Native protocol payments refuse before broadcast.

Maintenance refuses local or on-chain exposure. Pending maintenance blocks new keeper cycles. It resumes the same prepared executor operations after restart. Costs are counted once by mined transaction, separate from trading profit; transferred principal is neither profit nor cost.

Fork substitutions: local Wormhole Guardian and CCTP attester sets, threshold 1; Arc USDC stand-in; development-key fork gas. Base starts at zero USDC and receives it through CCTP. These do not prove public attestations, Arc precompile settlement or real Base L1 fees.

Only Base→Arc token maintenance is available here. Arc→Base token refill remains closed; the keeper continues to refuse a depleted Base token inventory.

Requires both exact keeper approval db2401e8f7aae3157c2fd2d34e3e3c0bff8408fb8ad0faa1ef1f74e4d40728e3 and separate transfer approval 4e154b7796503b5565c8367dedb95387db5cb0518bad9bf82af0160604866314. Launch approval is unchanged and authorizes no maintenance. No public authorization is inherited from a fork preview.

Stop: leave a pending transfer and its reserved bounds intact; reconcile it before starting a cycle. Never fund, change caps or replace a pending request to get past a stop.
