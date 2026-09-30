import { concat, encodeAbiParameters, encodeDeployData, getContractAddress, keccak256, parseAbi, type Address, type Hex } from 'viem'
import bundle from './bytecode.json'

type Entry = { bytecode: string; links: { name: string; starts: number[] }[]; sha256: string }

/** Creation code with every library placeholder replaced by the deployed library address. */
export function linked(entry: Entry, libraries: Record<string, Address> = {}): Hex {
  let code = entry.bytecode.replace(/^0x/, '')
  for (const { name, starts } of entry.links) {
    const address = libraries[name]
    if (!address) throw new Error(`${name} must be deployed and linked first`)
    for (const start of starts) code = code.slice(0, start * 2) + address.slice(2).toLowerCase() + code.slice(start * 2 + 40)
  }
  if (code.includes('__$')) throw new Error('Unlinked library placeholder remains')
  return `0x${code}`
}

export const CODE = {
  NttManager: bundle.ntt.NttManager as Entry,
  WormholeTransceiver: bundle.ntt.WormholeTransceiver as Entry,
  TransceiverStructs: bundle.ntt.TransceiverStructs as Entry,
  ERC1967Proxy: bundle.ntt.ERC1967Proxy as Entry,
  EquilibriumExecutor: bundle.equilibrium.EquilibriumExecutor as Entry,
  EquilibriumCanonical: bundle.equilibrium.EquilibriumCanonical as Entry,
  EquilibriumSpoke: bundle.equilibrium.EquilibriumSpoke as Entry,
  ForkUsdc: bundle.equilibrium.ForkUsdc as Entry,
}
export const NTT_COMMIT = bundle.ntt.commit

export const executorAbi = parseAbi([
  'struct Call { address target; uint256 value; bytes data; }',
  'function execute(bytes32 operation, bytes32 digest, Call[] calls) payable',
  'function digestOf(bytes32 operation) view returns (bytes32)',
  'function owner() view returns (address)',
  'function v3Factory() view returns (address)',
  'event Executed(bytes32 indexed operation, bytes32 indexed digest)',
  'event Created(bytes32 indexed operation, uint256 indexed index, address created)',
  'error NotOwner()',
  'error OperationDone(bytes32 operation, bytes32 digest)',
  'error CallFailed(uint256 index, bytes reason)',
  'error CreateFailed(uint256 index)',
])
export const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
export const usdcAbi = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function mint(address to, uint256 amount)',
])
export const spokeAbi = parseAbi(['function setMinter(address manager)', 'function minter() view returns (address)'])
export const nttAbi = parseAbi([
  'function initialize() payable',
  'function setTransceiver(address transceiver)',
  'function setThreshold(uint8 threshold)',
  'function setOutboundLimit(uint256 limit)',
  'function setInboundLimit(uint256 limit, uint16 chainId)',
  'function setPeer(uint16 peerChainId, bytes32 peerContract, uint8 decimals, uint256 inboundLimit)',
  'function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient) payable returns (uint64)',
  'function token() view returns (address)',
  'function owner() view returns (address)',
  'function getPeer(uint16 chainId) view returns ((bytes32 peerAddress, uint8 tokenDecimals))',
  'function isPaused() view returns (bool)',
  'function pause()',
  'function unpause()',
  'event TransferRedeemed(bytes32 indexed digest)',
  'event InboundTransferQueued(bytes32 digest)',
])
export const transceiverAbi = parseAbi([
  'function initialize() payable',
  'function setWormholePeer(uint16 peerChainId, bytes32 peerContract) payable',
  'function receiveMessage(bytes encodedMessage)',
  'function getWormholePeer(uint16 chainId) view returns (bytes32)',
])
export const coreAbi = parseAbi([
  'function messageFee() view returns (uint256)',
  'function chainId() view returns (uint16)',
  'function getCurrentGuardianSetIndex() view returns (uint32)',
  'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)',
])
export const architexFactoryAbi = parseAbi([
  'function createPair(address tokenA, address tokenB) returns (address pair)',
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
])
export const architexPairAbi = parseAbi(['function mint(address to) returns (uint256 liquidity)', 'function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)'])
export const v3FactoryAbi = parseAbi([
  'function createPool(address tokenA, address tokenB, uint24 fee) returns (address pool)',
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
])
export const v3PoolAbi = parseAbi([
  'function initialize(uint160 sqrtPriceX96)',
  'function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes data) returns (uint256 amount0, uint256 amount1)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)',
])

/** The CREATE2 salt EquilibriumExecutor uses for call `index` of `operation`. */
export function createSalt(operation: Hex, index: number): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [operation, BigInt(index)]))
}
/** Where call `index` of `operation` deploys `init`, before anything is sent. */
export function predict(executor: Address, operation: Hex, index: number, init: Hex): Address {
  return getContractAddress({ opcode: 'CREATE2', from: executor, salt: createSalt(operation, index), bytecode: init })
}
export function proxyInit(implementation: Address): Hex {
  return encodeDeployData({ abi: parseAbi(['constructor(address implementation, bytes data)']), bytecode: linked(CODE.ERC1967Proxy), args: [implementation, '0x'] })
}
export function withArgs(code: Hex, types: { type: string }[], args: readonly unknown[]): Hex {
  return concat([code, encodeAbiParameters(types, args)])
}
/** Wormhole universal address of an EVM contract. */
export function universal(address: Address): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`
}
