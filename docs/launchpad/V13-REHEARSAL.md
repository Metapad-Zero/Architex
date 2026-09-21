# Launchpad v1.3: the Arc Testnet rehearsal

**Run 2026-09-21 on Arc Testnet (chain 5042002), contracts at `c508af3` (the contracts are unchanged at `149b177`).**
This is step 2 of the v1.3 rollout (V13-SPEC §8). The whole suite was deployed on a mintable test USDC and every
reference plugin was driven through real transactions. All five test tokens were graduated into their launch pools and
traded there, and the books were checked to the unit after every transaction. A second deployment on Arc's own USDC
repeats the curve half with 1 USDC trades. Arc's USDC is a chain-native precompile that no local fork can execute, so
only a live chain tests it.

| Run | Transactions | Checks | Result | Gas | Cost (USDC) |
| --- | ---: | ---: | --- | ---: | ---: |
| rUSDC: deploy | 9 | 47 (wiring) | pass | 11,837,201 | 0.384709 |
| rUSDC: drive (5 tokens, 5 graduations) | 58 | 869 | pass | 21,181,344 | 0.529534 |
| Arc USDC: deploy | 8 | 45 (wiring) | pass | 11,150,855 | 0.357610 |
| Arc USDC: drive (2 tokens, curve only) | 13 | 212 | pass | 7,413,290 | 0.185332 |
| **Total** | **88** | **1,173** | **all pass** | **51,582,690** | **1.457185** |

The burner's native balance fell by exactly the recorded gas (nonce 33 → 121, 88 transactions) plus the 1.37695 USDC
the Arc-USDC run left in its curves and plugins. **No contract behaviour contradicted the spec.** Every deployed contract
matches the local build byte for byte (`scripts/verify-bytecode.ts`, with immutables and metadata hashes masked).

## Addresses

### Rehearsal on rUSDC: `deployments/arc-testnet-v13-rehearsal.json`

Launch fee 1 rUSDC. `feeTo` and `feeToSetter` are the dev burner `0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46`, which
also owns rUSDC. rUSDC's faucet is closed, so only its owner can mint it.

| Contract | Address |
| --- | --- |
| rUSDC (TestToken "Architex Rehearsal USD", 6 decimals) | `0x2afE729913994A629A94e18740FEfe35c141eE90` |
| ArchitexLaunchpad | `0x374d4eaa8C8580227326e931A4A5c9349840E980` |
| LaunchPairFactory | `0xCc27E4E91B233633704F332BF610B897b3eb49Fe` |
| LaunchRouter | `0x693d69d8e1e83E3A83b5671ab72B5621e918EfFB` |
| SplitPlugin | `0x320f47BfF0941EEdb373eBcE22a73D54C523f961` |
| BuybackBurnPlugin | `0x356D23b7e159C988012fecbE514395138CCb2cFC` |
| HolderDistributionPlugin | `0x7236125B3125F9c2C941017F0B96AbD78582752B` |
| ComboPlugin | `0x82097AA4274fAc83fcFba3C292746Cd722a3Ae3c` |

| Token | Creator fee → destination | Token address | Launch pair (graduated) |
| --- | --- | --- | --- |
| RWALLET | 2.5% → a wallet | `0xC316A9a574f886cAc90a82A86E01af99f4239053` | `0x68d9944CA63d83dcbc6dF9980cA02eF219635AbC` |
| RSPLIT | 5% → Split 5/3/2 | `0x9A462E6c9a84b7e13De9CE55d1A6C55a3B49aD02` | `0x437a712C79c6069b6B52345d8A6a7141983f8228` |
| RBURN | 3% → Buyback & burn | `0x72F57d7213CC96820b1C1A3148cB19A152802bef` | `0x257EbdD0F57b3D2aC790CA9B54B48Ae1C3FD06ce` |
| RHOLD | 10% → Distribute to holders | `0x87FbB99D4A7f9CCa1de5b6055f925158D663eaC6` | `0xf90e445882af99446b9Ca25B7b595e53051425a5` |
| RCOMBO | 6% → Combo 40% buyback / 40% holders / 20% wallet | `0x8fc3DbA4b7d8677a9841f9a8E4C29C1960B967Dd` | `0x99a10E3227eED9b69d529aE1C77469A546De4CC8` |

The fee recipients are fixed addresses that nobody holds a key for. Each is the last 20 bytes of
`keccak256("architex/v13-rehearsal/<label>")`, so they are not contracts, and the script derives them again on every
run:

| Recipient | Address |
| --- | --- |
| creator wallet (RWALLET) | `0x31Df2cbf797b4DA444627ADC663e763087CC28e5` |
| Split payees, shares 5 / 3 / 2 | `0x50592B98c85E1BfDF2947cE4BE2aE63eE2523578`, `0x490Fc2a021F7495B144956C8c1CD311f3f2902d8`, `0x02Ea037C35704535F964de40aF03704c6Af053C5` |
| Combo's 20% wallet | `0xD3A421c7bCd3162510C3857b19ff82b34Bf40155` |

