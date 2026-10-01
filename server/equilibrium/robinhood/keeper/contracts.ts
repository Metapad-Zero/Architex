import { concat, encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from 'viem'
import bundle from '../../keeper/bytecode.json'
import { LEG_KIND_INDEX, VENUE_INDEX, type LegPlan } from './types'

/** Creation code of EquilibriumKeeper, from the pinned keeper manifest. */
export const KEEPER_CODE: { bytecode: string; compiler: string; sha256: string } = bundle.EquilibriumKeeper

export const keeperAbi = parseAbi([
  'struct Leg { bytes32 id; bytes32 cycle; uint8 kind; uint256 chainId; address pool; uint256 tokens; uint256 limit; uint256 deadline; }',
  'function run(Leg leg) returns (uint256 amountIn, uint256 amountOut)',
  'function probe(bool buy, uint256 tokens)',
  'function halt(string reason)',
  'function resume()',
  'function attestClosed(bytes32 cycle, bytes32 remoteLeg)',
  'function withdraw(address asset, address to, uint256 amount)',
  'function legOf(bytes32 leg) view returns (bytes32)',
  'function openTokensOf(bytes32 cycle) view returns (uint256)',
  'function owner() view returns (address)',
  'function token() view returns (address)',
  'function quote() view returns (address)',
  'function pool() view returns (address)',
  'function venue() view returns (uint8)',
  'function maxTokensPerLeg() view returns (uint256)',
  'function maxQuotePerLeg() view returns (uint256)',
  'function spendCap() view returns (uint256)',
  'function recoveryReserve() view returns (uint256)',
  'function drainCap() view returns (uint256)',
  'function maxOpenCycles() view returns (uint8)',
  'function spentQuote() view returns (uint256)',
  'function receivedQuote() view returns (uint256)',
  'function openCycles() view returns (uint8)',
  'function halted() view returns (bool)',
  'event LegRun(bytes32 indexed leg, bytes32 indexed cycle, uint8 kind, uint256 amountIn, uint256 amountOut)',
  'event Halted(string reason)',
  'event Resumed()',
  'event CycleClosed(bytes32 indexed cycle, bytes32 indexed remoteLeg, uint256 tokens)',
  'error Quoted(uint256 amountIn, uint256 amountOut)',
  'error NotOwner()',
  'error LegDone(bytes32 leg, bytes32 digest)',
  'error WrongChain(uint256 planned, uint256 actual)',
  'error WrongPool(address planned, address actual)',
  'error LegExpired(uint256 deadline, uint256 now_)',
  'error Paused()',
  'error LegTooLarge(uint256 tokens, uint256 max)',
  'error LimitTooLarge(uint256 limit, uint256 max)',
  'error TooManyOpenCycles(uint8 open, uint8 max)',
  'error CycleAlreadyOpen(bytes32 cycle, uint256 tokens)',
  'error CycleNotOpen(bytes32 cycle)',
  'error RecoverAmountMismatch(uint256 open, uint256 asked)',
  'error MaxInExceeded(uint256 paid, uint256 limit)',
  'error MinOutShortfall(uint256 received, uint256 limit)',
  'error TokensNotDelivered(uint256 delivered, uint256 expected)',
  'error SpendCapExceeded(uint256 spent, uint256 cap)',
  'error DrainCapExceeded(uint256 drained, uint256 cap)',
  'error RecoveryReserveBreached(uint256 remaining, uint256 reserve)',
  'error CallbackForbidden()',
  'error NotHalted()',
  'error OpenExposure(uint8 open)',
])

export const erc20Abi = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
])
export const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
])
export const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
])

/** The ABI-encoded Leg tuple, in the exact field order the contract declares. */
export const LEG_TUPLE = [{
  type: 'tuple',
  components: [
    { name: 'id', type: 'bytes32' }, { name: 'cycle', type: 'bytes32' }, { name: 'kind', type: 'uint8' },
    { name: 'chainId', type: 'uint256' }, { name: 'pool', type: 'address' }, { name: 'tokens', type: 'uint256' },
    { name: 'limit', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
}] as const

export interface LegStruct { id: Hex; cycle: Hex; kind: number; chainId: bigint; pool: Address; tokens: bigint; limit: bigint; deadline: bigint }

export function legStruct(plan: LegPlan): LegStruct {
  return {
    id: plan.id, cycle: cycleId(plan.cycle), kind: LEG_KIND_INDEX[plan.kind], chainId: BigInt(plan.chainId),
    pool: plan.pool, tokens: BigInt(plan.tokens), limit: BigInt(plan.limit), deadline: BigInt(plan.deadline),
  }
}

/** The bytes32 cycle id the vault sees, from the durable record's cycle name. */
export function cycleId(cycle: string): Hex { return keccak256(new TextEncoder().encode(cycle)) }

/**
 * The leg id, derived from everything that decides what the leg does. Binding the chain id and the
 * keeper address into the id is what keeps a leg planned for Arc from ever having a valid id on
 * Robinhood, on top of the vault's own `chainId`/`pool` checks.
 */
export function legId(parts: { cycle: string; kind: string; chainId: number; keeper: Address; pool: Address; tokens: string; limit: string; deadline: number }): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'string' }, { type: 'string' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [parts.cycle, parts.kind, BigInt(parts.chainId), parts.keeper, parts.pool, BigInt(parts.tokens), BigInt(parts.limit), BigInt(parts.deadline)],
  ))
}

/** What `legOf[id]` holds once the leg has executed: keccak256 over the encoded struct. */
export function legDigest(plan: LegPlan): Hex {
  return keccak256(encodeAbiParameters(LEG_TUPLE, [legStruct(plan)]))
}

export function keeperInit(args: {
  owner: Address; token: Address; quote: Address; pool: Address; venue: keyof typeof VENUE_INDEX
  maxTokensPerLeg: bigint; maxQuotePerLeg: bigint; spendCap: bigint; recoveryReserve: bigint; drainCap: bigint; maxOpenCycles: number
}): Hex {
  return concat([
    KEEPER_CODE.bytecode as Hex,
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint8' },
        { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }],
      [args.owner, args.token, args.quote, args.pool, VENUE_INDEX[args.venue],
        args.maxTokensPerLeg, args.maxQuotePerLeg, args.spendCap, args.recoveryReserve, args.drainCap, args.maxOpenCycles],
    ),
  ])
}
