# Launchpad v1.3: the Arc Testnet rehearsal

This is step 2 of the v1.3 rollout (V13-SPEC §8). The whole suite was deployed on Arc Testnet (chain 5042002) with a
mintable test USDC, and every reference plugin was driven through real transactions. All five test tokens were
graduated into their launch pools and traded there, and the books were checked to the unit after every transaction. A
second deployment on Arc's own USDC repeats the curve half with 1 USDC trades. Arc's USDC is a chain-native precompile
that no local fork can execute, so only a live chain tests it.

It ran twice on 2026-09-21, each time on fresh deployments:

- **Second run: the reviewed contracts at `05e7abc`.** This is the current code:
  - dividends stream inside `LaunchToken`, and the holders plugin only forwards to it;
  - Buyback & burn is paced by time;
  - `createToken` refuses destinations that could never pass fees on;
  - curve trades take a deadline.

  `deployments/arc-testnet-v13-rehearsal.json` and `…-realusdc.json` point at this run.
- **First run: contracts at `c508af3`.** That code had a plugin-side 24-hour drip and a per-block buyback cap. Its
  addresses and results are kept at the end of this file. Its deployment files are in git history, at `5e11fc6`.

| Run | Transactions | Checks | Result | Gas | Cost (USDC) |
| --- | ---: | ---: | --- | ---: | ---: |
| **Second run** (`05e7abc`) | | | | | |
| rUSDC: deploy | 9 | 48 (wiring) | pass | 12,307,068 | 0.378571 |
| rUSDC: drive (5 tokens, 5 graduations) | 60 | 1,065 | pass | 23,762,505 | 0.594063 |
| Arc USDC: deploy | 8 | 46 (wiring) | pass | 11,620,722 | 0.377673 |
| Arc USDC: drive (2 tokens, curve only) | 13 | 265 | pass | 8,241,109 | 0.206028 |
| **Second run total** | **90** | **1,424** | **all pass** | **55,931,404** | **1.556335** |
| **First run** (`c508af3`), total | 88 | 1,173 | all pass | 51,582,690 | 1.457185 |

In the second run the burner's balance fell by 2.933226 USDC. That is exactly the recorded gas plus the 1.376891
USDC the Arc-USDC run left in its curves and plugins (nonce 121 → 211, all 90 transactions its own). Across both runs
the burner went from 10.92 to 5.16 USDC.

**No contract behaviour contradicted the spec, in either run.** Every deployed contract matches the local build byte
for byte (`scripts/verify-bytecode.ts`, immutables and metadata hashes masked). In the second run, two checks
initially failed; both were the script's expectations, not the contracts, and both steps passed when re-checked
without re-sending:

- a claim mined in the same second as the block before it;
- a stream paying under 1 unit per second.

## Second run: reviewed contracts (`05e7abc`)

### Addresses

**On rUSDC: `deployments/arc-testnet-v13-rehearsal.json`.**

- Launch fee 1 rUSDC. `feeTo`, `feeToSetter` and the rUSDC owner are the dev burner
  `0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46`.
- The rUSDC faucet is closed.
- The fee recipients are the same in both runs; see the table below.

| Contract | Address |
| --- | --- |
| rUSDC (TestToken "Architex Rehearsal USD", 6 decimals) | `0x309297011592BA9a157204e57EB0AF2175D8ceed` |
| ArchitexLaunchpad | `0xCEbf26B8d49963860B09851a1d27C73fd4b6DC37` |
| LaunchPairFactory | `0x171b4969F54b896EBD518eC5D857181D9766B78D` |
| LaunchRouter | `0xd4561e380219F6BFb798b52A1F9bcB8445d8CE52` |
| SplitPlugin | `0xBC28f21B476E33BCbccD92a1831A68ca44993Ea5` |
| BuybackBurnPlugin | `0xD1A52781CbB1F990e1c0d471FeC6E00E99CE631B` |
| HolderDistributionPlugin | `0xED3D99A33f9c25c9077a0aFD399b5B36504484A9` |
| ComboPlugin | `0x3F6a480dBb609256A8EdF943456Afec1f565f0c8` |

| Token | Creator fee → destination | Token address | Launch pair (graduated) |
| --- | --- | --- | --- |
| RWALLET | 2.5% → a wallet | `0x3b9a1677190432d4C062C398163975b274423433` | `0x3232e81a054D6fdb90D47D76B3b2600aC22CB647` |
| RSPLIT | 5% → Split 5/3/2 | `0x9c177c3C3E516B31d008Ae5072a888cBd6050897` | `0x43eC42a3CaA2286F6Ab077C4c45E7E281f4ec143` |
| RBURN | 3% → Buyback & burn | `0x451cBD60331084A9D21465D576EE3D4CC06110d8` | `0xbed005ddD6d1b2EE88848b37e443BAD4CcD3B46e` |
| RHOLD | 10% → Distribute to holders | `0xA94A6971AA3b35D611600aB19e1B18A1737132dD` | `0x8c7e9D6A634097785897557971E7D66401C7F9D9` |
| RCOMBO | 6% → Combo 40% buyback / 40% holders / 20% wallet | `0x7A87Ad9228Ed3231de90c78EbFcB3218AC78831b` | `0x07083A2c99635F92C2D39Ec7546c7ce81D01DF3e` |