### On Arc's USDC: `deployments/arc-testnet-v13-realusdc.json`

Launch fee 0 (this saves the burner's funds). `feeTo` and `feeToSetter` are the burner.

| Contract | Address |
| --- | --- |
| ArchitexLaunchpad | `0x0D7459B51B9019b52D705D52D65c11FBD7d74cc5` |
| LaunchPairFactory | `0xC9790E4C0F15B4ff7c1b13DD0F05c49802369660` |
| LaunchRouter | `0xed96FCA9AE2eC97069e52a46ab0BF9FaD1a99D76` |
| SplitPlugin | `0xc0DeB0B3FD2B8f32f70A9c284A2D283B09294AAe` |
| BuybackBurnPlugin | `0xF738b60eb7dA7b91E56C36f52ae04282fa783102` |
| HolderDistributionPlugin | `0xD0e0bc8f8B49aF50ecb33127DB5034f2Faf9d093` |
| ComboPlugin | `0x35635430139269C5617B265393689ea3FCb920a5` |
| RHOLD (10% → holders), on the curve | `0x10F686d33cebAb03b9D62979Ef3D5f2e8019Ae4C` |
| RCOMBO (6% → Combo), on the curve | `0x5da389b203e521b64DBE8c15aC47E6f8Cf79eA64` |

## How to run it

The scripts hold no key. Deploys sign with `--interactive` (a hidden prompt) or `--ledger`. The driver signs its own
transactions, so it reads a **testnet-only** burner key from `BURNER_KEY`. Type the key at a hidden prompt; never put
it on a command line.

```bash
forge build
RPC=https://rpc.testnet.arc.io

# 1. The mintable test USDC. Its owner is the broadcaster, which must also be the account that drives step 6.
forge script contracts/script/DeployRehearsalUsdc.s.sol:DeployRehearsalUsdc --rpc-url $RPC --broadcast --slow --interactive

# 2. The launchpad suite on it, then 3. the four reference plugins.
USDC=<rUSDC> FEE_TO=<you> FEE_TO_SETTER=<you> LAUNCH_FEE=1000000 \
  forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url $RPC --broadcast --slow --interactive
LAUNCHPAD=<launchpad> \
  forge script contracts/script/DeployLaunchPlugins.s.sol:DeployLaunchPlugins --rpc-url $RPC --broadcast --slow --interactive

# 4. Record the deployment from Foundry's broadcast files. Run this before the next deploy replaces run-latest.json.
bun run scripts/v13-rehearsal-record.ts deployments/arc-testnet-v13-rehearsal.json

# 5. Read-only: wiring, constants and whatever state a drive has reached, plus the gas table. No key needed.
bun run scripts/v13-rehearsal.ts

# 6. Drive it.
read -rs BURNER_KEY && export BURNER_KEY
bun run scripts/v13-rehearsal.ts
```

On Arc's USDC, leave `USDC` unset (Arc's USDC is the default), set `LAUNCH_FEE=0`, record with `--real-usdc`, and
point the driver at the other file:

```bash
FEE_TO=<you> FEE_TO_SETTER=<you> LAUNCH_FEE=0 \
  forge script contracts/script/DeployLaunchpad.s.sol:DeployLaunchpad --rpc-url $RPC --broadcast --slow --interactive
LAUNCHPAD=<launchpad> \
  forge script contracts/script/DeployLaunchPlugins.s.sol:DeployLaunchPlugins --rpc-url $RPC --broadcast --slow --interactive
bun run scripts/v13-rehearsal-record.ts deployments/arc-testnet-v13-realusdc.json --real-usdc
DEPLOYMENT=deployments/arc-testnet-v13-realusdc.json bun run scripts/v13-rehearsal.ts
```

What the drive needs:

- **rUSDC run:** about 0.55 USDC of gas. The driver mints the ~160,000 rUSDC that five sell-outs take.
- **Arc-USDC run:** about 0.2 USDC of gas plus 2.4 USDC of trades. About 1.4 USDC of that stays in the curves and
  plugins as float, fees and dividends. The driver refuses any transaction that would leave the burner under 3 USDC.
  `TOKENS=wallet,split,buyback,holders,combo` runs all five tokens there too.

**Resuming.** Progress (token addresses, mined transactions, finished steps) lives in
`deployments/<name>.progress.json`, which is gitignored:

- A re-run skips finished steps and never sends a transaction twice.
- A step whose checks fail stops the run. The next run checks that step again at the mined transaction's block (Arc's
  RPC serves historical state) without re-sending it.
- A transaction left in flight by a crash is looked up by hash and recorded.

**Free dry run on anvil** (it caught one script bug before any testnet gas was spent):

