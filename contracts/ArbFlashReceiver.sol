// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ArbFlashReceiver — Aave v3 flash loan receiver for Arbitrum DEX arbitrage.
 *
 * Stateless: holds no funds between transactions.
 * Supports: Uniswap v3, Camelot v3 (Algebra), Balancer v2.
 *
 * Deploy once. If DEX interfaces change, redeploy (2 min on Arbitrum).
 * After deployment: set CFO_EVM_ARB_RECEIVER_ADDRESS in .env
 *
 * Aave v3 PoolAddressesProvider (constructor arg):
 *   Mainnet Arbitrum: 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb
 *   Sepolia Arbitrum: 0x36616cf17557639614c1cdDb356b1B83fc0B2132
 * Balancer Vault (constant): 0xBA12222222228d8Ba445958a75a0704d566BF2C8
 */

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

// Uniswap v3 SwapRouter (v1) — 0xE592427A0AEce92De3Edee1F18E0157C05861564
interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external returns (uint256 amountOut);
}

// Camelot v3 (Algebra) Router — 0xc873fEcbd354f5A56E00E710B90EF4201db2448d
// Different from Uniswap: no fee field, has referral address
interface ICamelotRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 limitSqrtPrice;
    }
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external returns (uint256 amountOut);
}

// Balancer Vault — 0xBA12222222228d8Ba445958a75a0704d566BF2C8 (same all chains)
interface IBalancerVault {
    enum SwapKind {
        GIVEN_IN,
        GIVEN_OUT
    }
    struct SingleSwap {
        bytes32 poolId;
        SwapKind kind;
        address assetIn;
        address assetOut;
        uint256 amount;
        bytes userData;
    }
    struct FundManagement {
        address sender;
        bool fromInternalBalance;
        address payable recipient;
        bool toInternalBalance;
    }
    function swap(
        SingleSwap calldata singleSwap,
        FundManagement calldata funds,
        uint256 limit,
        uint256 deadline
    ) external returns (uint256);
}