The fee recipients are fixed addresses that nobody holds a key for. Each is the last 20 bytes of
`keccak256("architex/v13-rehearsal/<label>")`, so they are not contracts, and the script derives them again on every
run:

| Recipient | Address |
| --- | --- |
| creator wallet (RWALLET) | `0x31Df2cbf797b4DA444627ADC663e763087CC28e5` |
| Split payees, shares 5 / 3 / 2 | `0x50592B98c85E1BfDF2947cE4BE2aE63eE2523578`, `0x490Fc2a021F7495B144956C8c1CD311f3f2902d8`, `0x02Ea037C35704535F964de40aF03704c6Af053C5` |
| Combo's 20% wallet | `0xD3A421c7bCd3162510C3857b19ff82b34Bf40155` |

**On Arc's USDC: `deployments/arc-testnet-v13-realusdc.json`.** Launch fee 0; `feeTo` and `feeToSetter` are the
burner.

| Contract | Address |
| --- | --- |
| ArchitexLaunchpad | `0x02Bf15bc8caB1b5BCf210C1C55bA2c91AC20164E` |
| LaunchPairFactory | `0xe538e1C2d08D5014CF89715F53F3135Aa8E34905` |
| LaunchRouter | `0x63E473AD3d1A7CE84E9Ea5C7435BEFf89cb4e833` |
| SplitPlugin | `0xF0C5815902E1F37CD68dc9188dd0b0e4Dc2fD89E` |
| BuybackBurnPlugin | `0x90b5cF731D7237027e6a8F43F36ad849888b6cA1` |
| HolderDistributionPlugin | `0xdbF1Fb8605C6Aa4E1f8AE01b2342AC4945357529` |
| ComboPlugin | `0x5524604ea4c589b3e0EcDd4A5Af1d75E39C341bE` |
| RHOLD (10% → holders), on the curve | `0x102a44433A807271235673CeA0Ef902bfDD28a9D` |
| RCOMBO (6% → Combo), on the curve | `0x7786ffF00c1Eb22ACF2Aa1627C4901a9C7Dd7F1c` |

### Results: rUSDC, deploy and drive