```bash
anvil --port 8545 --block-time 1        # 1 s blocks, so the drip has time to grow
export ARC_TESTNET_RPC=http://127.0.0.1:8545 FOUNDRY_BROADCAST=/tmp/anvil-broadcast   # keeps broadcast/ clean
# steps 1-3 with --private-key <anvil's first test key>, then:
bun run scripts/v13-rehearsal-record.ts /tmp/anvil-deployment.json
DEPLOYMENT=/tmp/anvil-deployment.json SAMPLE_SECONDS=10 BURNER_KEY=<anvil's first test key> bun run scripts/v13-rehearsal.ts
```

Both scripts refuse every chain except Arc Testnet (5042002). They also accept 31337, but only at a localhost RPC.
Other settings:

- `PROGRESS`: where progress is kept.
- `ARTIFACTS`: the ABI directory (default `contracts/out`).
- `SAMPLE_SECONDS`: how far apart the two drip samples are (default 30).
- `GAS_CAP`: the most gas one progress file may spend, in USDC (default 3).
- `MARKDOWN=1`: prints the tables below.

## What each step proves

Every step checks the launchpad identity (V13-SPEC §6.1) to the unit, at the receipt's block:

`USDC held == pendingFees + Σ pendingCreatorFees + Σ (virtualUsdc − VIRTUAL_USDC_0) over curves not yet graduated`

It also checks the burner's own side on its native balance with the gas added back, to the wei. On Arc, USDC is the
gas token; on rUSDC, the native balance must move by exactly the gas and nothing else. Every transaction is simulated first, so a revert
costs nothing.

**Verified against the code before the run.** Every path that moves USDC moves both sides of the identity by the
same amount:

- the launch fee;
- curve buys and sells;
- graduation, which removes the curve's float from the sum and sends exactly that much USDC to the pair;
- `collectFees` and `collectCreatorFees`;
- the router's transfer-then-`accrueTradeFees`.

The launchpad's own comment states the same identity. The sum of creator fees covers every token, graduated or not,
because pool trades keep accruing them. It holds "absent donations": a direct USDC transfer to the launchpad makes the
balance exceed the sum, and the check would flag it.

| Step | What it proves |
| --- | --- |
| `wiring` | Every address points where it should; the constants match the spec; each plugin declares `IArchitexFeePlugin` (`0x87732014`) and ERC-165, and rejects `0xffffffff`. |
| `create:*` | `createToken` with `maxLaunchFee = launchFee` [D22]. `curves()` records the plugin, the creator fee and `pluginHooks` (false for the wallet, true for the plugins). The plugin's `Configured` log comes before the first buy's `Trade` log, so `onLaunch` ran before the buy. `isConfigured` flips false → true, and a second `onLaunch` reverts `AlreadyConfigured`. Split stores its payees and shares. Combo stores its allocation and configures both of its sub-plugins with the creator passed through. The creator's first buy pays the creator fee [D3]. Also, for free: a fee above `maxLaunchFee`, a 10.01% creator fee, and a zero or launchpad plugin all revert. |
| `buy:*`, `sell:*` | Result == `quoteBuy`/`quoteSell` == an independent model of V13-SPEC §5. Both fees are taken on the USDC side and rounded up: on a buy from the USDC in, on a sell from gross. `Trade` events and the curve state are exact. Selling straight back what was just bought returns less than was paid (§6.4). Also, for free: a transfer into the pair before graduation reverts `PairLockedUntilGraduation`; the router refuses an ungraduated token; a direct `LaunchPair.swap` reverts `OnlyRouter`; `accrueTradeFees` from anyone but the router reverts `Forbidden`. |
| `collect1:*` | `collectCreatorFees` pays exactly the accrued amount (§2.1). The wallet receives a plain transfer. Split, Buyback and Holders each record `FeesReceived` and raise `usdcHeld` by exactly that much. Combo splits 40/40/20 with the remainder going to the last entry (for example 39,459,356 + 39,459,356 + 19,729,680), forwards each slice through the sub-plugin's hook or by transfer, and keeps nothing. |
| `release*:split:*` | Each payee's `releasable` equals `totalReceived·share/10 − released`, and the payee receives exactly that. Rounding dust (2 units) stays in the plugin. |
| `run*:buyback`, `run*:combo` | `previewRun` equals `min(usdcHeld, 0.25% of the USDC-side reserve)`. In every rUSDC run the cap was the limit: 22.08 of 49.88 waiting on the curve, 63.10 of 811.79 in the pool. The token's total supply falls by exactly the tokens bought: on the curve before graduation, through the launch router after. The plugin keeps no tokens. The spend never exceeds 0.25%, and at most one run happens per block: `nextRunBlock` is the run's block + 1, and a second run simulated in that block reverts `AlreadyRanThisBlock` (§6.7). |
| `sample*` | The 24-hour drip [D21]. `releasable` is sampled twice, 30 s apart, and equals `unreleased·(t − lastDrip)/(streamEnd − lastDrip)` both times, so it grows. |
| `drip*:*` | `dripAndClaim` from the burner releases exactly the formula's amount through the token's `distribute`, then pays the caller its claim: more than zero and never more than was released. The burner is the only eligible holder, so it receives all of it, less at most 1 unit of rounding. Σ claimed + Σ claimable ≤ Σ distributed (§6.6). |
| `collect2:holders`, `collect2:combo` | Fees arriving into a running stream first release what the old stream owed. The rest is re-weighted: the new end is `max(oldEnd, now) + ceil(amount·(now + 24 h − from)/(kept + amount))`, exactly (86,392 s and 86,393 s here, instead of 86,400). A delivery into an empty stream runs for exactly 86,400 s. |
| `graduate:*` | The sell-out buy follows the §5 exact-fill formulas and pulls only what the last tokens cost. `Graduated` reports 200M tokens and exactly `virtualUsdc − VIRTUAL_USDC_0` USDC (24,999.99997 rUSDC, give or take 3 units). `getReserves()` equals the seeded amounts and so do the pair's balances. `curves().graduated` and `token.graduated()` are true. **Every LP token (MINIMUM_LIQUIDITY included, total `sqrt(tokens·usdc)`) sits at `0x…dEaD`**; the buyer and the launchpad hold none. The launchpad holds no tokens afterwards. The identity holds with the float gone. After graduation the curve refuses to quote, buy or sell, and a direct swap is still refused. |
| `poolbuy:*`, `poolsell:*` | Router result == quote == a constant-product model with both fees from the USDC side (§4). The fees reach the launchpad and are recorded per token (`PoolFeesAccrued`, `pendingCreatorFees`). The pool reserves move exactly. |
| `collectFees` | `feeTo` receives exactly `pendingFees`: 716.368795 rUSDC, which is the launch fees plus 0.5% of every trade. |
| `final` | Each plugin's balance equals Σ `usdcHeld` over the tokens it serves. The Combo holds 0. Every token burned was burned by the buyback. Pool reserves equal pool balances. The holder tokens' USDC equals distributed − claimed. |

