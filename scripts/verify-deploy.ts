import { createPublicClient, http, parseAbi, getAddress } from 'viem'
import { arcTestnet } from 'viem/chains'
const client = createPublicClient({ chain: arcTestnet, transport: http('https://rpc.testnet.arc.io') })
const factory = getAddress('0x6362f5a0fc007ab7d1e61f99d3f4eb04360d060a')
const router = getAddress('0xcb417bbb2c3ce02296229ca89b639bb3af2538e2')
const lens = getAddress('0x8ee79a8a702e7f8dd433b940d11b327e5153094b')
const tokens = ['0x07748023f41001efd73d7907d74f8222a76b2dc2','0x004925d26559de8823106e3cbf47ed870788d0d5','0x34136a662681df7aacbf2aad5c35258db8f1a113','0xf2bb050eb30a9cd4bd5df986c626765ae57d21e4'].map((a) => getAddress(a))
const lensAbi = parseAbi([
  'struct PairInfo { address pair; address token0; address token1; uint112 reserve0; uint112 reserve1; uint32 blockTimestampLast; uint256 totalSupply; }',
  'struct TokenMeta { address token; string symbol; string name; uint8 decimals; }',
  'function pairs(uint256 start, uint256 count) view returns (PairInfo[])',
  'function tokenMeta(address[] tokens) view returns (TokenMeta[])',
  'function factory() view returns (address)','function router() view returns (address)',
  'function balances(address owner, address[] tokens) view returns (uint256[])',
])
const facAbi = parseAbi(['function feeToSetter() view returns (address)','function feeTo() view returns (address)','function allPairsLength() view returns (uint256)'])
const routerAbi = parseAbi(['function factory() view returns (address)'])
const usdc = getAddress('0x3600000000000000000000000000000000000000')
const [lf, lr, rf, fts, fto, n] = await Promise.all([
  client.readContract({address: lens, abi: lensAbi, functionName: 'factory'}),
  client.readContract({address: lens, abi: lensAbi, functionName: 'router'}),
  client.readContract({address: router, abi: routerAbi, functionName: 'factory'}),
  client.readContract({address: factory, abi: facAbi, functionName: 'feeToSetter'}),
  client.readContract({address: factory, abi: facAbi, functionName: 'feeTo'}),
  client.readContract({address: factory, abi: facAbi, functionName: 'allPairsLength'}),
])
console.log(JSON.stringify({ lensFactory: lf, lensRouter: lr, routerFactory: rf, feeToSetter: fts, feeTo: fto, pairsLength: n.toString() }))
const meta = await client.readContract({address: lens, abi: lensAbi, functionName: 'tokenMeta', args: [[usdc, ...tokens]]})
for (const m of meta) console.log('TOKEN', m.token, m.symbol, m.name, m.decimals)
const pairs = await client.readContract({address: lens, abi: lensAbi, functionName: 'pairs', args: [0n, 20n]})
for (const p of pairs) console.log('PAIR', p.pair, p.token0, p.token1, 'r0', p.reserve0.toString(), 'r1', p.reserve1.toString(), 'ts', p.totalSupply.toString())
const burner = getAddress('0x7212fA4Fe663d063A7a83dA0467d592ed3A51D46')
const bal = await client.readContract({address: lens, abi: lensAbi, functionName: 'balances', args: [burner, [usdc, ...tokens]]})
console.log('BURNER balances', bal.map(String).join(','), 'native', (await client.getBalance({address: burner})).toString())