| step | transaction | tx hash | gas | USDC | checks | result |
| --- | --- | --- | ---: | ---: | ---: | --- |
| deploy | rUSDC | `0x74b65724481bfd7219d4f10530fedf954ca8bd62bdce467872e97c476663f6d2` | 665,954 | 0.021644 |  | deployed |
| deploy | launchpad | `0x248bc0db6e0cbe4ca9892f4c2d1ed2c3a61c6b51844a50c0b2a816f7210ceedd` | 4,770,440 | 0.155039 |  | deployed |
| deploy | pairFactory | `0xae9635f47b073e6870d9b9af706b564c073a81a5f734b3875bb1e82f7ce6977f` | 1,856,026 | 0.060321 |  | deployed |
| deploy | router | `0x2106366307608870347a1f24fbf7011821007c40c139531d0e1c52d13838336b` | 785,652 | 0.025534 |  | deployed |
| deploy | initialize | `0x92e46a3bb13424eb7c29a2e9015a7082d8c4fc18c5cbf098686419948c26c3a6` | 76,948 | 0.002501 |  | deployed |
| deploy | split | `0x2010b7aba3339c36d063248d56dcca985caa7996b33e2e788ea3fb7586aea1c6` | 1,069,067 | 0.029232 |  | deployed |
| deploy | buybackBurn | `0x37e0410bf1d89e783d6c0d28a5551f172cd56efa6fd61ab4b6abace90e8b04d8` | 1,093,397 | 0.029898 |  | deployed |
| deploy | holders | `0x45a85886c0fdc8e8c11158e9f9c60758e076f444fc43f78c42c66051dd414cdd` | 586,632 | 0.016041 |  | deployed |
| deploy | combo | `0xb6e0fbca6ab2ed6207e4049fd2762f4048c8495549dd1040d47d3b766a7b501b` | 1,402,952 | 0.038362 |  | deployed |
| fund | mint rUSDC | `0xd908aee75bbd864388535ea365d6a576428f33d603d34c3f9de72e6c613c3d5d` | 70,254 | 0.001756 | 4 | pass |
| approve | approve launchpad | `0xadc9e787a815d87aff1034e575d4549ce44baec0045b964ee05c205b82cb8ea8` | 46,266 | 0.001157 | 6 | pass |
| approve | approve router | `0x5f8d1963501d2247218986913cfc664b095543a53c39103d60426a94426360b8` | 46,266 | 0.001157 |  | pass |
| create:wallet | createToken RWALLET | `0x4682115e390a8ced4d7ba1cb07c7c0c70df8678743f721f54679bb110836d947` | 3,233,748 | 0.080844 | 45 | pass |
| create:split | createToken RSPLIT | `0x1fcf013705dc08a5a6ac3b7f7c6492ae43b029cefbb93a2eddc81d59fb91a2b7` | 3,416,441 | 0.085411 | 33 | pass |
| create:buyback | createToken RBURN | `0xd7c5fc6ccbe1a39b0526606101ba46e9055e87aaec65ff9a010242c89b8c1abc` | 3,196,231 | 0.079906 | 31 | pass |
| create:holders | createToken RHOLD | `0x72efab7e6487815421cbe8b9a4f4e1a85a0d8229cc286ffde12153e591c7fdf6` | 3,195,988 | 0.079900 | 31 | pass |
| create:combo | createToken RCOMBO | `0x29ea494731aec31eb08132e788487b6f1c9c2206ab2f2fbc35ce62c3a80730a7` | 3,408,161 | 0.085204 | 32 | pass |
| buy:wallet | buy RWALLET (curve) | `0xdfbcbbf44f2ec96585dc4a676fda901111dda273e7cee6f45be21a8970ebe8ec` | 98,470 | 0.002462 | 21 | pass |
| sell:wallet | sell RWALLET (curve, half) | `0x6786a7f243ac9a859252b5fcfaae43510a460188f154e368f1c9bd26bc6880a8` | 95,922 | 0.002398 | 15 | pass |
| buy:split | buy RSPLIT (curve) | `0x6493459ae56d615be5d3c4ca1d1614d9320a4700d51597b83ddb878464f1fdc6` | 98,470 | 0.002462 | 15 | pass |
| sell:split | sell RSPLIT (curve, half) | `0x66af015b67b34026e14d77dabef1879e39b3116c4cec2dc87e428a4475e492ec` | 95,922 | 0.002398 | 15 | pass |
| buy:buyback | buy RBURN (curve) | `0x7afac07807c146528eb2587ca3bf4d1c983cbfb8390389c70e78afb43be7c40b` | 98,470 | 0.002462 | 15 | pass |
| sell:buyback | sell RBURN (curve, half) | `0x9b67612d0c2be9ac050f610e81d3816f591d25821204e3b49b0f4ff4717fa422` | 95,922 | 0.002398 | 15 | pass |
| buy:holders | buy RHOLD (curve) | `0xe3e2d0ea516b7ddc0e9aac4acdeb1a8d5b393ef3da71cd116c106d57430c671c` | 98,470 | 0.002462 | 15 | pass |
| sell:holders | sell RHOLD (curve, half) | `0x98941671fa4d904630a29253ec9e2690c91718643ab9d978f181d87f68cdd3b9` | 95,922 | 0.002398 | 15 | pass |
| buy:combo | buy RCOMBO (curve) | `0xb5c7dca28024c3cd87ad51ade7355a7641dab78a1e80e29042297706fca6f8a0` | 98,470 | 0.002462 | 15 | pass |
| sell:combo | sell RCOMBO (curve, half) | `0x738d050a4e514030b6613277a97c440accc78e4ce37aea900e473049fdb4a65b` | 95,922 | 0.002398 | 15 | pass |
| collect1:wallet | collectCreatorFees RWALLET | `0x190a043b940d56423ad695c0fb6c2f53af228e8e0d6e68debde828e3cbf125d8` | 63,655 | 0.001591 | 8 | pass |
| collect1:split | collectCreatorFees RSPLIT | `0x29c7c39c7e03b509cc98c73aca2c3c0b27da7c5f22e54df12c7fe998236c24bd` | 107,687 | 0.002692 | 11 | pass |
| release1:split:1 | release payee 1 | `0x81fa85f7801eb642bedf7976cd3c26025595501d0cdf0fdbe62ccd643f39e0fa` | 110,702 | 0.002768 | 7 | pass |
| release1:split:2 | release payee 2 | `0xb8a290d5ef4de94bba62c9edadd4ae7cb208a8029f73753ed425d507d5eaeb7c` | 93,602 | 0.002340 | 7 | pass |
| release1:split:3 | release payee 3 | `0x6ce606c382a5a4b3070bad094068140d157c31b8d4720c207a25bd5acdae7119` | 93,602 | 0.002340 | 7 | pass |
| collect1:buyback | collectCreatorFees RBURN | `0xa74edc6079ab57c1b699ad65d1649bb1be0f8c2510d43536e8d1bebae2279fc2` | 107,724 | 0.002693 | 10 | pass |
| run1:buyback | buyback run RBURN | `0xf805100ab37235e31b281d120b879cb769cb3634ee288ca9c0a0f3c06e18d64b` | 231,529 | 0.005788 | 23 | pass |
| run1b:buyback | buyback run RBURN | `0xd3b9245a3c0dc8a15e320090d227dcd378409bd34eded602db861f62bfcf766f` | 155,510 | 0.003888 | 24 | pass |
| collect1:holders | collectCreatorFees RHOLD | `0x86ad28a131c695ab63965ce005699caabbffda3203d0b2bea02f10b19fcf54ce` | 196,840 | 0.004921 | 15 | pass |
| collect1:combo | collectCreatorFees RCOMBO | `0x59ac58528f8bc1ed0f20c092beb2104c955e6e4e84ff74fd3d253a7b649039a7` | 342,260 | 0.008556 | 23 | pass |
| run1:combo | buyback run RCOMBO | `0x659c0108d8f6c732ef3fe0b71247ea98ca816eb910d0dcccef43bdb2457791f5` | 260,916 | 0.006523 | 23 | pass |
| run1b:combo | buyback run RCOMBO | `0x7b1a6d8875ee1abb5a593090257a8e5ff656081da963c78dcea0bc13d1038d4a` | 178,962 | 0.004474 | 24 | pass |
| claim1:holders | claim RHOLD dividends | `0x744c78596a8b7cb59cb897224a98ff6a4cf34004c9950857747c65693f9849ff` | 98,531 | 0.002463 | 14 | pass |
| claim1:combo | claim RCOMBO dividends | `0xb25a0d85fdf9618d708cd836970d8226e6b78c631282e07558c844df58a89e8a` | 81,431 | 0.002036 | 14 | pass |
| graduate:wallet | buy RWALLET out (graduation) | `0xb7145e6938732aef30d340762e614e76bb3489e231c92f61b39424b73082ac0d` | 256,909 | 0.006423 | 29 | pass |
| graduate:split | buy RSPLIT out (graduation) | `0x2d70159d511fe866870f1a9d781ebfa3f745e6d36e7e48bb1f4ad01a7544ec98` | 256,909 | 0.006423 | 29 | pass |
| graduate:buyback | buy RBURN out (graduation) | `0x56eb22436b31eb44242b6b99c0af8b8216018fc81b3e081b8aa8159991a8f11a` | 239,809 | 0.005995 | 29 | pass |
| graduate:holders | buy RHOLD out (graduation) | `0x45ddcc57bd6c289df1a2555fe71b8805ea5fa644c3f358a91a283a93f1cdce85` | 285,853 | 0.007146 | 29 | pass |
| graduate:combo | buy RCOMBO out (graduation) | `0x0c14284e1d138bd7a16041c5bcc7264ee6b93ba6b8b909fe163a3614c0d08b7b` | 268,753 | 0.006719 | 29 | pass |
| poolbuy:wallet | buy RWALLET (launch router) | `0x36a49edf501867609505d953bb4ff38b013a84c5b66970533afb7e715772ad13` | 129,288 | 0.003232 | 14 | pass |
| poolsell:wallet | sell RWALLET (launch router) | `0xf198dfa6ee4f9e2a55434d1c5b7562a0784e60784f8ff7f4ce27d8a3d2200805` | 132,335 | 0.003308 | 14 | pass |
| poolbuy:split | buy RSPLIT (launch router) | `0x6e7b72922d8644fdfea275e9299605994b70d4ac9aec751b96cd1a0d0c2d4279` | 129,276 | 0.003232 | 14 | pass |
| poolsell:split | sell RSPLIT (launch router) | `0x27bc8c9649cd9dbee0d692bcdee760bf05e12f5848e051c614f4111c771c1b9d` | 132,323 | 0.003308 | 14 | pass |
| poolbuy:buyback | buy RBURN (launch router) | `0x14d3e851028719fd4f651cd1468e36aa0d50b31f609bf377de9503298a4c8ffa` | 129,288 | 0.003232 | 14 | pass |
| poolsell:buyback | sell RBURN (launch router) | `0x595bec63060439531e631d42a8a7ca68307f9fc6197ec1cff786bbfce3991681` | 132,335 | 0.003308 | 14 | pass |
| poolbuy:holders | buy RHOLD (launch router) | `0xef14076ba9a68b15ccf1848638449a189fd4d29354c5bc26571d1c7d75d5a890` | 140,884 | 0.003522 | 14 | pass |
| poolsell:holders | sell RHOLD (launch router) | `0x0052d4b7e66034bfea0f7caad350d944a88edeae4206411ab7ee78218a7c28a9` | 143,959 | 0.003599 | 14 | pass |
| poolbuy:combo | buy RCOMBO (launch router) | `0x1b020b3f59359835f0fc89afdc684c150d13248c5b4ccee62a02da24520bbe6b` | 140,884 | 0.003522 | 14 | pass |
| poolsell:combo | sell RCOMBO (launch router) | `0x3be07972111c295314ad025eab41d7c18796739bfd24f90499447af8fa009101` | 143,959 | 0.003599 | 14 | pass |
| collect2:wallet | collectCreatorFees RWALLET | `0xe651e44784c8fb4c772d1c19bda76c53876bc87cac8bcbcdc4891e81bf9b5b30` | 46,555 | 0.001164 | 8 | pass |
| collect2:split | collectCreatorFees RSPLIT | `0xbe463009bd91d2dcb84dcb204e367040b6bb859ea1ebdd6f8744981ff7815107` | 80,327 | 0.002008 | 11 | pass |
| release2:split:1 | release payee 1 | `0xe3475498e728213fe9d6921dbb57c4e086aceab037779ee0b3f0742af7b14f00` | 59,402 | 0.001485 | 7 | pass |
| release2:split:2 | release payee 2 | `0xe86a2e49bda4b24687d0622df3f65f72573dbe53810b69a944821093a01b2d66` | 59,402 | 0.001485 | 7 | pass |
| release2:split:3 | release payee 3 | `0xb2b93b08ac9786280aded2bfaaf52a26f7e11d2bf2e6223b4c2cae72671278f0` | 59,402 | 0.001485 | 7 | pass |
| collect2:buyback | collectCreatorFees RBURN | `0xad04bbb63361e35778357f95ee5b2b02f8155e34e744f9e18de04f7c385e0d3a` | 80,364 | 0.002009 | 10 | pass |
| run2:buyback | buyback run RBURN | `0xde974f9146895b2157170d20980ee91b1c6e42ebc3c9e8ddb998feb7f0c31a3d` | 198,876 | 0.004972 | 25 | pass |
| collect2:holders | collectCreatorFees RHOLD | `0x3377880d21658d3ed05d150fc21d1773534e4c581be23b6c80e27b41ad406bb6` | 147,200 | 0.003680 | 14 | pass |
| collect2:combo | collectCreatorFees RCOMBO | `0x96286c811c219c97f2fd7eb2bb0dda3cac1e73e2961a3ac66a3f58bfdf0bc55b` | 265,260 | 0.006632 | 22 | pass |
| run2:combo | buyback run RCOMBO | `0xffe1a10218bb384171421af2cb19e112a9ffed53cb0ba6990d0c53a5127b593e` | 222,328 | 0.005558 | 25 | pass |
| claim2:holders | claim RHOLD dividends | `0x27bb6c560df7e8003ddf8cdbd42ac98b94f377fcaa58d165d69f343c8d876133` | 64,331 | 0.001608 | 14 | pass |
| claim2:combo | claim RCOMBO dividends | `0x9cc9a44f51e7c5323da7014d41ef3225a3a7ef13a9ab7b63b71e011511a0d75f` | 64,331 | 0.001608 | 14 | pass |
| collectFees | collectFees | `0x214c8f78bf1a264d458641e31ea34bc4416cbb6ce31c58440a8a75d4bda25fa0` | 43,697 | 0.001092 | 7 | pass |

