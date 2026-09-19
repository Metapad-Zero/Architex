/**
 * Architex pool seeding script.
 * Mints test tokens to the deployer and adds liquidity to 5 pools via the router.
 *
 * NOTE: For USDC/token pools (USDC/WETH, USDC/WBTC, USDC/ARC, USDC/EURC) only ~2 USDC
 * per pool is spent (the deployer wallet has a limited testnet USDC balance).
 * The WETH/WBTC pool uses only minted test tokens.
 *
 * Fee-on-transfer tokens are NOT supported by ArchitexPair/Router (see NatSpec).
 */

import {
  initiateDeveloperControlledWalletsClient,
  type CircleDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets';
import {
  initiateSmartContractPlatformClient,
  type CircleSmartContractPlatformClient,
} from '@circle-fin/smart-contract-platform';
import fs from 'fs';

// ─── Addresses ───────────────────────────────────────────────────────────────

const DEPLOYER_WALLET_ID = '3c2464b2-8369-52e2-a782-800bbeca5396';
const DEPLOYER = '0x5B12Ce46C7194aD57d143bC22847224047b1Ef42';

const FACTORY  = '0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a';
const ROUTER   = '0xcb417bbb2c3ce02296229ca89b639bb3af2538e2';
const USDC     = '0x3600000000000000000000000000000000000000';

const WETH     = '0xf2bb050eb30a9cd4bd5df986c626765ae57d21e4';
const WBTC     = '0x34136a662681df7aacbf2aad5c35258db8f1a113';
const ARC_TK   = '0x004925d26559de8823106e3cbf47ed870788d0d5';
const EURC     = '0x07748023f41001efd73d7907d74f8222a76b2dc2';

const CHAIN = 'ARC-TESTNET';
const EXPLORER = 'https://explorer.testnet.arc.io';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim().length > 0) return v.trim();
  }
  throw new Error(`Missing env var, expected one of: ${names.join(', ')}`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

type ABI = readonly Record<string, unknown>[];

const POLL_INTERVAL = 3_000;
const MAX_POLLS = 90;

async function waitForTx(scpClient: CircleSmartContractPlatformClient, transactionId: string, label: string): Promise<string> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_INTERVAL);
    const res = await scpClient.getContractExecutionTransaction({ transactionId });
    const state = res.data?.transaction?.state;
    const txHash = res.data?.transaction?.txHash ?? '(pending)';
    if (state === 'COMPLETE') {
      console.log(`  ✓ ${label} confirmed: ${txHash}`);
      return txHash;
    }
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`${label} ${state}: txId=${transactionId}`);
    }
    process.stdout.write('.');
  }
  throw new Error(`${label} timed out after ${MAX_POLLS * POLL_INTERVAL / 1000}s`);
}

