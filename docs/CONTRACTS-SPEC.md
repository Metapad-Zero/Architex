# Architex — contract spec (v1)

Architex is a constant-product AMM (Uniswap V2 semantics) for Arc. Everything is an ERC-20:
on Arc the gas token is USDC (18-dec native) and USDC is also an ERC-20 at
`0x3600000000000000000000000000000000000000` (6 decimals). There is no wrapped-native token and no
ETH-style router functions.

The interfaces under `contracts/interfaces/` are **binding**. Implement them exactly — same names,
same signatures, same events, same custom errors — because the frontend ABIs are generated from them.

## Contracts

| Contract | Implements | Notes |
|---|---|---|
| `ArchitexFactory` | `IArchitexFactory` | `constructor(address feeToSetter)`. CREATE2 pair creation, salt = `keccak256(abi.encodePacked(token0, token1))`. `getPair` symmetric. `feeTo` starts as `address(0)` (protocol fee off). |
| `ArchitexPair` | `IArchitexPair` | LP token `name = "Architex LP"`, `symbol = "ATX-LP"`, `decimals = 18`. Use OpenZeppelin 5.1 `ERC20` + `ERC20Permit` for the token half (permit name "Architex LP"). Reentrancy lock on mint/burn/swap/skim/sync (custom `Locked()` error). `MINIMUM_LIQUIDITY = 1000` burned to `address(0xdead)`-style dead address on first mint. Fee 0.30%: `balance0Adjusted = balance0*1000 - amount0In*3` and the K check `balance0Adjusted*balance1Adjusted >= reserve0*reserve1*1e6`. Protocol fee: when `feeTo != 0`, mint `feeTo` LP equal to 1/6 of the sqrt(k) growth since `kLast` (exact Uniswap V2 `_mintFee`). UQ112x112 cumulative prices updated in `_update` with the standard overflow-desired arithmetic (use `unchecked`). Flash-swap callback: if `data.length > 0` call `IArchitexCallee(to).architexCall(msg.sender, amount0Out, amount1Out, data)` — define that interface in `contracts/interfaces/IArchitexCallee.sol`. |
| `ArchitexRouter` | `IArchitexRouter` | `constructor(address factory)`. Standard V2 router logic minus ETH paths. Token transfers via OpenZeppelin `SafeERC20`. `addLiquidity` creates the pair when missing (`factory.createPair`). All amounts computed with the same integer formulas as the pure functions. Path length ≥ 2 else `InvalidPath()`. Missing pair → `PairDoesNotExist()`. `removeLiquidityWithPermit` calls `IArchitexPair(pair).permit(msg.sender, address(this), approveMax ? type(uint256).max : liquidity, deadline, v, r, s)` then `removeLiquidity`. |
| `ArchitexLens` | `IArchitexLens` | `constructor(address factory, address router)`. Pure view aggregation; `tokenMeta` wraps `symbol()/name()/decimals()` in try/catch (fallback: "", "", 18). `positions` iterates pairs `[start, start+count)` (clamp to length) and returns only those with `balanceOf(owner) > 0`. Never reverts on unknown tokens. |
| `TestToken` | `ITestToken` | `constructor(string name, string symbol, uint8 decimals, uint256 faucetUnits, address owner)`. OpenZeppelin `ERC20` + `Ownable`. `faucet()` mints `FAUCET_UNITS * 10**decimals` to `msg.sender`, emits `Faucet`. Testnet only — the deploy script must refuse to deploy it to chain id 5042. |

Solidity `^0.8.28`, optimizer on, custom errors everywhere (no revert strings), NatSpec on every external function.
Do not import Uniswap packages — write the code (it is short) so the audit covers what ships.

## Math (frontend mirrors these exactly with bigint)

