## EQUILIBRIUM keeper inventory maintenance preview

Mode **fork** — local fork rehearsal, not public approval.

Existing launch: 0x6378b1682b2279336092dfd29ce8099dc5ed5e6389f95233d3705bf0759bb184. No issuance, pool reseeding or holder inventory changes.

- Token route: Base executor 0xbf0fe883bbaa0565af4b02fa9d6a6a85c96a2924 → authenticated NTT burn/Arc unlock → Arc keeper 0xf57971edebb18bfc75638465a10d623d90bd5e7e.
- Token refill: Arc executor 0x9c409262efa8e122e00b1c6efaf5e1135325b7ca → canonical NTT lock → authenticated Base mint directly to Base keeper 0x4720960b18ffe44b284eef86357ecfa6f935891e. Transfer bounds 500000000 per transfer / 2000000000 total.
- USDC route: Arc executor 0x9c409262efa8e122e00b1c6efaf5e1135325b7ca → authenticated CCTP V2 burn/mint → Base executor 0xbf0fe883bbaa0565af4b02fa9d6a6a85c96a2924 → replay-protected deposit to Base keeper 0x4720960b18ffe44b284eef86357ecfa6f935891e.
- Canonical/spoke assets: Arc 0xd65922182ec702Aed5f8a6ef430D1407DBCaA484, Base 0xA5698219d8c818a4e0D5bc3F83a18f5FF6D4F7bD.
- NTT managers: Arc 0x98cCb903401C425667E7A741ab04f7196e7930f4, Base 0x63100F8f8e149488d1EfC936D87a2317C5ad7333.
- CCTP domains: Arc 26, Base 6; attestation source local-attester.
- CCTP transmitters: Arc 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275, Base 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275.
- Token bounds: 500000000 atoms per transfer, 2000000000 total.
- USDC bounds: 3000000 atoms per transfer, 3000000 total.
- Underlying transfer bounds: return 500000000 atoms; CCTP 6000000 per transfer and 12000000 total.
- Transfer operator gas caps: Arc 1000000000000000000 wei; Base 1000000000000000 wei, L1 fee included.
- Protocol fees: zero-message-fee NTT and zero-fee CCTP only. Native protocol payments refuse before broadcast.

Maintenance refuses local or on-chain exposure. Pending maintenance blocks new keeper cycles. It resumes the same prepared executor operations after restart. Costs are counted once by mined transaction, separate from trading profit; transferred principal is neither profit nor cost.

Fork substitutions: local Wormhole Guardian and CCTP attester sets, threshold 1; Arc USDC stand-in; development-key fork gas. Base starts at zero USDC and receives it through CCTP. These do not prove public attestations, Arc precompile settlement or real Base L1 fees.

Token direction is bound to the maintenance identity. Depleted source inventory refuses; pending claims remain reserved and block trading.

Requires both exact keeper approval a0436281e4ee735c7bac1931c03a886d2642331c808b7dc3fe07db21a871eaac and separate transfer approval 7243b9455ec878dd7f6f07bc4c253c84e33e31ab777335677ae5b3c5713a4057. Launch approval is unchanged and authorizes no maintenance. No public authorization is inherited from a fork preview.

Stop: leave a pending transfer and its reserved bounds intact; reconcile it before starting a cycle. Never fund, change caps or replace a pending request to get past a stop.
