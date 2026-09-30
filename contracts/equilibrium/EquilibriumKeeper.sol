// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IArchitexPairLike {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IUniswapV3PoolLike {
    function token0() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
}

/// One keeper vault per chain: the keeper's own inventory, its own pool, and bounds it cannot exceed.
///
/// Every trade is one `run(Leg)`. The leg id is bound in `legOf` **before** any external call, and the
/// leg carries the chain id and the pool address it was planned for, so the contract on the chain
/// where the trade takes effect is what rejects a repeat or a misdirected leg — not the runner, and
/// not a transaction nonce. A replayed transaction, a restarted runner and a second runner process
/// can each only waste their own gas.
///
/// What this contract, not the runner, guarantees:
///   * a leg executes at most once, on the chain and pool it was planned for, before its deadline;
///   * a buy never pays more than its bound `limit`, a sale never receives less;
///   * cumulative quote paid out never exceeds `spendCap`, and net quote drained from this vault
///     never exceeds `drainCap`;
///   * a buy always leaves at least `recoveryReserve` quote behind, so the unwind of the position it
///     opens is funded before the position exists;
///   * at most `maxOpenCycles` cycles are open at once, and `resume()` refuses while one is open, so
///     a halted keeper cannot open new exposure while a recovery is unresolved.
///
/// What it cannot guarantee, because the two legs of a cycle run on different chains and no message
/// passes between them: that a remote sale happened. `attestClosed` is the operator recording a
/// finalized remote receipt it observed. It is an attestation, not a proof.
contract EquilibriumKeeper {
    enum Venue { ArchitexPair, UniswapV3Pool }
    enum LegKind { Buy, Sell, Recover }

    struct Leg {
        /// Bound before any call runs. Derived off-chain from the cycle id and the leg name.
        bytes32 id;
        bytes32 cycle;
        LegKind kind;
        /// Must equal block.chainid: a leg planned for Arc cannot execute on Base.
        uint256 chainId;
        /// Must equal `pool`: a leg planned for one venue cannot execute against another.
        address pool;
        /// The token quantity. Both legs of a cycle carry the same one.
        uint256 tokens;
        /// Buy: the most quote that may be paid. Sell/Recover: the least that must be received.
        uint256 limit;
        /// Unix seconds. A leg planned against a stale quote expires instead of executing.
        uint256 deadline;
    }

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address public immutable owner;
    IERC20 public immutable token;
    IERC20 public immutable quote;
    address public immutable pool;
    Venue public immutable venue;
    /// Bounds fixed at construction. The approved preview is the digest over exactly these values.
    uint256 public immutable maxTokensPerLeg;
    uint256 public immutable maxQuotePerLeg;
    uint256 public immutable spendCap;
    uint256 public immutable recoveryReserve;
    uint256 public immutable drainCap;
    uint8 public immutable maxOpenCycles;

    /// leg id => digest of the plan it executed. Zero until executed.
    mapping(bytes32 => bytes32) public legOf;
    /// cycle id => tokens bought on this chain and not yet sold, recovered or attested closed.
    mapping(bytes32 => uint256) public openTokensOf;
    uint256 public spentQuote;
    uint256 public receivedQuote;
    uint8 public openCycles;
    bool public halted;
    /// Set only for the duration of one pool call, so only that pool's callback is accepted.
    bool private swapping;
    bool private probing;

    event LegRun(bytes32 indexed leg, bytes32 indexed cycle, LegKind kind, uint256 amountIn, uint256 amountOut);
    event Halted(string reason);
    event Resumed();
    event CycleClosed(bytes32 indexed cycle, bytes32 indexed remoteLeg, uint256 tokens);
    event Withdrawn(address indexed asset, address indexed to, uint256 amount);

    /// Revert carrier for `probe`: an executable quote read straight out of the pool contract.
    error Quoted(uint256 amountIn, uint256 amountOut);

    error NotOwner();
    error LegDone(bytes32 leg, bytes32 digest);
    error WrongChain(uint256 planned, uint256 actual);
    error WrongPool(address planned, address actual);
    error LegExpired(uint256 deadline, uint256 now_);
    error Paused();
    error LegTooLarge(uint256 tokens, uint256 max);
    error LimitTooLarge(uint256 limit, uint256 max);
    error TooManyOpenCycles(uint8 open, uint8 max);
    error CycleAlreadyOpen(bytes32 cycle, uint256 tokens);
    error CycleNotOpen(bytes32 cycle);
    error RecoverAmountMismatch(uint256 open, uint256 asked);
    error MaxInExceeded(uint256 paid, uint256 limit);
    error MinOutShortfall(uint256 received, uint256 limit);
    error TokensNotDelivered(uint256 delivered, uint256 expected);
    error SpendCapExceeded(uint256 spent, uint256 cap);
    error DrainCapExceeded(uint256 drained, uint256 cap);
    error RecoveryReserveBreached(uint256 remaining, uint256 reserve);
    error CallbackForbidden();
    error NotHalted();
    error OpenExposure(uint8 open);

    constructor(
        address owner_,
        IERC20 token_,
        IERC20 quote_,
        address pool_,
        Venue venue_,
        uint256 maxTokensPerLeg_,
        uint256 maxQuotePerLeg_,
        uint256 spendCap_,
        uint256 recoveryReserve_,
        uint256 drainCap_,
        uint8 maxOpenCycles_
    ) {
        require(owner_ != address(0) && pool_ != address(0), "Invalid authority");
        require(address(token_) != address(0) && address(quote_) != address(0) && token_ != quote_, "Invalid assets");
        require(maxTokensPerLeg_ > 0 && maxQuotePerLeg_ > 0 && maxOpenCycles_ > 0, "Invalid bounds");
        require(spendCap_ >= maxQuotePerLeg_ && drainCap_ >= maxQuotePerLeg_, "Caps below one leg");
        owner = owner_;
        token = token_;
        quote = quote_;
        pool = pool_;
        venue = venue_;
        maxTokensPerLeg = maxTokensPerLeg_;
        maxQuotePerLeg = maxQuotePerLeg_;
        spendCap = spendCap_;
        recoveryReserve = recoveryReserve_;
        drainCap = drainCap_;
        maxOpenCycles = maxOpenCycles_;
    }

    // ---------------------------------------------------------------- trading

    function run(Leg calldata leg) external returns (uint256 amountIn, uint256 amountOut) {
        if (msg.sender != owner) revert NotOwner();
        if (leg.chainId != block.chainid) revert WrongChain(leg.chainId, block.chainid);
        if (leg.pool != pool) revert WrongPool(leg.pool, pool);
        bytes32 prior = legOf[leg.id];
        if (prior != bytes32(0)) revert LegDone(leg.id, prior);
        if (block.timestamp > leg.deadline) revert LegExpired(leg.deadline, block.timestamp);
        if (leg.tokens == 0 || leg.tokens > maxTokensPerLeg) revert LegTooLarge(leg.tokens, maxTokensPerLeg);
        // Bound before any external call, so no reentrant path can run this leg twice.
        legOf[leg.id] = keccak256(abi.encode(leg));

        if (leg.kind == LegKind.Buy) {
            if (halted) revert Paused();
            if (leg.limit > maxQuotePerLeg) revert LimitTooLarge(leg.limit, maxQuotePerLeg);
            if (openCycles >= maxOpenCycles) revert TooManyOpenCycles(openCycles, maxOpenCycles);
            if (openTokensOf[leg.cycle] != 0) revert CycleAlreadyOpen(leg.cycle, openTokensOf[leg.cycle]);
            (amountIn, amountOut) = _buy(leg.tokens, leg.limit);
            if (amountOut != leg.tokens) revert TokensNotDelivered(amountOut, leg.tokens);
            if (amountIn > leg.limit) revert MaxInExceeded(amountIn, leg.limit);
            spentQuote += amountIn;
            if (spentQuote > spendCap) revert SpendCapExceeded(spentQuote, spendCap);
            openTokensOf[leg.cycle] = leg.tokens;
            openCycles += 1;
            // Reserved recovery capacity: the unwind of this position is funded before it exists.
            uint256 remaining = quote.balanceOf(address(this));
            if (remaining < recoveryReserve) revert RecoveryReserveBreached(remaining, recoveryReserve);
        } else {
            if (leg.kind == LegKind.Sell) {
                if (halted) revert Paused();
            } else {
                uint256 open = openTokensOf[leg.cycle];
                if (open == 0) revert CycleNotOpen(leg.cycle);
                if (open != leg.tokens) revert RecoverAmountMismatch(open, leg.tokens);
            }
            (amountIn, amountOut) = _sell(leg.tokens);
            if (amountIn != leg.tokens) revert TokensNotDelivered(amountIn, leg.tokens);
            if (amountOut < leg.limit) revert MinOutShortfall(amountOut, leg.limit);
            receivedQuote += amountOut;
            if (leg.kind == LegKind.Recover) {
                openTokensOf[leg.cycle] = 0;
                openCycles -= 1;
                emit CycleClosed(leg.cycle, leg.id, leg.tokens);
            }
        }
        _assertDrain();
        emit LegRun(leg.id, leg.cycle, leg.kind, amountIn, amountOut);
    }

    /// Executable quote for `tokens`, read out of the pool contract and returned by reverting, so
    /// nothing is ever spent. `buy` asks what `tokens` out would cost; otherwise what `tokens` in
    /// would fetch. Call it with eth_call and decode the `Quoted` revert.
    function probe(bool buy, uint256 tokens) external {
        if (venue == Venue.UniswapV3Pool) {
            // Uniswap's own quoting route: the pool computes the swap, the callback reverts with it.
            probing = true;
            bool tokenIsZero = IUniswapV3PoolLike(pool).token0() == address(token);
            bool zeroForOne = buy ? !tokenIsZero : tokenIsZero;
            IUniswapV3PoolLike(pool).swap(
                address(this),
                zeroForOne,
                buy ? -int256(tokens) : int256(tokens),
                zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                ""
            );
            revert Quoted(0, 0); // unreachable: the callback always reverts first
        }
        (uint256 reserveToken, uint256 reserveQuote) = _architexReserves();
        if (buy) revert Quoted(_v2AmountIn(tokens, reserveQuote, reserveToken), tokens);
        revert Quoted(tokens, _v2AmountOut(tokens, reserveToken, reserveQuote));
    }

    // ---------------------------------------------------------------- control

    function halt(string calldata reason) external {
        if (msg.sender != owner) revert NotOwner();
        halted = true;
        emit Halted(reason);
    }

    /// Refuses while any cycle is open: a halted keeper never resumes over unresolved exposure.
    function resume() external {
        if (msg.sender != owner) revert NotOwner();
        if (!halted) revert NotHalted();
        if (openCycles != 0) revert OpenExposure(openCycles);
        halted = false;
        emit Resumed();
    }

    /// The operator records a finalized remote sale for `cycle`. An attestation, not a proof: no
    /// message crosses from the selling chain, so this contract cannot verify it.
    function attestClosed(bytes32 cycle, bytes32 remoteLeg) external {
        if (msg.sender != owner) revert NotOwner();
        uint256 open = openTokensOf[cycle];
        if (open == 0) revert CycleNotOpen(cycle);
        openTokensOf[cycle] = 0;
        openCycles -= 1;
        emit CycleClosed(cycle, remoteLeg, open);
    }

    /// Retrieve inventory after the pilot. Refused while a cycle is open or the keeper is halted, so
    /// reserved recovery capacity cannot be withdrawn out from under an unresolved position.
    function withdraw(IERC20 asset, address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (openCycles != 0) revert OpenExposure(openCycles);
        if (halted) revert Paused();
        require(to != address(0), "Invalid recipient");
        require(asset.transfer(to, amount), "Withdraw failed");
        emit Withdrawn(address(asset), to, amount);
    }

    // ---------------------------------------------------------------- venues

    function _assertDrain() private view {
        uint256 drained = spentQuote > receivedQuote ? spentQuote - receivedQuote : 0;
        if (drained > drainCap) revert DrainCapExceeded(drained, drainCap);
    }

    function _architexReserves() private view returns (uint256 reserveToken, uint256 reserveQuote) {
        (uint112 r0, uint112 r1,) = IArchitexPairLike(pool).getReserves();
        bool tokenIsZero = IArchitexPairLike(pool).token0() == address(token);
        return tokenIsZero ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// Architex/Uniswap v2 constant-product with the pool's own 0.30% fee, counted once.
    function _v2AmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        require(amountOut < reserveOut && reserveIn > 0, "Insufficient pool liquidity");
        return (reserveIn * amountOut * 1000) / ((reserveOut - amountOut) * 997) + 1;
    }

    function _v2AmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0, "Insufficient pool liquidity");
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * reserveOut) / (reserveIn * 1000 + inWithFee);
    }

    /// Quote in, exactly `tokens` out.
    function _buy(uint256 tokens, uint256 limit) private returns (uint256 amountIn, uint256 amountOut) {
        uint256 quoteBefore = quote.balanceOf(address(this));
        uint256 tokenBefore = token.balanceOf(address(this));
        if (venue == Venue.ArchitexPair) {
            (uint256 reserveToken, uint256 reserveQuote) = _architexReserves();
            uint256 needed = _v2AmountIn(tokens, reserveQuote, reserveToken);
            if (needed > limit) revert MaxInExceeded(needed, limit);
            bool tokenIsZero = IArchitexPairLike(pool).token0() == address(token);
            require(quote.transfer(pool, needed), "Quote transfer failed");
            swapping = true;
            IArchitexPairLike(pool).swap(tokenIsZero ? tokens : 0, tokenIsZero ? 0 : tokens, address(this), "");
            swapping = false;
        } else {
            bool tokenIsZero = IUniswapV3PoolLike(pool).token0() == address(token);
            swapping = true;
            IUniswapV3PoolLike(pool).swap(
                address(this), !tokenIsZero, -int256(tokens), !tokenIsZero ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(limit)
            );
            swapping = false;
        }
        amountIn = quoteBefore - quote.balanceOf(address(this));
        amountOut = token.balanceOf(address(this)) - tokenBefore;
    }

    /// Exactly `tokens` in, quote out.
    function _sell(uint256 tokens) private returns (uint256 amountIn, uint256 amountOut) {
        uint256 quoteBefore = quote.balanceOf(address(this));
        uint256 tokenBefore = token.balanceOf(address(this));
        if (venue == Venue.ArchitexPair) {
            (uint256 reserveToken, uint256 reserveQuote) = _architexReserves();
            uint256 out = _v2AmountOut(tokens, reserveToken, reserveQuote);
            bool tokenIsZero = IArchitexPairLike(pool).token0() == address(token);
            require(token.transfer(pool, tokens), "Token transfer failed");
            swapping = true;
            IArchitexPairLike(pool).swap(tokenIsZero ? 0 : out, tokenIsZero ? out : 0, address(this), "");
            swapping = false;
        } else {
            bool tokenIsZero = IUniswapV3PoolLike(pool).token0() == address(token);
            swapping = true;
            IUniswapV3PoolLike(pool).swap(
                address(this), tokenIsZero, int256(tokens), tokenIsZero ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1, abi.encode(tokens)
            );
            swapping = false;
        }
        amountIn = tokenBefore - token.balanceOf(address(this));
        amountOut = quote.balanceOf(address(this)) - quoteBefore;
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != pool || venue != Venue.UniswapV3Pool || !(swapping || probing)) revert CallbackForbidden();
        bool tokenIsZero = IUniswapV3PoolLike(pool).token0() == address(token);
        (int256 tokenDelta, int256 quoteDelta) = tokenIsZero ? (amount0Delta, amount1Delta) : (amount1Delta, amount0Delta);
        if (probing) {
            probing = false;
            // Positive is owed to the pool, negative is paid out by it.
            if (tokenDelta < 0) revert Quoted(uint256(quoteDelta), uint256(-tokenDelta));
            revert Quoted(uint256(tokenDelta), uint256(-quoteDelta));
        }
        if (tokenDelta > 0) {
            uint256 owed = uint256(tokenDelta);
            require(owed <= abi.decode(data, (uint256)), "Token owed above bound");
            require(token.transfer(pool, owed), "Token transfer failed");
        } else {
            uint256 owed = uint256(quoteDelta);
            if (owed > abi.decode(data, (uint256))) revert MaxInExceeded(owed, abi.decode(data, (uint256)));
            require(quote.transfer(pool, owed), "Quote transfer failed");
        }
    }
}