## Results

### rUSDC: deploy and drive

| step | transaction | tx hash | gas | USDC | checks | result |
| --- | --- | --- | ---: | ---: | ---: | --- |
| deploy | rUSDC | `0x7e957406cacf35690b18d841eeb6d2200141f02f2eb22f4acc12b2db54f0e8fa` | 665,954 | 0.021644 |  | deployed |
| deploy | launchpad | `0x4814790086a58fc9cae55e8829ab5e77b5c2e863cac982430b32af95dfc2d143` | 4,191,926 | 0.136238 |  | deployed |
| deploy | pairFactory | `0x7595b252e9f73a1483f8c74b996c9a671fb5e3ecc74d74f651f021943c4cbdf2` | 1,856,048 | 0.060322 |  | deployed |
| deploy | router | `0x4c2d8e60ff5fe036f30037e096eee89e4d6c41c4980ec7daa0bdf6ef6abc1765` | 785,674 | 0.025534 |  | deployed |
| deploy | initialize | `0xbbc3b4e91ae1dd5ee4e107bcbcd2985c47be84b7bdee797b9252078cf682ea1c` | 76,992 | 0.002502 |  | deployed |
| deploy | split | `0xcf0140a22244c668ea804bf947e357e476d192308c8f4d2a93fec3281f6c51c0` | 979,110 | 0.031821 |  | deployed |
| deploy | buybackBurn | `0xde54678c119644d2b80798bce30192a92c4057e3892971aa3e3df0cc9714455d` | 1,034,422 | 0.033619 |  | deployed |
| deploy | holders | `0xfce408814ffb4dcba6ce36e90d2319c7c186a808fe0579d82792264f0ef57c45` | 932,502 | 0.030306 |  | deployed |
| deploy | combo | `0xe2b99b54f27d178dba414c4888e64ef1d3591f0bce69f6166a965186bbe0124e` | 1,314,573 | 0.042724 |  | deployed |
| fund | mint rUSDC | `0xda8e8f902855c358ef878aec7b7ee4c88a3f559c55a469ccc52d4a7907c36cd4` | 70,254 | 0.001756 | 4 | pass |
| approve | approve launchpad | `0x41f68f19e3e2d26c486dfc955b0c0150bd0cb6fd4818975778c09f494d5ec94d` | 46,266 | 0.001157 | 6 | pass |
| approve | approve router | `0xd245ed0bb366233deb0daae38f47f142e5004dbda4601a42300b8cbafec98e00` | 46,266 | 0.001157 |  | pass |
| create:wallet | createToken RWALLET | `0x97eab58dd7c58f73c9cfe46a2408cc3d41cd8c90dc68131d4e12c1bb237d8ad8` | 2,824,240 | 0.070606 | 29 | pass |
| create:split | createToken RSPLIT | `0x0304298ba6ea4c691c5d3d75459bfd0f5427b88bb6b4fb6e20d5f78b7c90a18d` | 2,976,214 | 0.074405 | 28 | pass |
| create:buyback | createToken RBURN | `0x2cacec61527632d7d68c612a362384b201838fa0288ca48928326009acc30f98` | 2,786,705 | 0.069668 | 26 | pass |
| create:holders | createToken RHOLD | `0x3b2b27558ee33c1a0f35e0d5e9f23c508af69d04b7e3217e5c2ba1a612e860f3` | 2,786,718 | 0.069668 | 26 | pass |
| create:combo | createToken RCOMBO | `0x99a80b618be53c00968c709f588eeb059ed0fc55cb6c1b30ffafb50ac12ece54` | 2,968,103 | 0.074203 | 27 | pass |
| buy:wallet | buy RWALLET (curve) | `0xa4315e4e0b54b2bc0c457348230afc2e916801bace3bd4d80ace1b2955a32f7e` | 91,576 | 0.002289 | 16 | pass |
| sell:wallet | sell RWALLET (curve, half) | `0x9036cf0bc7964cde9cc2b21ad30ed6ef19b0a4c2ccf49b13b6ccc8b9a410ad3f` | 89,253 | 0.002231 | 12 | pass |
| buy:split | buy RSPLIT (curve) | `0x0006ac81198d4d00d20f7ddc624f96d65d76c3b90e32870ea329f45e8bf34b39` | 91,576 | 0.002289 | 12 | pass |
| sell:split | sell RSPLIT (curve, half) | `0x8e7702ad47d4b7c8a5121bbf35f5e93d2279079af77d2bec905f3ddfec1bf3ca` | 89,253 | 0.002231 | 12 | pass |
| buy:buyback | buy RBURN (curve) | `0x46edb670c5eef0ca62cbd444be7fe702cea58476406012e2e5c96d0bce376cae` | 91,576 | 0.002289 | 12 | pass |
| sell:buyback | sell RBURN (curve, half) | `0x360bf49611ea1d92215e6368eaf213afeb707f1dd0da747fafba479831492e1a` | 89,253 | 0.002231 | 12 | pass |
| buy:holders | buy RHOLD (curve) | `0x09a4c2b93e589ced16efe8c22277b804bb96cfafb4ab5c7f424a26409a88f049` | 91,576 | 0.002289 | 12 | pass |
| sell:holders | sell RHOLD (curve, half) | `0x8b34d5b9172260b3342fca0263f4e4545ae415e92f5361fc57f26f80805b0bc3` | 89,253 | 0.002231 | 12 | pass |
| buy:combo | buy RCOMBO (curve) | `0x1ea542d6461d1b37d24d72f21d739c807fc49989ad005055920adb1236f809a6` | 91,576 | 0.002289 | 12 | pass |
| sell:combo | sell RCOMBO (curve, half) | `0xb3d4b14a560a85c21a5b1a9ffd4152460435242109edb279c590d5ef47860609` | 89,253 | 0.002231 | 12 | pass |
| collect1:wallet | collectCreatorFees RWALLET | `0x43dbb60321a81cb8de74165494190c4b53e09ecffe619431d5e62a0a83b4ad8b` | 63,699 | 0.001592 | 8 | pass |
| collect1:split | collectCreatorFees RSPLIT | `0x25504493fb36e39a8b7dc1bcb709e2e65c1da40ae266ae3993826bc9293fd9dd` | 107,722 | 0.002693 | 11 | pass |
| release1:split:1 | release payee 1 | `0x5869b43242b06350d8a682c14244b9f9f2ff3f5f636bd24a4c12c21a556875fa` | 110,702 | 0.002768 | 7 | pass |
| release1:split:2 | release payee 2 | `0xc406c15f4c3fc10fcc3f9e93d90c297c41675a428afc9e0e69fb3c7883794377` | 93,602 | 0.002340 | 7 | pass |
| release1:split:3 | release payee 3 | `0x451adea5fcec8dd0c79f11d0053a5dabf3778b25f052f8784e56d0e00e6c16a4` | 93,602 | 0.002340 | 7 | pass |
| collect1:buyback | collectCreatorFees RBURN | `0xb2d842156a66f3c328c2356476f5e1df954e171ff3e486f959de65abdcdba590` | 107,741 | 0.002694 | 10 | pass |
| run1:buyback | buyback run RBURN | `0xf0b8d507cf2bc3c8526c26451e88f2f08200f53eda4602cd7d3ace89787ddf0e` | 203,817 | 0.005095 | 20 | pass |
| collect1:holders | collectCreatorFees RHOLD | `0xe07822fb83a8aea08ca627d847bf6d88b4958754e0d4c900febb7bda13764776` | 129,860 | 0.003246 | 15 | pass |
| collect1:combo | collectCreatorFees RCOMBO | `0x4dcecc84b36afc6f48ea001e678f5c82ecb86a667cbc3d0f517ca9d152281126` | 259,851 | 0.006496 | 23 | pass |
| run1:combo | buyback run RCOMBO | `0x1b30dc575ceab2803f96c4af6c0205528e4ca3301d8df2efa189ce0a7c5c00c8` | 203,817 | 0.005095 | 20 | pass |
| drip1:holders | dripAndClaim RHOLD | `0x4e4463619b3955db74fec07a40a363c7520e61b791fec237aa279a84d828aedd` | 202,734 | 0.005068 | 16 | pass |
| drip1:combo | dripAndClaim RCOMBO | `0x26bda183828a7e2632c90a3a567ec3d6576ad34a5964e282fd1b68099fc35c0d` | 202,734 | 0.005068 | 16 | pass |
| graduate:wallet | buy RWALLET out (graduation) | `0xcec1fa8fb2c70fe5956512fe8fe802d391b6f3b4c60057413c689e9d77b9b770` | 248,944 | 0.006224 | 26 | pass |
| graduate:split | buy RSPLIT out (graduation) | `0x09a90a649835405a70673a5998e5af0ab13ee4b69a775f3e70810b095eeb67d1` | 248,944 | 0.006224 | 26 | pass |
| graduate:buyback | buy RBURN out (graduation) | `0xcd690b5c2ef6a5612a757ce0ebf41f427fdef905484c3be9553f63084cc64698` | 231,844 | 0.005796 | 26 | pass |
| graduate:holders | buy RHOLD out (graduation) | `0x59ae2fdf29e956f06ba43edf3666ee2dbd59a672a0db4067a63ec86be674ac98` | 272,521 | 0.006813 | 26 | pass |
| graduate:combo | buy RCOMBO out (graduation) | `0x5698d820a0bc7902da368e29f68fca6c62ee710ab9be3e7f2257f8df19831c20` | 255,421 | 0.006386 | 26 | pass |
| poolbuy:wallet | buy RWALLET (launch router) | `0x1832304cfbbb4fa5a2f23fc0ff4d9ab554a0cf61236de96fcc6cb94503010d12` | 122,929 | 0.003073 | 11 | pass |
| poolsell:wallet | sell RWALLET (launch router) | `0xcce9a8d2378fb6d84e5c9ad0d1dea72372e84992f18d425367304009556044c3` | 125,997 | 0.003150 | 11 | pass |
| poolbuy:split | buy RSPLIT (launch router) | `0xfa66ce7c30240a81c908083a0d89309fc9cc55794cbbbc6120cb7b5345a4dd0c` | 122,917 | 0.003073 | 11 | pass |
| poolsell:split | sell RSPLIT (launch router) | `0xc2e531343b167835fbff81983d41d580ebb26c21a4fe70647eb0b865a2c6a368` | 125,985 | 0.003150 | 11 | pass |
| poolbuy:buyback | buy RBURN (launch router) | `0xfa9faa16f64a4e5f5cff96d5319249bf5fd79843247f6db9db65c2dd24c86a60` | 122,929 | 0.003073 | 11 | pass |
| poolsell:buyback | sell RBURN (launch router) | `0x77d4b9767a789b7b23aae5cfd6cc9f56bdf8a01f50c86e6f838a8e228b7ba53b` | 125,997 | 0.003150 | 11 | pass |
| poolbuy:holders | buy RHOLD (launch router) | `0xf5f0db1f7dda84977680bda12dc09da687046d84864a35ce14ab5e2852233cfd` | 128,907 | 0.003223 | 11 | pass |
| poolsell:holders | sell RHOLD (launch router) | `0x831f91690bf178fe52695331d7741a3e2a0e43409185108c79178e751e653eb2` | 132,003 | 0.003300 | 11 | pass |
| poolbuy:combo | buy RCOMBO (launch router) | `0x48c57f12118eee76266016a596e3bd52d7cfcf8e68f5adfd5426587352f34979` | 128,907 | 0.003223 | 11 | pass |
| poolsell:combo | sell RCOMBO (launch router) | `0xa48eb83191ccc767d4380bd080b703673c25bb4c942d72bdfbab4e9cdc45298b` | 132,003 | 0.003300 | 11 | pass |
| collect2:wallet | collectCreatorFees RWALLET | `0x7efb33cf5c95fbe7be3fa7469671245a7055003e38202b52fa80af89a14087dd` | 46,599 | 0.001165 | 8 | pass |
| collect2:split | collectCreatorFees RSPLIT | `0x4a5adaa7673724fdd85a76bffdeefae421015b44cfaee8bfd1ad155242e5c52e` | 80,362 | 0.002009 | 11 | pass |
| release2:split:1 | release payee 1 | `0x1503acebdc7179fa34884c61b09a9757f728f6b630bb6ab3444a012d2e93f304` | 59,402 | 0.001485 | 7 | pass |
| release2:split:2 | release payee 2 | `0xb85ebaf6fdda136bdca3d6ed29fe377a9aedc8b21502f57b2b1be359f6a9b119` | 59,402 | 0.001485 | 7 | pass |
| release2:split:3 | release payee 3 | `0x640a3a6269d67fee88e8009c117ffbbb3bb8c5babe833f67044256cac451d3a6` | 59,402 | 0.001485 | 7 | pass |
| collect2:buyback | collectCreatorFees RBURN | `0x5e0c3a7ef81d1950b0858ba20c5eb6c60abc2e7fee1bbb84727c74c6250b14ed` | 80,381 | 0.002010 | 10 | pass |
| run2:buyback | buyback run RBURN | `0x5ed301772bfde26c13ca721b7e0f752cb92753aa8fc12e23d4260b0dede962d6` | 188,281 | 0.004707 | 21 | pass |
| collect2:holders | collectCreatorFees RHOLD | `0xd038080d5aa154b6b3d6e34d71a2be34f7777c7b4eea52442f6c7756ac4e1312` | 144,286 | 0.003607 | 14 | pass |
| collect2:combo | collectCreatorFees RCOMBO | `0x7547185c2aaff911ae84a105841d5f0869c50a8cd99fd6587c132f854467e77a` | 262,328 | 0.006558 | 22 | pass |
| run2:combo | buyback run RCOMBO | `0xc48f7fbd985a8affc774ebacaa70b45afc3f5a5d192e76160079d9127fba82d1` | 207,718 | 0.005193 | 21 | pass |
| drip2:holders | dripAndClaim RHOLD | `0x6dccee4f9bb1916934cbe9211ccdfa301e4f782a19a441d9e6668a5c2c00f57f` | 117,234 | 0.002931 | 16 | pass |
| drip2:combo | dripAndClaim RCOMBO | `0xa708ebf69d57d88bc1d1d1ab23a4cbf1d6a5283fb210469b5df870e818a8718f` | 117,234 | 0.002931 | 16 | pass |
| collectFees | collectFees | `0x8aa61ef3e157b1681c3ed448502ce3ab8fd6641e7000218ce7eb9cf32583dc72` | 43,675 | 0.001092 | 7 | pass |