contract ArbFlashReceiver {
    // ── Constants ──────────────────────────────────────────────────────────
    // Mainnet default. Constructor accepts override for testnet deployment.
    address public constant BALANCER_VAULT =
        0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    uint8 public constant DEX_UNISWAP_V3 = 0;
    uint8 public constant DEX_CAMELOT_V3 = 1;
    uint8 public constant DEX_BALANCER = 2;

    // ── Packed swap instruction (avoids stack-too-deep) ────────────────────
    struct SwapLeg {
        address router;
        uint8 dexType;
        bytes32 poolId;
        uint24 fee;
    }

    // ── State ──────────────────────────────────────────────────────────────
    address public immutable owner;
    address public immutable aavePool;

    /**
     * @param aaveAddressesProvider  Aave v3 PoolAddressesProvider address.
     *        Mainnet Arbitrum: 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb
     *        Sepolia Arbitrum: 0x36616cf17557639614c1cdDb356b1B83fc0B2132
     */
    constructor(address aaveAddressesProvider) {
        owner = msg.sender;
        aavePool = IPoolAddressesProvider(aaveAddressesProvider).getPool();
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }
    modifier onlyAave() {
        require(msg.sender == aavePool, "not Aave pool");
        _;
    }

    // ── Entry point (called by CFO TypeScript layer) ────────────────────────
    /**
     * Initiate Aave v3 flash loan. Aave calls executeOperation() atomically.
     *
     * @param asset   Token to borrow (must be Aave-listed on Arbitrum)
     * @param amount  Amount in token decimals
     * @param params  ABI-encoded swap instructions (see executeOperation)
     */
    function requestFlashLoan(
        address asset,
        uint256 amount,
        bytes calldata params
    ) external onlyOwner {
        (bool ok, ) = aavePool.call(
            abi.encodeWithSignature(
                "flashLoanSimple(address,address,uint256,bytes,uint16)",
                address(this),
                asset,
                amount,
                params,
                uint16(0)
            )
        );
        require(ok, "flashLoanSimple failed");
    }

    // ── Aave callback ──────────────────────────────────────────────────────
    /**
     * Called by Aave mid-loan with borrowed funds in this contract.
     * Must repay amount + premium (0.05%) before returning true, or entire tx reverts.
     *
     * params ABI encoding (abi.encode):
     *  address buyRouter       — router address for leg 1
     *  uint8   buyDexType      — DEX_UNISWAP_V3 / DEX_CAMELOT_V3 / DEX_BALANCER
     *  bytes32 buyPoolId       — Balancer pool id (bytes32(0) for Uni/Camelot)
     *  uint24  buyFee          — Uni v3 fee tier (0 for Camelot/Balancer)
     *  address sellRouter      — router address for leg 2
     *  uint8   sellDexType
     *  bytes32 sellPoolId
     *  uint24  sellFee
     *  address tokenOut        — intermediate token (e.g. WETH)
     *  uint256 minProfit       — revert if profit < this (in asset decimals)
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external onlyAave returns (bool) {
        require(initiator == address(this), "bad initiator");

        // Decode into structs to avoid stack-too-deep (10 decoded vars + locals)
        (
            SwapLeg memory buy,
            SwapLeg memory sell,
            address tokenOut,
            uint256 minProfit
        ) = _decodeParams(params);

        uint256 repayAmount = amount + premium;

        // Leg 1: buy tokenOut with asset (e.g. USDC → WETH on cheapest DEX)
        uint256 received = _swap(buy, asset, tokenOut, amount, 0);

        // Leg 2: sell tokenOut back for asset (e.g. WETH → USDC on pricier DEX)
        uint256 returned = _swap(sell, tokenOut, asset, received, repayAmount);

        uint256 profit = returned > repayAmount ? returned - repayAmount : 0;
        require(profit >= minProfit, "insufficient profit");

        // Repay Aave
        IERC20(asset).approve(aavePool, repayAmount);

        // Profit to owner
        if (profit > 0) IERC20(asset).transfer(owner, profit);

        return true;
    }

    /// @dev Decode params into structs to stay within EVM stack limit (16 slots).
    function _decodeParams(
        bytes calldata params
    )
        internal
        pure
        returns (
            SwapLeg memory buy,
            SwapLeg memory sell,
            address tokenOut,
            uint256 minProfit
        )
    {
        (
            address buyRouter,
            uint8 buyDexType,
            bytes32 buyPoolId,
            uint24 buyFee,
            address sellRouter,
            uint8 sellDexType,
            bytes32 sellPoolId,
            uint24 sellFee,
            address _tokenOut,
            uint256 _minProfit
        ) = abi.decode(
                params,
                (
                    address,
                    uint8,
                    bytes32,
                    uint24,
                    address,
                    uint8,
                    bytes32,
                    uint24,
                    address,
                    uint256
                )
            );
        buy = SwapLeg(buyRouter, buyDexType, buyPoolId, buyFee);
        sell = SwapLeg(sellRouter, sellDexType, sellPoolId, sellFee);
        tokenOut = _tokenOut;
        minProfit = _minProfit;
    }

    // ── Internal swap dispatcher ────────────────────────────────────────────
    function _swap(
        SwapLeg memory leg,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(leg.router, amountIn);

        if (leg.dexType == DEX_UNISWAP_V3) {
            return
                IUniswapV3Router(leg.router).exactInputSingle(
                    IUniswapV3Router.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                        fee: leg.fee,
                        recipient: address(this),
                        deadline: block.timestamp,
                        amountIn: amountIn,
                        amountOutMinimum: amountOutMin,
                        sqrtPriceLimitX96: 0
                    })
                );
        } else if (leg.dexType == DEX_CAMELOT_V3) {
            return
                ICamelotRouter(leg.router).exactInputSingle(
                    ICamelotRouter.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                        recipient: address(this),
                        deadline: block.timestamp,
                        amountIn: amountIn,
                        amountOutMinimum: amountOutMin,
                        limitSqrtPrice: 0
                    })
                );
        } else {
            // DEX_BALANCER
            return
                IBalancerVault(BALANCER_VAULT).swap(
                    IBalancerVault.SingleSwap({
                        poolId: leg.poolId,
                        kind: IBalancerVault.SwapKind.GIVEN_IN,
                        assetIn: tokenIn,
                        assetOut: tokenOut,
                        amount: amountIn,
                        userData: ""
                    }),
                    IBalancerVault.FundManagement({
                        sender: address(this),
                        fromInternalBalance: false,
                        recipient: payable(address(this)),
                        toInternalBalance: false
                    }),
                    amountOutMin,
                    block.timestamp
                );
        }
    }

    // ── Safety ─────────────────────────────────────────────────────────────
    /// @notice Emergency token rescue. Contract should never hold funds between txs.
    function rescueToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
    }

    receive() external payable {}
}