`sample1` and `sample2` send no transaction and ran 12 checks each; `final` ran 37.

### Results: Arc's USDC, deploy and drive

| step | transaction | tx hash | gas | USDC | checks | result |
| --- | --- | --- | ---: | ---: | ---: | --- |
| deploy | launchpad | `0x82315939a8c56ca3b1e0ec00f297d970303e6823d55940809168340e4f3deff5` | 4,750,276 | 0.154384 |  | deployed |
| deploy | pairFactory | `0x4330b5954d76026a50a692f4a99f8a8fb8a9436ee37387b84c260dc0843da470` | 1,856,026 | 0.060321 |  | deployed |
| deploy | router | `0xa8ca5b1e3547ec0286d0747e06b11514b4fb9035ea63becaf6ef835d10abed9c` | 785,424 | 0.025526 |  | deployed |
| deploy | initialize | `0x042e1bb70f591ef5c542b20fd889f14c755c0684031e1493fb7e3ad68846f2ba` | 76,948 | 0.002501 |  | deployed |
| deploy | split | `0x76ff7486f8efe03cef8da14ecdb33a543619d616e526aa166784c3fd418923a2` | 1,069,067 | 0.034745 |  | deployed |
| deploy | buybackBurn | `0xd954d90daf61e30260988e788b2547ee6ad7ebee0dbfe2b25bfabb95e1fa5293` | 1,093,397 | 0.035535 |  | deployed |
| deploy | holders | `0x718456aea019b8fb1915c43045097eaf94e152203219c92a738f4fe7f68ba381` | 586,632 | 0.019066 |  | deployed |
| deploy | combo | `0x56397cbb5dd23a5ea6e1aff4ea9e16fc01e49c1b09fb703dad04869caa0cf847` | 1,402,952 | 0.045596 |  | deployed |
| approve | approve launchpad | `0x99e55f1a89cd1f3de93ac381b8a3dbb86f1885bc449be975f850e046816616b6` | 55,426 | 0.001386 | 2 | pass |
| create:holders | createToken RHOLD | `0x334cd52a9ea885587bde0fda3d03d28d94b2844ac057ba40c309790e9465ac1e` | 3,259,448 | 0.081486 | 44 | pass |
| create:combo | createToken RCOMBO | `0x548f62287c837907e7300bbd01fec7d19a21c8c7a50615396998a9a821bb9c99` | 3,420,321 | 0.085508 | 31 | pass |
| buy:holders | buy RHOLD (curve) | `0xd7483a03a1cdc4accfc58a8b1949bcf4cf131982a5e6967fd02408b2d1cfcead` | 114,718 | 0.002868 | 20 | pass |
| sell:holders | sell RHOLD (curve, half) | `0x9c7d0c36a88350a1221db693d9bbfd80af1ed3979c64f313cbdbf0e53af2adeb` | 108,173 | 0.002704 | 14 | pass |
| buy:combo | buy RCOMBO (curve) | `0x202db649570ba1e6c1057e529fbba6c3afc68ab9982803806adcbb50ca7fbfea` | 114,718 | 0.002868 | 14 | pass |
| sell:combo | sell RCOMBO (curve, half) | `0xf1f03359e4816b3455e2956e13bd4b848612c30632fb693fbf3d9c6fc615dcb4` | 108,173 | 0.002704 | 14 | pass |
| collect1:holders | collectCreatorFees RHOLD | `0x86d4805b5438eacf9fad10f66bea3f4dd84e592e12c98f973affd4363c5a3454` | 192,189 | 0.004805 | 14 | pass |
| collect1:combo | collectCreatorFees RCOMBO | `0x627fe774c0c14e4107293f4ea5595e65a3de7544a9efe234543fba9158f93331` | 333,258 | 0.008331 | 22 | pass |
| run1:combo | buyback run RCOMBO | `0x3ecea3d2e7838591e828067f652ac7d780fb6bb2699f3feac572010664c155cc` | 274,201 | 0.006855 | 22 | pass |
| claim1:holders | claim RHOLD dividends | `0x0894e48579eb353c3ef8131dc3bca1d1080a9429cc49bcfd2442e16a0b1e8538` | 110,806 | 0.002770 | 13 | pass |
| claim1:combo | claim RCOMBO dividends | `0x8fdfc5e3f0c3f0660216307358661b31fc7b6f940efec533d5ad86d7b6bb674c` | 93,706 | 0.002343 | 13 | pass |
| collectFees | collectFees | `0x15193f139d4354c552cdbb5e43963a1baac7eeb755a5171acbb554f3e8d9b576` | 55,972 | 0.001399 | 6 | pass |

