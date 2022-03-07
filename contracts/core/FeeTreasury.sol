// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.0;

import "./interfaces/IERC20.sol";
import "./interfaces/IAmm.sol";
import "../utils/Ownable.sol";
import "../libraries/TransferHelper.sol";
import "../libraries/TickMath.sol";
import "../core/interfaces/uniswapV3/IUniswapV3Factory.sol";
import "../core/interfaces/uniswapV3/IUniswapV3Pool.sol";
import "../core/interfaces/uniswapV3/ISwapRouter.sol";
import "../core/interfaces/IWETH.sol";

contract FeeTreasury is Ownable {
    event RatioForStakingChanged(uint8 oldRatio, uint8 newRatio);
    event RewardForStakingChanged(address indexed oldReward, address indexed newReward);
    event RewardForCashbackChanged(address indexed oldReward, address indexed newReward);
    event OperatorChanged(address indexed oldOperator, address indexed newOperator);
    event SettlementIntervalChanged(uint256 oldInterval, uint256 newInterval);
    event DistrbuteETH(
        address indexed rewardForStaking, 
        address indexed rewardForCashback, 
        uint256 ethForStaking, 
        uint256 ethForCashback,
        uint256 timestamp
    );
    event DistrbuteUSDC(
        address indexed rewardForStaking, 
        address indexed rewardForCashback, 
        uint256 usdcForStaking, 
        uint256 usdcForCashback,
        uint256 timestamp
    );

    ISwapRouter public v3Router;
    address public v3Factory;
    address public WETH;
    address public USDC;
    address public operator;
    uint24[3] public v3Fees;

    uint8 public ratioForStaking = 33;
    // the Reward contract address for staking
    address public rewardForStaking;
    // the Reward contract address for cashback
    address public rewardForCashback;

    uint256 public settlementInterval = 7*24*3600; // one week
    uint256 public nextSettleTime;

    modifier check() {
        require(msg.sender == operator, "FORBIDDEN");
        require(block.timestamp >= nextSettleTime, "NOT_REACH_TIME");
        _;
    }

    constructor(
        ISwapRouter v3Router_, 
        address USDC_,  
        address operator_, 
        address rewardForStaking_,
        address rewardForCashback_,
        uint256 nextSettleTime_
    ) {
        owner = msg.sender;
        v3Router = v3Router_;
        v3Factory = v3Router.factory();
        WETH = v3Router.WETH9();
        USDC = USDC_;
        operator = operator_;
        rewardForStaking = rewardForStaking_;
        rewardForCashback = rewardForCashback_;
        nextSettleTime = nextSettleTime_;
        v3Fees[0] = 500;
        v3Fees[1] = 3000;
        v3Fees[2] = 10000;
    }

    receive() external payable {
        assert(msg.sender == WETH); // only accept ETH via fallback from the WETH contract
    }

    function setRatioForStaking(uint8 newrRatio) external onlyOwner {
        require(newrRatio <= 100, "OVER_100%");
        emit RatioForStakingChanged(ratioForStaking, newrRatio);
        ratioForStaking = newrRatio;
    }

    function setRewardForStaking(address newReward) external onlyOwner {
        require(newReward != address(0), "ZERO_ADDRESS");
        emit RewardForStakingChanged(rewardForStaking, newReward);
        rewardForStaking = newReward;
    }

    function setRewardForCashback(address newReward) external onlyOwner {
        require(newReward != address(0), "ZERO_ADDRESS");
        emit RewardForCashbackChanged(rewardForCashback, newReward);
        rewardForCashback = newReward;
    }

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "ZERO_ADDRESS");
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function setSettlementInterval(uint256 newInterval) external onlyOwner {
        require(newInterval > 0, "ZERO");
        emit SettlementIntervalChanged(settlementInterval, newInterval);
        settlementInterval = newInterval;
    }

    function batchRemoveLiquidity(address[] memory amms) external check {
        for (uint256 i = 0; i < amms.length; i++) {
            address amm = amms[i];
            uint256 liquidity = IERC20(amm).balanceOf(address(this));
            if (liquidity == 0) continue;
            TransferHelper.safeTransfer(amm, amm, liquidity);
            IAmm(amm).burn(address(this));
        }
    }

    function batchSwapToETH(address[] memory tokens) external check {
        for (uint256 i = 0; i < tokens.length; i++) {
            address token = tokens[i];
            uint256 balance = IERC20(token).balanceOf(address(this));
            if (balance > 0 && token != WETH && token != USDC) {
                // query target pool
                address pool;
                uint256 poolLiquidity;
                for (uint256 j = 0; j < v3Fees.length; j++) {
                    address tempPool = IUniswapV3Factory(v3Factory).getPool(token, WETH, v3Fees[j]);
                    if (tempPool == address(0)) continue;
                    uint256 tempLiquidity = uint256(IUniswapV3Pool(tempPool).liquidity());
                    // use the max liquidity pool as target pool
                    if (tempLiquidity > poolLiquidity) {
                        poolLiquidity = tempLiquidity;
                        pool = tempPool;
                    }
                }

                // swap token to WETH
                uint256 allowance = IERC20(token).allowance(address(this), address(v3Router));
                if (allowance < balance) {
                    IERC20(token).approve(address(v3Router), type(uint256).max);
                }
                ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: WETH,
                    fee: IUniswapV3Pool(pool).fee(),
                    recipient: address(this),
                    amountIn: balance,
                    amountOutMinimum: 1,
                    sqrtPriceLimitX96: token < WETH ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
                });
                v3Router.exactInputSingle(params);
            }
        }
        uint256 wethBalance = IERC20(WETH).balanceOf(address(this));
        if (wethBalance > 0) IWETH(WETH).withdraw(wethBalance);
    }

    function distrbute() external check {
        uint256 ethBalance = address(this).balance;
        uint256 ethForStaking = ethBalance * ratioForStaking / 100;
        uint256 ethForCashback = ethBalance - ethForStaking;
        
        uint256 usdcBalance = IERC20(USDC).balanceOf(address(this));
        uint256 usdcForStaking = usdcBalance * ratioForStaking / 100;
        uint256 usdcForCashback = usdcBalance - usdcForStaking;

        TransferHelper.safeTransferETH(rewardForStaking, ethForStaking);
        TransferHelper.safeTransferETH(rewardForCashback, ethForCashback);
        emit DistrbuteETH(rewardForStaking, rewardForCashback, ethForStaking, ethForCashback, block.timestamp);

        TransferHelper.safeTransfer(USDC, rewardForStaking, usdcForStaking);
        TransferHelper.safeTransfer(USDC, rewardForCashback, usdcForCashback);
        emit DistrbuteUSDC(rewardForStaking, rewardForCashback, usdcForStaking, usdcForCashback, block.timestamp);

        nextSettleTime = nextSettleTime + settlementInterval;
    }
}