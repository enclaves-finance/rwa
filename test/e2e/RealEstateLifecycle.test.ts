/**
 * E2E — full lifecycle for a non-biomass category (real-estate).
 *
 * This is the proof that the lifecycle implemented in {EnclavesRWA} is
 * category-agnostic: every step from create → mint → deploy → operate →
 * mature → retire works for a Berlin office tower exactly the same way
 * it works for a biomass concession.
 *
 * The phases here intentionally mirror Lifecycle.test.ts so a side-by-side
 * read is easy.
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toBytes32, toEth, toUSDC, advanceTime, latestTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('E2E — Real Estate lifecycle', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  const ASSET_VALUE_USD = 50_000_000;
  const MAX_SUPPLY = toEth('5000');
  const COOLING = 30;
  const PRICE_PER_TOKEN = toUSDC('11000');
  const MATURITY_IN = 730 * 86400;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesRealEstate;
  let stable: F.MockStablecoin;
  let escrow: F.RedemptionEscrow;
  let bondAmount: bigint;
  let maturityAt: number;

  before(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury, alice, bob] =
      await ethers.getSigners();
  });

  it('Phase 1 — deploys global + enclave infrastructure', async () => {
    ({ encl, staking, ir } = await F.deployGlobals({
      deployer,
      treasury,
      slashReceiver: deployer,
    }));
    ({ compliance, factory, impls } = await F.deployEnclave({
      deployer,
      platformAgent,
      ir,
      staking,
    }));
    await F.registerInvestors(
      ir,
      [issuer, spvOperator, alice, bob],
      C.COUNTRY.DE,
      deployer
    );
    expect(factory.target).to.not.equal(C.ZERO);
  });

  it('Phase 2 — creates a Berlin Tower clone via factory.deploy()', async () => {
    const base = F.biomassBaseParams({
      issuer,
      platformAgent,
      spvOperator,
      ir,
      compliance,
      staking,
      options: {
        trustClass: C.TRUST_CLASS.II,
        maxSupply: MAX_SUPPLY.toString(),
        coolingPeriod: COOLING,
        initialValuation: ASSET_VALUE_USD,
        name: 'Berlin Tower Shares',
        symbol: 'BTWR',
      },
    });
    base.contractKind = C.CONTRACT_KIND.REAL_ESTATE;
    base.jurisdiction = toBytes32('DE');
    const realEstate = {
      propertyRegistryId: toBytes32('GRUNDBUCH_B_42'),
      propertyType: k('OFFICE'),
      totalAreaSqm: 25_000,
      rentalStatus: k('LEASED'),
    };
    ({ token } = await F.deployRealEstateToken({
      factory,
      impls,
      base,
      realEstate,
      salt: k('BERLIN_TOWER'),
      from: deployer,
    }));
    expect(await token.contractKind()).to.equal(C.CONTRACT_KIND.REAL_ESTATE);
    expect(await token.name()).to.equal('Berlin Tower Shares');
    expect(await token.symbol()).to.equal('BTWR');
    expect(await token.propertyType()).to.equal(k('OFFICE'));
    expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
  });

  it('Phase 3 — wires compliance + maturity terms', async () => {
    stable = await F.deployStablecoin({ deployer });
    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.DE, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(
        token.target,
        [alice.address, bob.address, issuer.address, spvOperator.address],
        true
      );

    maturityAt = (await latestTime()) + MATURITY_IN;
    await token
      .connect(platformAgent)
      .setMaturityTerms(maturityAt, PRICE_PER_TOKEN, stable.target);
    expect(await token.maturityDate()).to.equal(BigInt(maturityAt));
  });

  it('Phase 4 — platform + SPV satisfy the mint conditions', async () => {
    await F.setAllMintConditions(token as any, platformAgent);
    await token.connect(spvOperator).approveMint();
    expect(await token.assetState()).to.equal(BigInt(C.STATE.MINT_READY));
  });

  it('Phase 5 — issuer bonds ENCL (Class II requires 4%)', async () => {
    bondAmount = await staking.getRequiredStake(C.TRUST_CLASS.II, ASSET_VALUE_USD);
    expect(bondAmount).to.equal(toEth('8000000'));
    await encl.connect(treasury).transfer(issuer.address, bondAmount);
    await encl.connect(issuer).approve(staking.target, bondAmount);
    await staking
      .connect(issuer)
      .bond(token.target, bondAmount, C.TRUST_CLASS.II, ASSET_VALUE_USD);
    expect(await staking.isBonded(token.target)).to.equal(true);
  });

  it('Phase 6 — cooling elapses → first mint succeeds', async () => {
    await advanceTime(COOLING + 1);
    expect(await token.isMintReady()).to.equal(true);

    await token.connect(platformAgent).mint(alice.address, toEth('3000'));
    expect(await token.balanceOf(alice.address)).to.equal(toEth('3000'));
  });

  it('Phase 7 — batchMint to the second investor → Active state', async () => {
    await token.connect(platformAgent).batchMint([bob.address], [toEth('2000')]);
    expect(await token.totalIssued()).to.equal(MAX_SUPPLY);
    expect(await token.mintFinalized()).to.equal(true);
    expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
  });

  it('Phase 8 — rental status updates affect the public view', async () => {
    await token.connect(platformAgent).setRentalStatus(k('VACANT'));
    expect(await token.rentalStatus()).to.equal(k('VACANT'));
    await token.connect(platformAgent).setRentalStatus(k('LEASED'));
  });

  it('Phase 9 — secondary transfer + valuation refresh', async () => {
    await token.connect(alice).transfer(bob.address, toEth('500'));
    expect(await token.balanceOf(bob.address)).to.equal(toEth('2500'));
    await token.connect(platformAgent).updateValuation(55_000_000, k('NAV'));
    expect(await token.assetValuation()).to.equal(55000000n);
  });

  it('Phase 10 — maturity triggers, holders redeem, SPV retires', async () => {
    escrow = await F.deployRedemptionEscrow({
      deployer,
      platformAgent,
      token,
      paymentToken: stable,
      owner: deployer,
    });
    await token.connect(platformAgent).setRedemptionEscrow(escrow.target);
    const buybackTotal = toUSDC('55000000');
    await stable.connect(deployer).mint(platformAgent.address, buybackTotal);
    await stable.connect(platformAgent).approve(escrow.target, buybackTotal);
    await escrow.connect(platformAgent).fund(buybackTotal);

    await advanceTime(MATURITY_IN + 10);
    await token.triggerMaturity();
    expect(await token.matured()).to.equal(true);

    for (const wallet of [alice, bob]) {
      const bal = await token.balanceOf(wallet.address);
      if (bal > 0n) await token.connect(wallet).redeemAtMaturity(bal);
    }
    expect(await token.totalSupply()).to.equal(0n);

    await token.connect(spvOperator).initiateRedemption();
    await token.connect(spvOperator).retire();
    expect(await token.assetState()).to.equal(BigInt(C.STATE.RETIRED));

    await staking.connect(issuer).unbond(token.target);
    expect(await staking.isBonded(token.target)).to.equal(false);
  });
});