`sample1` ran 12 checks and `final` ran 22. `run1b:combo` sent nothing: the first run had spent all 0.042265 USDC
waiting, so `previewRun` was 0 and a simulated run reverted `NothingToBuy` (2 checks).

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

- **rUSDC run:** about 0.6 USDC of gas. The driver mints the ~160,000 rUSDC that five sell-outs take.
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

This is the current driver, used for the second run. How the first run differed is described under **First run**.

Every step checks the launchpad identity (V13-SPEC §6.1) to the unit, at the receipt's block:

`USDC held == pendingFees + Σ pendingCreatorFees + Σ (virtualUsdc − VIRTUAL_USDC_0) over curves not yet graduated`

It also checks the burner's own side, to the wei, on its native balance with the gas added back. On Arc, USDC is the
gas token; on rUSDC, the native balance must move by exactly the gas and nothing else. Every transaction is simulated
first, so a revert costs nothing. After every trade, the token's tracked eligible supply must equal
`totalSupply − launchpad − pair − 0x…dEaD`, and the burner must be its only eligible holder.

**The identity, verified against the code.** Every path that moves USDC moves both sides of the identity by the same
amount:

- the launch fee;
- curve buys and sells;
- graduation, which removes the curve's float from the sum and sends exactly that much USDC to the pair;
- `collectFees` and `collectCreatorFees`;
- the router's transfer-then-`accrueTradeFees`.