The `sample1` and `sample2` steps send no transaction and ran 8 checks each; `final` ran 16. Every step passed on its
first attempt on Arc Testnet.

### Arc's USDC: deploy and drive

| step | transaction | tx hash | gas | USDC | checks | result |
| --- | --- | --- | ---: | ---: | ---: | --- |
| deploy | launchpad | `0x51ae74ebfe04b0c5e9213a03fc3b75fae5a9a836ccb36fbf0b7eb05a4f896790` | 4,171,762 | 0.135582 |  | deployed |
| deploy | pairFactory | `0xca607da1f83ae10e5fc9298b7b1a840ac15b94367e979c50ac7345ba1b687c05` | 1,856,048 | 0.060322 |  | deployed |
| deploy | router | `0xb815577df1d2cb33250893f989f2018805538399e675072c16fafbea37601f76` | 785,446 | 0.025527 |  | deployed |
| deploy | initialize | `0x3fa52bbb6ab06434c3f72873249ad77aca1298874dd18f3de609789868405254` | 76,992 | 0.002502 |  | deployed |
| deploy | split | `0x70328f09e6add040f22648efac2f24d34585b33b22dbf243740e731fedade2d4` | 979,110 | 0.030720 |  | deployed |
| deploy | buybackBurn | `0xa47b4ae93c5625870aba87396177bb53b46822f4cd07c9f184f8e6467d12fbbe` | 1,034,422 | 0.032455 |  | deployed |
| deploy | holders | `0x9bf92c3b8727d3d8cc96178e733cc9b1080e023b0899b6c020f513b13406dbe1` | 932,502 | 0.029257 |  | deployed |
| deploy | combo | `0x780ff888052c0874f161bd1a23577eb0862f323dd703a77942482c7fccf84fdc` | 1,314,573 | 0.041245 |  | deployed |
| approve | approve launchpad | `0xb7374a6ff009a1c4d0c17593e152c526285c3e5a0ca1837685bd33f89a7869f8` | 55,426 | 0.001386 | 2 | pass |
| create:holders | createToken RHOLD | `0x3df8feec086b24a89bf49c8ea61c430efb38e4eb9ff9781b40824aac7c77545d` | 2,850,179 | 0.071254 | 28 | pass |
| create:combo | createToken RCOMBO | `0xb5e70ab06c6395519d15c2d08bd0bd68aa74c99135df8ff978de855bfd64a458` | 2,980,264 | 0.074507 | 26 | pass |
| buy:holders | buy RHOLD (curve) | `0x504c704071e69171998d925bf47710ca571777722aadfee083614fa55fb7041f` | 107,824 | 0.002696 | 15 | pass |
| sell:holders | sell RHOLD (curve, half) | `0xacb83ac417b90a2537c2c087acdcb5a425d4138831719689bd0dd468d5e56c7e` | 101,504 | 0.002538 | 11 | pass |
| buy:combo | buy RCOMBO (curve) | `0x2c1635cdf6cf51e8e8b7c60fb53f6eda5d016920e811c312be44c46d85c8fbcc` | 107,824 | 0.002696 | 11 | pass |
| sell:combo | sell RCOMBO (curve, half) | `0x10a6a66f221844af0ebffe16dafbe2aa5280eeb9484db683b75b9688e27af6fa` | 101,504 | 0.002538 | 11 | pass |
| collect1:holders | collectCreatorFees RHOLD | `0x898cdda48015cbf83d52fca727ebb966d05139db0730baa98e0ea959f6d11a22` | 131,053 | 0.003276 | 14 | pass |
| collect1:combo | collectCreatorFees RCOMBO | `0xf570e33cf9339892e279837eb8dfb9f13f10aed6526c8e3b4af27f1d3873db9e` | 290,134 | 0.007253 | 22 | pass |
| run1:combo | buyback run RCOMBO | `0x202ff8484f7e815aafef158b1207701fd19cb97a392d563a7f016467f617ddf3` | 215,624 | 0.005391 | 18 | pass |
| drip1:holders | dripAndClaim RHOLD | `0x7076c24764ec15b53b21c339896359654fdf7c80b0728e7a29e26ef1681bb074` | 208,002 | 0.005200 | 15 | pass |
| drip1:combo | dripAndClaim RCOMBO | `0x61219147b410a44a095294a0c052e74f7928ecb7648b045bd9bc8e7333c37f3b` | 208,002 | 0.005200 | 15 | pass |
| collectFees | collectFees | `0x495b7b1a705fc928bd347a11fb8305f93b6b3276046298afd7ee345457a0d26e` | 55,950 | 0.001399 | 6 | pass |

