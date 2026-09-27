`PoolManager.arc.hex` is the runtime code of Uniswap v4's PoolManager as deployed on Arc mainnet and Arc Testnet at
`0x8366a39CC670B4001A1121B8F6A443A643e40951` (identical on both, read with `cast code` on 2026-09-25). The v1.4 tests
etch it at that same address, so they run against the exact code the pools will use. It is Uniswap's code under its
own licence (BUSL-1.1 for PoolManager); Architex only uses it here as a test fixture and never deploys it.