async function execContract(
  scpClient: CircleSmartContractPlatformClient,
  label: string,
  contractAddress: string,
  abi: ABI,
  functionSignature: string,
  args: unknown[],
): Promise<string> {
  console.log(`\n→ ${label}`);
  const idem = `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await scpClient.createContractExecutionTransaction({
    walletId: DEPLOYER_WALLET_ID,
    contractAddress,
    abiFunctionSignature: functionSignature,
    abiParameters: args.map(String),
    idempotencyKey: idem,
    blockchain: CHAIN,
    // @ts-expect-error fee config
    feeLevel: 'MEDIUM',
  });
  const transactionId = res.data?.id;
  if (!transactionId) throw new Error(`No transactionId returned for ${label}`);
  return waitForTx(scpClient, transactionId, label);
}

// ─── ABIs (only the functions we call) ───────────────────────────────────────

const ERC20_ABI: ABI = [
  { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const TEST_TOKEN_ABI: ABI = [
  ...ERC20_ABI,
  { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
];

const ROUTER_ABI: ABI = [
  {
    name: 'addLiquidity',
    type: 'function',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'amountADesired', type: 'uint256' },
      { name: 'amountBDesired', type: 'uint256' },
      { name: 'amountAMin', type: 'uint256' },
      { name: 'amountBMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
  },
];

const FACTORY_ABI: ABI = [
  { name: 'getPair', type: 'function', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }], outputs: [{ type: 'address' }] },
];

// ─── Query helper (read-only) ─────────────────────────────────────────────────

async function queryContract(
  scpClient: CircleSmartContractPlatformClient,
  label: string,
  contractAddress: string,
  functionSignature: string,
  args: unknown[],
): Promise<unknown[]> {
  const res = await scpClient.queryContract({
    contractAddress,
    abiFunctionSignature: functionSignature,
    abiParameters: args.map(String),
    blockchain: CHAIN,
  });
  const out = res.data?.outputValues;
  if (!out) throw new Error(`queryContract ${label} returned no output`);
  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = requireEnv(['CIRCLE_DEVELOPER_CONTROLLED_API_KEY', 'CIRCLE_API_KEY', 'CIRCLE_SCP_API_KEY']);
  const entitySecret = requireEnv(['CIRCLE_ENTITY_SECRET', 'ENTITY_SECRET', 'CIRCLE_SCP_ENTITY_SECRET']);

  const walletsClient = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const scpClient = initiateSmartContractPlatformClient({ apiKey, entitySecret });

  console.log('Architex pool seeding');
  console.log('Deployer:', DEPLOYER);

  const deadline = String(Math.floor(Date.now() / 1000) + 3600);
  const MAX_UINT = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

  // ─── 1. Mint test tokens to deployer ────────────────────────────────────────

  // WETH: 2 WETH (18 dec) for USDC pool, 24 WETH for WETH/WBTC pool → 26 WETH
  const WETH_AMOUNT_USDC  = '800000000000000000';   // 0.0008 WETH → ~2 USDC at 2500/WETH
  const WETH_AMOUNT_WBTC  = '24000000000000000000'; // 24 WETH
  const WETH_MINT = '24000800000000000000';          // 24.0008 WETH

  // WBTC: 1 WBTC (8 dec) for WETH/WBTC pool only (no USDC/WBTC — too many USDC needed)
  // For USDC/WBTC: ~2 USDC / 60000 = 0.0000333 WBTC = 3334 satoshi
  const WBTC_AMOUNT_USDC = '3334';               // 0.00003334 WBTC at 60000/WBTC
  const WBTC_AMOUNT_WBTC = '100000000';          // 1 WBTC
  const WBTC_MINT = '100003334';

  // ARC token: 2 USDC / 0.05 = 40 ARC for USDC/ARC
  const ARC_AMOUNT = '40000000000000000000'; // 40 ARC (18 dec)

  // EURC: 2 USDC / 1.08 ≈ 1.851 EURC → 1851851 (6 dec)
  const EURC_AMOUNT_USDC = '1851851'; // 1.851851 EURC (6 dec)
  const EURC_MINT = '2000000';        // 2 EURC

  // USDC amounts (6 dec): ~2 per USDC pool → 4 pools = ~8 USDC total
  const USDC_WETH  = '2000000';  // 2 USDC
  const USDC_WBTC  = '2000000';  // 2 USDC
  const USDC_ARC   = '2000000';  // 2 USDC
  const USDC_EURC  = '2000000';  // 2 USDC

  console.log('\n── Step 1: Mint test tokens ──');

  await execContract(scpClient, 'Mint WETH to deployer', WETH, TEST_TOKEN_ABI,
    'mint(address,uint256)', [DEPLOYER, WETH_MINT]);
  await execContract(scpClient, 'Mint WBTC to deployer', WBTC, TEST_TOKEN_ABI,
    'mint(address,uint256)', [DEPLOYER, WBTC_MINT]);
  await execContract(scpClient, 'Mint ARC token to deployer', ARC_TK, TEST_TOKEN_ABI,
    'mint(address,uint256)', [DEPLOYER, ARC_AMOUNT]);
  await execContract(scpClient, 'Mint EURC to deployer', EURC, TEST_TOKEN_ABI,
    'mint(address,uint256)', [DEPLOYER, EURC_MINT]);

  // ─── 2. Approve router for all tokens ────────────────────────────────────────

  console.log('\n── Step 2: Approve router ──');

  await execContract(scpClient, 'Approve USDC → router', USDC, ERC20_ABI,
    'approve(address,uint256)', [ROUTER, MAX_UINT]);
  await execContract(scpClient, 'Approve WETH → router', WETH, TEST_TOKEN_ABI,
    'approve(address,uint256)', [ROUTER, MAX_UINT]);
  await execContract(scpClient, 'Approve WBTC → router', WBTC, TEST_TOKEN_ABI,
    'approve(address,uint256)', [ROUTER, MAX_UINT]);
  await execContract(scpClient, 'Approve ARC → router', ARC_TK, TEST_TOKEN_ABI,
    'approve(address,uint256)', [ROUTER, MAX_UINT]);
  await execContract(scpClient, 'Approve EURC → router', EURC, TEST_TOKEN_ABI,
    'approve(address,uint256)', [ROUTER, MAX_UINT]);

  // ─── 3. Add liquidity to 5 pools ─────────────────────────────────────────────

  console.log('\n── Step 3: Add liquidity ──');

  const poolTxHashes: Record<string, string> = {};
  const poolAddresses: Record<string, string> = {};

  // Pool 1: USDC/WETH at 2500 USDC/WETH → 2 USDC / 0.0008 WETH
  poolTxHashes['USDC/WETH'] = await execContract(scpClient, 'Add USDC/WETH liquidity', ROUTER, ROUTER_ABI,
    'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
    [USDC, WETH, USDC_WETH, WETH_AMOUNT_USDC, '0', '0', DEPLOYER, deadline]);

  // Pool 2: USDC/WBTC at 60000 USDC/WBTC → 2 USDC / 0.00003334 WBTC
  poolTxHashes['USDC/WBTC'] = await execContract(scpClient, 'Add USDC/WBTC liquidity', ROUTER, ROUTER_ABI,
    'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
    [USDC, WBTC, USDC_WBTC, WBTC_AMOUNT_USDC, '0', '0', DEPLOYER, deadline]);

  // Pool 3: USDC/ARC at 0.05 USDC/ARC → 2 USDC / 40 ARC
  poolTxHashes['USDC/ARC'] = await execContract(scpClient, 'Add USDC/ARC liquidity', ROUTER, ROUTER_ABI,
    'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
    [USDC, ARC_TK, USDC_ARC, ARC_AMOUNT, '0', '0', DEPLOYER, deadline]);

  // Pool 4: USDC/EURC at 1.08 USDC/EURC → 2 USDC / 1.851851 EURC
  poolTxHashes['USDC/EURC'] = await execContract(scpClient, 'Add USDC/EURC liquidity', ROUTER, ROUTER_ABI,
    'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
    [USDC, EURC, USDC_EURC, EURC_AMOUNT_USDC, '0', '0', DEPLOYER, deadline]);

  // Pool 5: WETH/WBTC at 24:1 (test tokens only, larger size)
  poolTxHashes['WETH/WBTC'] = await execContract(scpClient, 'Add WETH/WBTC liquidity', ROUTER, ROUTER_ABI,
    'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
    [WETH, WBTC, WETH_AMOUNT_WBTC, WBTC_AMOUNT_WBTC, '0', '0', DEPLOYER, deadline]);

  // ─── 4. Read pair addresses from factory ─────────────────────────────────────

  console.log('\n── Step 4: Reading pair addresses ──');

  const pairKeys: Array<[string, string, string]> = [
    ['USDC/WETH', USDC, WETH],
    ['USDC/WBTC', USDC, WBTC],
    ['USDC/ARC',  USDC, ARC_TK],
    ['USDC/EURC', USDC, EURC],
    ['WETH/WBTC', WETH, WBTC],
  ];

  for (const [name, tA, tB] of pairKeys) {
    try {
      const out = await queryContract(scpClient, `getPair ${name}`, FACTORY,
        'getPair(address,address)', [tA, tB]);
      const addr = out[0] as string;
      poolAddresses[name] = addr;
      console.log(`  ${name}: ${addr}`);
    } catch (e) {
      console.warn(`  WARNING: Could not read pair address for ${name}:`, e);
      poolAddresses[name] = '0x0000000000000000000000000000000000000000';
    }
  }

  // ─── 5. Write deployments/arc-testnet.json ────────────────────────────────────

  console.log('\n── Step 5: Writing deployment manifest ──');

  const pairsJson = pairKeys.map(([name, tA, tB]) => {
    const tokens = [tA, tB].sort() as [string, string];
    return {
      name,
      pair: poolAddresses[name] ?? '0x0000000000000000000000000000000000000000',
      token0: tokens[0],
      token1: tokens[1],
    };
  });

  const manifest = {
    chainId: 5042002,
    network: 'Arc Testnet',
    explorerBase: 'https://explorer.testnet.arc.io',
    factory: FACTORY,
    router: ROUTER,
    lens: '0x8ee79a8a702e7f8dd433b940d11b327e5153094b',
    deployer: DEPLOYER,
    tokens: [
      { symbol: 'USDC', name: 'USD Coin', address: USDC, decimals: 6, faucet: false },
      { symbol: 'WETH', name: 'Wrapped Ether (test)', address: WETH, decimals: 18, faucet: true },
      { symbol: 'WBTC', name: 'Wrapped Bitcoin (test)', address: WBTC, decimals: 8, faucet: true },
      { symbol: 'ARC', name: 'Arc Token (test)', address: ARC_TK, decimals: 18, faucet: true },
      { symbol: 'EURC', name: 'Euro Coin (test)', address: EURC, decimals: 6, faucet: true },
    ],
    pairs: pairsJson,
    txs: {
      factory: '0x8a53b5793ea7113b250fd07b487c7d38a2a33132ea2f3634e4bc8cf5183f264e',
      router: '0xc07dd09841e2e3bb048eadb5f12ccc0c7c3f084e4df1001accbefc7e5b91eedc',
      lens: '0x7f629d86c0eefcdf4739e3e8f822b47b99997eb6141ecd10eea5cc6b66101f57',
      seedPools: poolTxHashes,
    },
  };

  fs.mkdirSync('/home/user/app/deployments', { recursive: true });
  fs.writeFileSync('/home/user/app/deployments/arc-testnet.json',
    JSON.stringify(manifest, null, 2) + '\n');
  console.log('Written: deployments/arc-testnet.json');

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('Architex seeding complete!');
  console.log('Factory:', FACTORY);
  console.log('Router: ', ROUTER);
  console.log('Lens:   ', '0x8ee79a8a702e7f8dd433b940d11b327e5153094b');
  console.log('Pairs:');
  for (const [n, a] of Object.entries(poolAddresses)) {
    console.log(`  ${n}: ${a}`);
  }
}

main().catch(e => {
  console.error('Seed failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