The sum of creator fees covers every token, graduated or not, because pool trades keep accruing them. The identity
holds with `==` unless someone sends the launchpad USDC unasked, in which case it becomes `≥` (V13-SPEC §9).

**The dividend stream is checked against a model of `LaunchToken` fed with the token's own storage.** The model reads
the per-share value, the magnified rate, the packed stream and the holder's correction, from the slots
`forge inspect LaunchToken storageLayout` reports. At every block the driver reads, `claimable`, `undistributed`,
`streamRate`, `streamEnd` and `lastAccrual` must equal the model. Every `distribute` and `claim` must move the stored
stream exactly as the model says.

| Step | What it proves |
| --- | --- |
| `wiring` | Every address points where it should; the constants match the spec, including Buyback's `RUN_INTERVAL` 3600 and `MIN_RUN_USDC` 3. Each plugin declares `IArchitexFeePlugin` (`0x87732014`) and ERC-165, and rejects `0xffffffff`. |
| `create:*` | `createToken` with `maxLaunchFee = launchFee` [D22]. `curves()` records the plugin, the creator fee and `pluginHooks` (false for the wallet, true for the plugins). `isLaunchPair` is true for the new pair and false for the token. `onLaunch` ran before the first buy, once: a second call reverts `AlreadyConfigured`. Split stores its payees; Combo stores its allocation and configures both sub-plugins. The creator's first buy pays the creator fee [D3]. Also, for free: `createToken` refuses (`InvalidPlugin`) zero, the launchpad, USDC, the router, the pair factory, an existing launch token, an existing launch pair, and the **new token's own address and its own pair's address, predicted from the CREATE nonces**. It refuses `pluginData` for a plain address (`DataForNonPlugin`) and accepts `0x…dEaD`. A Split paying a launch pair and a Combo paying a launch token revert `InvalidRecipient`. |
| `buy:*`, `sell:*` | Result == `quoteBuy`/`quoteSell` == an independent model of V13-SPEC §5. Both fees come from the USDC side, rounded up. `Trade` events and the curve state are exact. Selling straight back what was just bought returns less than was paid (§6.4). Also, for free: a buy or sell past its deadline reverts `Expired`; a transfer into the pair before graduation, the router before graduation, a direct `swap` and a stranger's `accrueTradeFees` all revert. |
| `collect1:*` | `collectCreatorFees` pays exactly the accrued amount (§2.1). Wallet: a plain transfer. Split and Buyback: `usdcHeld` rises by exactly that. Holders: the plugin forwards all of it to the token's `distribute` and keeps nothing (`usdcHeld` 0, balance 0). The token starts a stream ending exactly `now + 86,400`, with rate `amount·2^128/86,400` rounded down. Combo: 40/40/20, the last entry taking the remainder, each slice through the sub-plugin's hook or by transfer. |
| `release*:split:*` | Each payee's `releasable` is `totalReceived·share/10 − released`, and the payee receives exactly that. 2 units of rounding dust stay in the plugin. |
| `run1:*` | A token's first buyback run offers `min(usdcHeld, full cap)`, the cap being 0.25% of the USDC-side reserve: 22.08 rUSDC of 49.88 waiting. `previewRun` at the block before equals the model at that block's time. Supply falls by exactly the tokens bought. `lastRunAt` = the run's time; a second run in the same block reverts `AlreadyRanThisBlock`. |
| `run1b:*` | **Pacing** (V13-SPEC §2.2 [review]). A second run a few seconds later offers `min(usdcHeld, cap × elapsed / 3600)`: 6 s after the first, 0.036890 rUSDC of a 22.13 cap. On Arc's USDC nothing was left over MIN_RUN_USDC, so `previewRun` is 0 and a run reverts `NothingToBuy` (simulated, free). |
| `run2:*` | The same pacing in the pool, through the launch router: 221 s after the last run, 3.873476 of a 63.10 rUSDC cap. |
| `sample*` | Two readings 30 s apart. `claimable` grows by ≈ `streamRate × dt × share`: for example 59,989 units against 1,874 /s × 32 s = 59,968, where `streamRate` is rounded down. `undistributed` falls. Both readings equal the model. |
| `claim*:*` | The burner calls `claim()` on the token. It is paid exactly what `claimable` was at the claim's block: the block before's stored stream, accrued to the claim's time. The stream accrues first. Because the burner is the only eligible holder, it has earned everything the stream paid out: **claimed + claimable + undistributed == totalDistributed, within 1 unit of dust** every time. Also Σ claimed + Σ claimable ≤ Σ distributed (§6.6). |
| `collect2:holders`, `collect2:combo` | New fees join a running stream: accrue, add to what is owed, move the end to the amount-weighted average rounded down (86,200 s → 86,389 s from now), with the rate rounded down. All exact against the model. |
| `graduate:*` | The sell-out buy follows the §5 exact-fill formulas and pulls only what the last tokens cost. `Graduated` reports 200M tokens and exactly `virtualUsdc − VIRTUAL_USDC_0` USDC. `getReserves()` equals the seeded amounts. Every LP token, `MINIMUM_LIQUIDITY` included, sits at `0x…dEaD`. The identity holds with the float gone. The curve refuses to quote or sell afterwards. |
| `poolbuy:*`, `poolsell:*` | Router result == quote == a constant-product model with both fees from the USDC side (§4). The fees are recorded per token (`PoolFeesAccrued`). The reserves move exactly. |
| `collectFees` | `feeTo` receives exactly `pendingFees`: 715.774190 rUSDC. |
| `final` | Each plugin's balance equals Σ `usdcHeld` over the tokens it serves; the holders plugin and the Combo hold 0. Every token burned was burned by the buyback. Pool reserves equal pool balances. For RHOLD and RCOMBO: the views match the model, the burner has earned everything that streamed, and the token holds exactly distributed − claimed. |