`sample1` ran 8 checks and `final` ran 10. The cap never came into play here: the buyback offered its whole 0.042265
USDC against a 20.83 USDC cap.

## Notes from the real chain

**Gas per step**

| Step | Gas (rUSDC / Arc's USDC) |
| --- | --- |
| `createToken` (deploys a LaunchToken and a LaunchPair) | 2.79M–2.98M; Split and Combo configuration adds ~0.18M. About 0.07 USDC, the costliest step. |
| Curve buy / sell | 92k / 89k on rUSDC, 108k / 102k on Arc's USDC |
| Sell-out buy, pair seeding included | 232k–273k |
| Launch-router buy / sell | 123k–132k |
| `collectCreatorFees` | 47k–64k to a wallet, 80k–108k to Split or Buyback, 130k–144k to Holders, 260k–290k to Combo |
| Buyback `run` | 188k–216k |
| `dripAndClaim` | 117k when warm, about 205k for a holder's first claim, which writes fresh storage |
| Deploying the suite | 11.2M (0.36 USDC); rUSDC adds 0.67M |

Every call that moves Arc's USDC costs 9k–16k more gas than it does on an OpenZeppelin ERC-20. For example, `approve`
is 55k against 46k.

**Gas price.** The driver paid 25 gwei: a base fee of 20 plus the node's suggested 5 gwei tip, so 1M gas is about
0.025 USDC. Forge's own fee estimate paid 32.5 gwei for the deploys, 30% more.

**RPC**

- Blocks come about every 0.5 s. Receipts arrived within 1–3 s.
- Bursts are refused with `Request exceeds defined limit`: of 100 parallel `eth_call`s, about 30 succeed.
- A read at a block the serving node has not reached yet returns `Requested resource not found`.
- Both errors clear on retry with backoff. The rUSDC drive retried 10 requests; the Arc-USDC drive retried none.
- Historical state is served: every check reads at a transaction's block − 1, and a probe 500,000 blocks back
  answered. This is what makes the block-exact checks and the resume work.
- `eth_call` at block B runs with `block.number == B`. The same-block buyback check depends on this.

**Holders plugin rounding.** The deployed plugin is the committed `c508af3` version, which rounds the re-weighted
stream end up. `streamAfterFees` in `scripts/v13-rehearsal.ts` mirrors that rounding. If the plugin's rounding
changes, the model must change with it: the stream check after a second delivery is exact.

**What is left on chain**

- rUSDC deployment:
  - Five graduated pools, each holding about 25,230 rUSDC against 198M tokens.
  - 3,660.21 rUSDC still dripping to RHOLD and RCOMBO holders (their 24-hour streams).
  - 1,349.97 rUSDC waiting in Buyback & burn for later runs (at most 0.25% of the pool per run).
  - 5.68 rUSDC of creator fees accrued from the last buyback trades.
- Arc-USDC deployment:
  - The burner still holds RHOLD and RCOMBO worth their curve floats (0.537 + 0.600 USDC). Selling them back recovers
    most of that.
  - 0.216 USDC is still dripping in the holders plugin.
  - 0.021 USDC went to the Combo's fixed wallet, which nobody holds a key for.
- The burner ended at 8.089 USDC.