```
quote(amountA, rA, rB)          = amountA * rB / rA
getAmountOut(aIn, rIn, rOut)    = (aIn*997 * rOut) / (rIn*1000 + aIn*997)
getAmountIn(aOut, rIn, rOut)    = (rIn * aOut * 1000) / ((rOut - aOut) * 997) + 1
mint (first)   liquidity = sqrt(amount0*amount1) - MINIMUM_LIQUIDITY
mint (later)   liquidity = min(amount0*totalSupply/reserve0, amount1*totalSupply/reserve1)
burn           amountX   = liquidity * balanceX / totalSupply
```

## Tests (Foundry, `contracts/test/*.t.sol`) — max preset

- Factory: create, duplicate reverts `PairExists`, identical reverts, zero reverts, ordering, `feeTo` admin auth (`Forbidden`).
- Pair: first mint burns MINIMUM_LIQUIDITY; proportional mint; burn returns pro-rata; swap exact math matches `getAmountOut`; K invariant fuzz (swap never lowers k); reentrancy lock; skim/sync; cumulative price advances; protocol fee minted to feeTo equals 1/6 of growth; permit round-trip (EIP-712 signature) then `transferFrom`.
- Router: addLiquidity creates pair + respects mins (`InsufficientAAmount/BAmount`); removeLiquidity; removeLiquidityWithPermit; exact-in and exact-out single hop and 2-hop; `Expired`; `InsufficientOutputAmount`; `ExcessiveInputAmount`; `InvalidPath`; works with a 6-decimal token (USDC-like) paired with 18-decimal.
- Lens: `pairs` paging clamps, `tokenMeta` survives a non-ERC20 address, `positions` filters zero balances, `balances/allowances` lengths.
- Invariant test: random mint/burn/swap sequence keeps `reserve0*reserve1` non-decreasing between liquidity events and LP supply consistent.

## Deployment (Arc Testnet, chain id 5042002) — do it in this turn

1. Deploy `ArchitexFactory(feeToSetter = deployer)`, `ArchitexRouter(factory)`, `ArchitexLens(factory, router)`.
2. Deploy test tokens (owner = deployer): `WETH` "Wrapped Ether (test)" 18 dec faucet 10; `WBTC` "Wrapped Bitcoin (test)" 8 dec faucet 1; `ARC` "Arc Token (test)" 18 dec faucet 10000; `EURC` "Euro Coin (test)" 6 dec faucet 1000.
3. Seed pools from the deployer wallet (mint test tokens to deployer as needed; spend only a small amount of real testnet USDC, ~2 USDC per USDC pool, keep the rest for gas):
   - USDC/WETH at ~2500 USDC per WETH, USDC/WBTC at ~60000 USDC per WBTC, USDC/ARC at ~0.05 USDC per ARC, USDC/EURC at ~1.08 USDC per EURC, WETH/WBTC at 24 WETH per WBTC (test tokens only, larger size e.g. 24 WETH / 1 WBTC).
4. Write `deployments/arc-testnet.json`:

```json
{
  "chainId": 5042002,
  "network": "Arc Testnet",
  "explorerBase": "https://explorer.testnet.arc.io",
  "factory": "0x…", "router": "0x…", "lens": "0x…",
  "deployer": "0x…",
  "tokens": [
    { "symbol": "USDC", "name": "USD Coin", "address": "0x3600000000000000000000000000000000000000", "decimals": 6, "faucet": false },
    { "symbol": "WETH", "name": "Wrapped Ether (test)", "address": "0x…", "decimals": 18, "faucet": true }
  ],
  "pairs": [ { "pair": "0x…", "token0": "0x…", "token1": "0x…" } ],
  "txs": { "factory": "0x…", "router": "0x…", "lens": "0x…" }
}
```

5. Also export the ABIs: `deployments/abi/{ArchitexFactory,ArchitexPair,ArchitexRouter,ArchitexLens,TestToken}.json` (ABI array only).

Report every address, tx hash and explorer link. If seeding fails for lack of USDC, deploy everything, seed the pools that need no USDC, and say exactly what is left.