## Notes from the real chain

**Gas per step, second run** (on rUSDC unless stated).

| Step | Gas |
| --- | --- |
| `createToken` | 3.20M–3.42M (about 0.08 USDC), 0.41M more than the first run: the streaming LaunchToken is bigger |
| Curve buy / sell | 98k / 96k, on Arc's USDC 115k / 108k (92k / 89k and 108k / 102k in the first run); eligible-supply tracking adds ~6k |
| Sell-out buy, pair seeding included | 240k–286k |
| Launch-router buy / sell | 129k–144k |
| `collectCreatorFees` | 47k–64k to a wallet, 80k–108k to Split or Buyback, 147k–197k to Holders (the stream starts inside the token), 265k–342k to Combo |
| Buyback `run` | a first run 232k–274k; a paced run 156k–179k on the curve, 199k–222k in the pool |
| `claim` | 81k–111k for a holder's first claim, 64k after |
| Deploying the suite | 11.6M (0.38 USDC); the launchpad alone is 4.77M, 0.58M more than before |

Every call that moves Arc's USDC costs 9k–16k more gas than it does on an OpenZeppelin ERC-20.

**Gas price.** The driver paid 25 gwei: a base fee of 20 plus the node's suggested 5 gwei tip, so 1M gas is about
0.025 USDC. Forge's own fee estimate paid 32.5 gwei for the deploys, 30% more.

