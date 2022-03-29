const { expect } = require("chai");
const { BigNumber } = require("ethers");
const { ethers } = require("hardhat");

describe("Margin contract", function () {
  let owner;
  let addr1;
  let liquidator;
  let addrs;

  let mockWeth;
  let margin;
  let mockAmm;
  let mockBaseToken;
  let mockConfig;
  let mockPriceOracle;

  let ownerInitBaseAmount = "1000000000000000000000"; //1000eth
  let addr1InitBaseAmount = "1000000000000000000000"; //1000eth
  let routerAllowance = "1000000000000000000000"; //1000eth
  let longSide = 0;
  let shortSide = 1;

  beforeEach(async function () {
    [owner, addr1, liquidator, ...addrs] = await ethers.getSigners();

    const MockWETH = await ethers.getContractFactory("MockWETH");
    const MockBaseToken = await ethers.getContractFactory("MockBaseToken");
    const MockQuoteToken = await ethers.getContractFactory("MockQuoteToken");
    mockBaseToken = await MockBaseToken.deploy("eth token", "weth");
    mockQuoteToken = await MockQuoteToken.deploy("usdt", "usdt");
    mockWeth = await MockWETH.deploy();

    const MockAmm = await ethers.getContractFactory("MockAmm");
    mockAmm = await MockAmm.deploy("amm shares", "as");

    const MockRouter = await ethers.getContractFactory("MockRouter");
    mockRouter = await MockRouter.deploy(mockBaseToken.address, mockWeth.address);

    const MockConfig = await ethers.getContractFactory("MockConfig");
    mockConfig = await MockConfig.deploy();

    const MockFactory = await ethers.getContractFactory("MockFactory");
    mockFactory = await MockFactory.deploy(mockConfig.address);
    await mockFactory.createPair();

    const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
    mockPriceOracle = await MockPriceOracle.deploy();

    let marginAddress = await mockFactory.margin();
    const Margin = await ethers.getContractFactory("Margin");
    margin = Margin.attach(marginAddress);

    await mockPriceOracle.setMarkPriceInRatio(2000 * 1e6); //2000*(1e-12)*1e18
    await mockFactory.initialize(mockBaseToken.address, mockQuoteToken.address, mockAmm.address);
    await mockRouter.setMarginContract(margin.address);
    await mockAmm.initialize(mockBaseToken.address, mockQuoteToken.address);
    await mockAmm.setReserves("1000000000000000000000", "2000000000000"); //1_000eth and 2_000_000usdt

    await mockBaseToken.mint(owner.address, ownerInitBaseAmount);
    await mockBaseToken.mint(addr1.address, addr1InitBaseAmount);
    await mockBaseToken.approve(mockRouter.address, routerAllowance);
    await mockBaseToken.connect(addr1).approve(mockRouter.address, addr1InitBaseAmount);

    await mockConfig.registerRouter(mockRouter.address);
    await mockConfig.registerRouter(owner.address);
    await mockConfig.registerRouter(addr1.address);
    await mockConfig.setBeta(100);
    await mockConfig.setInitMarginRatio(909);
    await mockConfig.setLiquidateThreshold(10000);
    await mockConfig.setLiquidateFeeRatio(2000);
    await mockConfig.setPriceOracle(mockPriceOracle.address);
    await mockConfig.setMaxCPFBoost(10);
  });

  describe("initialize", function () {
    it("revert when other address to initialize", async function () {
      await expect(
        margin.initialize(mockBaseToken.address, mockQuoteToken.address, mockAmm.address)
      ).to.be.revertedWith("Margin.initialize: FORBIDDEN");
    });
  });

  describe("addMargin", function () {
    it("add correct margin from margin", async function () {
      await mockBaseToken.transfer(margin.address, routerAllowance);
      expect((await mockBaseToken.balanceOf(margin.address)).toString()).to.be.equal(routerAllowance);
      await margin.addMargin(addr1.address, routerAllowance);
      let position = await margin.traderPositionMap(addr1.address);
      expect(position[1].toString()).to.equal(routerAllowance);
      expect((await margin.reserve()).toString()).to.be.equal(routerAllowance);
    });

    it("revert when add wrong margin", async function () {
      await expect(margin.addMargin(addr1.address, -10)).to.be.reverted;
    });

    it("revert when add before transfer", async function () {
      await expect(margin.addMargin(addr1.address, 10)).to.be.revertedWith("Margin.addMargin: WRONG_DEPOSIT_AMOUNT");
    });

    it("revert when no enough balance by router", async function () {
      await expect(mockRouter.addMargin(addr1.address, routerAllowance + 1)).to.be.revertedWith(
        "ERC20: transfer amount exceeds balance"
      );
    });

    it("margin remain baseToken, trader profit it through margin.sol", async function () {
      await mockBaseToken.connect(addr1).transfer(margin.address, addr1InitBaseAmount);
      await margin.addMargin(owner.address, addr1InitBaseAmount);
      let position = await margin.traderPositionMap(owner.address);
      expect(position[1]).to.equal(addr1InitBaseAmount);
    });

    describe("operate margin with old position", function () {
      beforeEach(async function () {
        //open long with 1eth, contract value is 2000u
        let quoteAmount = "2000000000";
        await mockRouter.addMargin(owner.address, "1000000000000000000");
        await margin.openPosition(owner.address, longSide, quoteAmount);
        let position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(-2000000000);
        expect(position[1]).to.equal("2000000000000000000");
        expect(position[2]).to.equal("1000000000000000000");
      });

      it("add an old position", async function () {
        await mockRouter.addMargin(owner.address, 2);
        let position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(-2000000000);
        expect(position[1]).to.equal("2000000000000000002");
        expect(position[2]).to.equal("1000000000000000000");
      });
    });
  });

  describe("removeMargin", async function () {
    beforeEach(async function () {
      await mockRouter.addMargin(owner.address, routerAllowance);
    });

    it("remove correct margin when no position", async function () {
      await margin.removeMargin(owner.address, owner.address, routerAllowance);
      expect(await mockBaseToken.balanceOf(owner.address)).to.equal(ownerInitBaseAmount);
    });

    it("revert when no position, have baseToken, remove wrong margin", async function () {
      await expect(margin.removeMargin(owner.address, owner.address, 0)).to.be.revertedWith(
        "Margin.removeMargin: ZERO_WITHDRAW_AMOUNT"
      );
      await expect(margin.removeMargin(owner.address, owner.address, routerAllowance + 1)).to.be.revertedWith(
        "Margin.removeMargin: NOT_ENOUGH_WITHDRAWABLE"
      );
    });

    it("revert when no position, no baseToken, remove wrong margin", async function () {
      let withdrawable = (await margin.getWithdrawable(owner.address)).toString();
      expect(withdrawable).to.be.equal(routerAllowance);
      await margin.removeMargin(owner.address, owner.address, routerAllowance);
      await expect(margin.removeMargin(owner.address, owner.address, 1)).to.be.revertedWith(
        "Margin.removeMargin: NOT_ENOUGH_WITHDRAWABLE"
      );
    });

    describe("remove margin with old position", function () {
      let quoteAmount = 1_000000;
      let price;
      beforeEach(async function () {
        await margin.openPosition(owner.address, longSide, quoteAmount);
        let position = await margin.traderPositionMap(owner.address);
        price = await mockAmm.price();
        let baseAmount = (quoteAmount * 1e18) / price;
        expect(position[0]).to.equal(-1 * quoteAmount);
        expect(position[1]).to.equal(BigNumber.from(routerAllowance).add(baseAmount));
        expect(position[2]).to.equal(baseAmount);

        await mockRouter.connect(addr1).addMargin(addr1.address, addr1InitBaseAmount);
        await margin.connect(addr1).openPosition(addr1.address, shortSide, quoteAmount);
        position = await margin.traderPositionMap(addr1.address);
        expect(position[0]).to.equal(quoteAmount);
        expect(position[1]).to.equal(BigNumber.from(addr1InitBaseAmount).sub(baseAmount));
        expect(position[2]).to.equal(baseAmount);
      });

      it("withdraw maximum margin from an old short position", async function () {
        let baseAmount = (quoteAmount * 1e18) / price;
        let expectedWithdrawable = BigNumber.from(addr1InitBaseAmount)
          .sub(baseAmount)
          .add(baseAmount * 0.9091);

        await mockRouter.connect(addr1).removeMargin(expectedWithdrawable);
        position = await margin.traderPositionMap(addr1.address);
        expect(position[0]).to.equal(quoteAmount);
        expect(position[1]).to.equal(-1 * baseAmount * 0.9091);
        expect(position[2]).to.equal(baseAmount);
      });

      it("revert when withdraw more margin from an old short position", async function () {
        let baseAmount = (quoteAmount * 1e18) / price;
        let expectedWithdrawable = BigNumber.from(addr1InitBaseAmount)
          .sub(baseAmount)
          .add(baseAmount * 0.9091);

        expect(await margin.getWithdrawable(addr1.address)).to.be.equal(expectedWithdrawable);
        await expect(mockRouter.connect(addr1).removeMargin(expectedWithdrawable.add(1))).to.be.revertedWith(
          "Margin.removeMargin: NOT_ENOUGH_WITHDRAWABLE"
        );
      });

      it("withdraw maximum margin from an old long position", async function () {
        let expectedWithdrawable = BigNumber.from(addr1InitBaseAmount).sub(1);
        await expect(mockRouter.removeMargin(expectedWithdrawable.add(1))).to.be.revertedWith(
          "Margin.removeMargin: NOT_ENOUGH_WITHDRAWABLE"
        );

        await mockRouter.removeMargin(expectedWithdrawable);
        let position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(-1 * quoteAmount);
        expect(position[1]).to.equal(quoteAmount + 1);
        expect(position[2]).to.equal(quoteAmount);
      });

      it("withdraw from an old position's fundingFee", async function () {
        let withdrawable = await margin.getWithdrawable(owner.address);
        await mockPriceOracle.setPf("-1000000000000000000");
        let fundingFee = (await margin.calFundingFee(owner.address)).toNumber();
        expect(fundingFee).to.be.greaterThanOrEqual(routerAllowance - withdrawable);
        await mockRouter.removeMargin(routerAllowance);
      });

      it("withdraw from an old position's unrealizedPnl", async function () {
        let fundingFee = await margin.calFundingFee(owner.address);
        expect(fundingFee).to.be.equal(0);
        let newPrice = 4000000000;
        await mockPriceOracle.setMarkPriceInRatio(newPrice);
        await mockAmm.setPrice(newPrice);

        let unrealizedPnl = (await margin.calUnrealizedPnl(owner.address)).toNumber();
        expect(unrealizedPnl).to.be.equal((quoteAmount * 1e18) / newPrice);

        let oldResult = await getPosition(margin, owner.address);
        await margin.removeMargin(owner.address, owner.address, unrealizedPnl);
        let newResult = await getPosition(margin, owner.address);
        expect(BigNumber.from(oldResult[1]).sub(newResult[1])).to.be.equal(unrealizedPnl);
      });
    });
  });

  describe("openPosition", async function () {
    let price;
    let oneEth = BigNumber.from("1000000000000000000");
    beforeEach(async function () {
      await mockRouter.addMargin(owner.address, routerAllowance);
      price = await mockAmm.price();
    });

    it("open correct long position", async function () {
      let quoteAmount = 1_000000;
      await margin.openPosition(owner.address, longSide, quoteAmount);
      position = await margin.traderPositionMap(owner.address);
      expect(position[0]).to.equal(-1 * quoteAmount);
      expect(position[1]).to.equal(BigNumber.from(routerAllowance).add((quoteAmount * 1e18) / price));
    });

    it("open correct short position", async function () {
      let quoteAmount = 1_000000;
      await margin.openPosition(owner.address, shortSide, quoteAmount);
      position = await margin.traderPositionMap(owner.address);
      expect(position[0]).to.equal(quoteAmount);
      expect(position[1]).to.equal(BigNumber.from(routerAllowance).sub((quoteAmount * 1e18) / price));
    });

    it("open wrong position", async function () {
      await expect(margin.openPosition(owner.address, longSide, 0)).to.be.revertedWith(
        "Margin.openPosition: ZERO_QUOTE_AMOUNT"
      );
    });

    it("revert when open position with bad liquidity or price in amm", async function () {
      await mockAmm.setPrice("1000000000000000000000");
      await expect(margin.openPosition(owner.address, longSide, 1)).to.be.revertedWith(
        "Margin.openPosition: TINY_QUOTE_AMOUNT"
      );
      await expect(margin.openPosition(owner.address, shortSide, 1)).to.be.revertedWith(
        "Margin.openPosition: TINY_QUOTE_AMOUNT"
      );
    });

    describe("open long first, then open long again", async function () {
      let price;
      beforeEach(async function () {
        let quoteAmount = 1_000000;
        price = await mockAmm.price();
        await margin.removeMargin(owner.address, owner.address, BigNumber.from(routerAllowance).sub(oneEth));
        await margin.openPosition(owner.address, longSide, quoteAmount);
        let position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(-1 * quoteAmount);
        expect(position[1]).to.equal(oneEth.add((quoteAmount * 1e18) / price));
        expect(position[2]).to.equal((quoteAmount * 1e18) / price);
      });

      it("open 5 long", async function () {
        let oldPosition = await margin.traderPositionMap(owner.address);
        await mockBaseToken.transfer(margin.address, 1);
        await margin.addMargin(owner.address, 1);

        let quoteAmount = 5;
        await margin.openPosition(owner.address, longSide, quoteAmount);
        position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(BigNumber.from(oldPosition[0]).sub(quoteAmount));
        expect(position[1]).to.equal(BigNumber.from(oldPosition[1]).add(1 + (quoteAmount * 1e18) / price));
        expect(position[2]).to.equal(BigNumber.from(oldPosition[2]).add((quoteAmount * 1e18) / price));
      });

      it("reverted when open position more than margin", async function () {
        let quoteAmount = "500000000000";
        await expect(margin.openPosition(owner.address, longSide, quoteAmount)).to.be.revertedWith(
          "Margin.openPosition: INIT_MARGIN_RATIO"
        );
      });
    });

    describe("open short first, then open long", async function () {
      let price;
      let oldPosition;
      beforeEach(async function () {
        let quoteAmount = 1_000000;
        price = await mockAmm.price();
        await margin.removeMargin(owner.address, owner.address, BigNumber.from(routerAllowance).sub(oneEth));
        await margin.openPosition(owner.address, shortSide, quoteAmount);
        oldPosition = await margin.traderPositionMap(owner.address);
        expect(oldPosition[0]).to.equal(quoteAmount);
        expect(oldPosition[1]).to.equal(oneEth.sub((quoteAmount * 1e18) / price));
        expect(oldPosition[2]).to.equal((quoteAmount * 1e18) / price);
      });

      it("open small reverse position", async function () {
        let quoteAmount = 5;
        await margin.openPosition(owner.address, longSide, quoteAmount);
        position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(oldPosition[0].sub(quoteAmount));
        expect(position[1]).to.equal(oldPosition[1].add((quoteAmount * 1e18) / price));
        expect(position[2]).to.equal(oldPosition[2].sub((quoteAmount * 1e18) / price));
      });

      it("open big reverse position, not more than former position", async function () {
        let quoteAmount = 1500000;
        await margin.openPosition(owner.address, longSide, quoteAmount);
        position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(oldPosition[0].sub(quoteAmount));
        expect(position[1]).to.equal(oldPosition[1].add((quoteAmount * 1e18) / price));
        expect(position[2]).to.equal((quoteAmount * 1e18) / price - oldPosition[2]);
      });

      it("open big reverse position, more than former position", async function () {
        let quoteAmount = 2500000;
        await margin.openPosition(owner.address, longSide, quoteAmount);
        position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(oldPosition[0].sub(quoteAmount));
        expect(position[1]).to.equal(oldPosition[1].add((quoteAmount * 1e18) / price));
        expect(position[2]).to.equal((quoteAmount * 1e18) / price - oldPosition[2]);
      });
    });

    describe("set new initMarginRatio when open position", async function () {
      let oldPosition;
      beforeEach(async function () {
        await margin.removeMargin(owner.address, owner.address, BigNumber.from(routerAllowance).sub(oneEth));
        oldPosition = await margin.traderPositionMap(owner.address);
      });

      it("can open position when 0.1 margin ratio", async function () {
        let quoteAmount = 1_000000;
        await mockConfig.setInitMarginRatio(1000);
        await margin.openPosition(owner.address, longSide, quoteAmount);
        position = await margin.traderPositionMap(owner.address);
        expect(position[0]).to.equal(-1 * quoteAmount);
        expect(position[1]).to.equal(oldPosition[1].add((quoteAmount * 1e18) / price));
        expect(position[2]).to.equal((quoteAmount * 1e18) / price);
      });

      it("revert when open position with 0.9 margin ratio while lack margin", async function () {
        let quoteAmount = 10000_000000;
        await mockConfig.setInitMarginRatio(9000);
        await expect(margin.openPosition(owner.address, longSide, quoteAmount)).to.be.revertedWith(
          "Margin.openPosition: INIT_MARGIN_RATIO"
        );
      });
    });
  });

  describe("closePosition", async function () {
    let price;
    beforeEach(async function () {
      await mockRouter.addMargin(owner.address, routerAllowance);
      price = await mockAmm.price();
      let quoteAmount = 1_000000;

      await margin.openPosition(owner.address, longSide, quoteAmount);
      position = await margin.traderPositionMap(owner.address);
      expect(position[0]).to.equal(-1 * quoteAmount);
      expect(position[1]).to.equal(BigNumber.from(routerAllowance).add((quoteAmount * 1e18) / price));
      expect(position[2]).to.equal((quoteAmount * 1e18) / price);

      await mockRouter.connect(addr1).addMargin(addr1.address, addr1InitBaseAmount);
      await margin.connect(addr1).openPosition(addr1.address, shortSide, quoteAmount);
      position = await margin.traderPositionMap(addr1.address);
      expect(position[0]).to.equal(quoteAmount);
      expect(position[1]).to.equal(BigNumber.from(addr1InitBaseAmount).sub((quoteAmount * 1e18) / price));
      expect(position[2]).to.equal((quoteAmount * 1e18) / price);
    });

    it("close all position", async function () {
      let position = await margin.traderPositionMap(owner.address);
      await margin.closePosition(owner.address, position.quoteSize.abs());
      position = await margin.traderPositionMap(owner.address);

      expect(position[0]).to.equal(0);
    });

    it("close position partly", async function () {
      let position = await margin.traderPositionMap(owner.address);
      await margin.closePosition(owner.address, position.quoteSize.abs() - 1);
      position = await margin.traderPositionMap(owner.address);
      expect(position[0]).to.equal(-1);
    });

    it("reverted when close wrong position", async function () {
      let position = await margin.traderPositionMap(owner.address);
      await expect(margin.closePosition(owner.address, 0)).to.be.revertedWith("Margin.closePosition: ZERO_POSITION");
      await expect(margin.closePosition(owner.address, position.quoteSize.abs() + 1)).to.be.revertedWith(
        "Margin.closePosition: ABOVE_POSITION"
      );
    });

    it("close liquidatable position, no remain left", async function () {
      let withdrawable = await margin.getWithdrawable(addr1.address);
      await margin.connect(addr1).removeMargin(addr1.address, addr1.address, withdrawable);
      await mockPriceOracle.setMarkPrice(40000000000);
      await mockAmm.setPrice(40000000000);

      let position = await margin.traderPositionMap(addr1.address);
      await margin.connect(addr1).closePosition(addr1.address, position.quoteSize.abs());

      let result = await getPosition(margin, addr1.address);
      expect(result[0]).to.be.equal("0");
      expect(result[1]).to.be.equal("0");
      expect(result[2]).to.be.equal("0");
    });

    it("close liquidatable position, but have remain", async function () {
      let withdrawable = await margin.getWithdrawable(addr1.address);
      await margin.connect(addr1).removeMargin(addr1.address, addr1.address, withdrawable);
      await mockPriceOracle.setMarkPrice(3000000000);
      await mockAmm.setPrice(2199976500);

      let position = await margin.traderPositionMap(addr1.address);
      await margin.connect(addr1).closePosition(addr1.address, position.quoteSize.abs());

      let result = await getPosition(margin, addr1.address);
      expect(result[0]).to.be.equal("0");
      expect(result[1]).to.be.equal("309969220");
      expect(result[2]).to.be.equal("0");
    });
  });

  describe("liquidate", async function () {
    beforeEach(async function () {
      await mockRouter.connect(addr1).addMargin(addr1.address, addr1InitBaseAmount);
      let quoteAmount = 1_000000;
      await margin.connect(addr1).openPosition(addr1.address, shortSide, quoteAmount);
      await mockConfig.registerRouter(liquidator.address);
      let withdrawable = await margin.getWithdrawable(addr1.address);
      await margin.connect(addr1).removeMargin(addr1.address, addr1.address, withdrawable);
    });

    it("liquidate 0 position, reverted", async function () {
      await expect(margin.connect(liquidator).liquidate(owner.address, liquidator.address)).to.be.revertedWith(
        "Margin.liquidate: ZERO_POSITION"
      );
    });

    it("liquidate healthy position, reverted", async function () {
      await expect(margin.connect(liquidator).liquidate(addr1.address, liquidator.address)).to.be.revertedWith(
        "Margin.liquidate: NOT_LIQUIDATABLE"
      );
    });

    it("liquidate non liquidatable position", async function () {
      let quoteAmount = 10;
      await margin.connect(addr1).openPosition(addr1.address, longSide, quoteAmount);
      await expect(margin.connect(liquidator).liquidate(addr1.address, liquidator.address)).to.be.revertedWith(
        "Margin.liquidate: NOT_LIQUIDATABLE"
      );
    });

    it("liquidate liquidatable position, have bonus", async function () {
      await mockPriceOracle.setMarkPrice(400000000000);
      await mockAmm.setPrice(2100_000000);

      let oldBalance = (await mockBaseToken.balanceOf(liquidator.address)).toNumber();
      await margin.connect(liquidator).liquidate(addr1.address, liquidator.address);
      let newBalance = (await mockBaseToken.balanceOf(liquidator.address)).toNumber();
      expect(oldBalance + 4328095238095).to.be.equal(newBalance);

      let result = await getPosition(margin, addr1.address);
      expect(result[0]).to.be.equal("0");
      expect(result[1]).to.be.equal("0");
      expect(result[2]).to.be.equal("0");
    });

    it("liquidate liquidatable position, no bonus", async function () {
      await mockPriceOracle.setMarkPrice(400000000000);
      await mockAmm.setPrice(3000_000000);

      let oldBalance = (await mockBaseToken.balanceOf(liquidator.address)).toNumber();
      await margin.connect(liquidator).liquidate(addr1.address, liquidator.address);
      let newBalance = (await mockBaseToken.balanceOf(liquidator.address)).toNumber();
      expect(oldBalance).to.be.equal(newBalance);

      let result = await getPosition(margin, addr1.address);
      expect(result[0]).to.be.equal("0");
      expect(result[1]).to.be.equal("0");
      expect(result[2]).to.be.equal("0");
    });
  });

  describe("getWithdrawable", async function () {
    let quoteAmount = 1_000000;
    let price;
    beforeEach(async function () {
      price = await mockAmm.price();
      await mockRouter.addMargin(owner.address, routerAllowance);
      await margin.openPosition(owner.address, longSide, quoteAmount);

      await mockRouter.connect(addr1).addMargin(addr1.address, routerAllowance);
      await margin.connect(addr1).openPosition(addr1.address, shortSide, quoteAmount);
    });

    it("can get withdrawable when having long", async function () {
      let baseAmount = (quoteAmount * 1e18) / price;
      let needed = BigNumber.from(baseAmount).mul(10000).div(9091).add(1).toString(); //999999950005499945000

      expect(await margin.getWithdrawable(owner.address)).to.equal(
        BigNumber.from(routerAllowance).add(baseAmount).sub(needed)
      );
    });

    it("can get withdrawable when having short", async function () {
      let baseAmount = (quoteAmount * 1e18) / price;
      expect(await margin.getWithdrawable(addr1.address)).to.equal(
        BigNumber.from(routerAllowance)
          .sub(baseAmount)
          .add(baseAmount * 0.9091)
      );
    });

    it("revert after removing withdrawable margin", async function () {
      let withdrawable = await margin.getWithdrawable(addr1.address);
      await margin.connect(addr1).removeMargin(addr1.address, addr1.address, withdrawable);
      await expect(margin.connect(addr1).removeMargin(addr1.address, addr1.address, 1)).to.be.revertedWith(
        "Margin.removeMargin: NOT_ENOUGH_WITHDRAWABLE"
      );
    });
  });

  describe("updateCPF", async function () {
    it("can update frequently and directly", async function () {
      await margin.updateCPF();
      let latestUpdateCPF1 = await margin.lastUpdateCPF();
      await margin.updateCPF();
      let latestUpdateCPF2 = await margin.lastUpdateCPF();
      expect(latestUpdateCPF2.toNumber()).to.be.greaterThan(latestUpdateCPF1.toNumber());
    });

    it("can update frequently and indirectly", async function () {
      await mockRouter.addMargin(owner.address, 8);
      await mockRouter.removeMargin(1);
      let latestUpdateCPF1 = await margin.lastUpdateCPF();
      await mockRouter.removeMargin(1);
      let latestUpdateCPF2 = await margin.lastUpdateCPF();
      expect(latestUpdateCPF2.toNumber()).to.be.greaterThan(latestUpdateCPF1.toNumber());
    });
  });

  describe.only("calFundingFee", async function () {
    let quoteAmount = 1_000000;
    let pf = BigNumber.from("1000000000000000000"); //1e18 equal to 100%
    let price;
    beforeEach(async function () {
      price = await mockAmm.price();
      await mockRouter.addMargin(owner.address, BigNumber.from(routerAllowance));
      await margin.openPosition(owner.address, longSide, quoteAmount); //start to pay funding fee
      await mockPriceOracle.setPf(pf);
    });

    it("check funding fee at different timestamp", async function () {
      //maxBoost*baseAmount*pf*time
      let baseAmount = quoteAmount / price;
      let fundingFee = BigNumber.from(pf).mul(-10) * baseAmount;
      expect(await margin.calFundingFee(owner.address)).to.be.equal(fundingFee);

      await margin.updateCPF();
      expect(await margin.calFundingFee(owner.address)).to.be.equal(BigNumber.from(fundingFee).mul(2));
      let latestUpdateCPF1 = await margin.lastUpdateCPF();

      await sleep(5000);
      //@notice: in hardhat, block.timestamp is former block timestamp, so time == 0
      expect(await margin.calFundingFee(owner.address)).to.be.equal(BigNumber.from(fundingFee).mul(2));

      await margin.updateCPF();
      expect(await margin.calFundingFee(owner.address)).to.be.equal(BigNumber.from(fundingFee).mul(7));
      let latestUpdateCPF2 = await margin.lastUpdateCPF();

      expect(BigNumber.from(latestUpdateCPF2).sub(latestUpdateCPF1).gt(0)).to.be.equal(true);
    });
  });
});

async function getPosition(margin, address) {
  let position = await margin.traderPositionMap(address);
  var result = [];
  // console.log("quote, base, trade: ", position[0].toNumber(), position[1].toNumber(), position[2].toNumber());
  result.push(position[0].toString());
  result.push(position[1].toString());
  result.push(position[2].toString());
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