**RPC**

- Blocks come about every 0.5 s. Receipts arrived within 1–3 s.
- Bursts are refused with `Request exceeds defined limit`; of 100 parallel `eth_call`s, about 30 succeed.
- A read at a block the serving node has not reached yet returns `Requested resource not found`.
- Both errors clear on retry with backoff: 29 retries across the second run's drives.
- Historical state and storage are served at any recent block. This is what makes the block-exact checks, the
  storage-fed stream model and the re-checks on resume work.
- `eth_call` at block B runs with `block.number == B`; the same-block buyback check depends on this.
- Contract nonces follow EIP-161, so a new token's and its pair's CREATE addresses can be predicted, as the
  destination checks do.

**Two lessons for checks on Arc**, both from the script's first attempt at the second run, not from the contracts:

- Two blocks share a second, so "the block before" can have the same timestamp as the transaction. Nothing streams
  between them.
- A small stream (0.042265 USDC over 24 hours, 0.49 units per second) does not fall a whole unit every second.

The driver now compares every reading with the model. Between two readings it only asks that `undistributed` never
rise.

**What is left on chain after the second run**

- rUSDC deployment:
  - Five graduated pools, each holding about 25,230 rUSDC.
  - RHOLD and RCOMBO dividends still streaming to the burner until 2026-09-22 23:10 UTC: 2,972.78 and 685.70 rUSDC.
  - 1,468.82 rUSDC in Buyback & burn. It pays out at most 0.25% of each pool per hour.
- Arc-USDC deployment:
  - The burner holds RHOLD and RCOMBO worth their curve floats (0.537 + 0.600 USDC).
  - 0.216 USDC of dividends is still streaming.
  - 0.021 USDC went to the Combo's fixed wallet, which nobody holds a key for.
- The burner ended at 5.156 USDC.

## First run: contracts at `c508af3`

The first run drove the same flow on the contracts as they were before the security review. It covered 5 tokens,
5 graduations, and every plugin, and all 1,173 checks passed. Three things differed:

- **Distribute to holders was a plugin-side drip.** Collections were held in the plugin (`unreleased`) and released
  linearly over 24 hours by `drip`, and the burner claimed with the plugin's `dripAndClaim`. The steps were
  `drip*:*` instead of `claim*:*`, and the plugin's balance was Σ `unreleased`.
- **Buyback & burn had a per-block cap and no time pacing.** Every run offered min(held, full cap): 22.08 rUSDC on the
  curve and 63.10 in the pool.
- **Curve trades had no deadline**, and `createToken` refused only zero and the launchpad as destinations.

### Addresses

**On rUSDC** (`deployments/arc-testnet-v13-rehearsal.json` at `5e11fc6`).

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

**On Arc's USDC** (`deployments/arc-testnet-v13-realusdc.json` at `5e11fc6`).

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

### Results

#### rUSDC: deploy and drive

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

#### Arc's USDC: deploy and drive

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
