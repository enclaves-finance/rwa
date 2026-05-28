/**
 * E2E — explicit, step-by-step contract lifecycle.
 *
 * This file is intentionally structured as a sequence of `it()` blocks
 * that read like a story: every phase from "deploy the infrastructure"
 * through "the SPV unbonds ENCL after retirement" is its own assertion
 * so a CI failure pinpoints the exact phase that broke. State
 * accumulates across the tests via top-level variables — that's the
 * mocha pattern for lifecycle suites.
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toBytes32, toEth, toUSDC, advanceTime, latestTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('E2E — Lifecycle (step-by-step)', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dave: HardhatEthersSigner;

  const ASSET_VALUE_USD = 20_000_000;
  const MAX_SUPPLY = toEth('4000');
  const COOLING = 60;
  const PRICE_PER_TOKEN = toUSDC('5000');
  const MATURITY_IN = 365 * 86400;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesBiomass;
  let stable: F.MockStablecoin;
  let escrow: F.RedemptionEscrow;
  let distributor: F.YieldDistributor;
  let bondAmount: bigint;
  let maturityAt: number;

  before(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury, alice, bob, carol, dave] =
      await ethers.getSigners();
  });

  describe('Phase 1 — Deploy global singletons', () => {
    it('1.1  deploys ENCL with fixed supply minted to the treasury', async () => {
      ({ encl, staking, ir } = await F.deployGlobals({
        deployer,
        treasury,
        slashReceiver: deployer,
      }));
      expect(await encl.name()).to.equal('Enclaves');
      expect(await encl.symbol()).to.equal('ENCL');
      expect(await encl.totalSupply()).to.equal(await encl.balanceOf(treasury.address));
    });

    it('1.2  deploys StakingBond bound to ENCL with default rates seeded', async () => {
      expect(await staking.enclToken()).to.equal(encl.target);
      expect(await staking.bondingRateBps(C.TRUST_CLASS.V)).to.equal(1600n);
    });

    it('1.3  deploys the Identity Registry stub', async () => {
      expect(await ir.admin()).to.equal(deployer.address);
    });
  });

  describe('Phase 2 — Deploy enclave infrastructure', () => {
    it('2.1  deploys EnclavesCompliance bound to the enclave id + IR', async () => {
      ({ compliance, factory, impls } = await F.deployEnclave({
        deployer,
        platformAgent,
        ir,
        staking,
      }));
      expect(await compliance.enclaveId()).to.equal(C.ENCLAVE_ID);
      expect(await compliance.identityRegistry()).to.equal(ir.target);
      expect(await compliance.platformAgent()).to.equal(platformAgent.address);
    });

    it('2.2  deploys the per-category implementation contracts', async () => {
      expect(impls.biomass.target).to.not.equal(C.ZERO);
      expect(impls.realEstate.target).to.not.equal(C.ZERO);
      expect(impls.preciousMetals.target).to.not.equal(C.ZERO);
      expect(impls.securities.target).to.not.equal(C.ZERO);
      expect(impls.collectibles.target).to.not.equal(C.ZERO);
    });

    it('2.3  deploys the factory with the full enclave wiring', async () => {
      expect(await factory.enclaveId()).to.equal(C.ENCLAVE_ID);
      expect(await factory.identityRegistry()).to.equal(ir.target);
      expect(await factory.compliance()).to.equal(compliance.target);
      expect(await factory.stakingBond()).to.equal(staking.target);
      expect(await factory.platformAgent()).to.equal(platformAgent.address);
    });
  });

  describe('Phase 3 — Register category implementations', () => {
    it('3.1  every category resolves to its implementation', async () => {
      expect(await factory.implementations(C.CONTRACT_KIND.BIOMASS)).to.equal(
        impls.biomass.target
      );
      expect(await factory.implementations(C.CONTRACT_KIND.REAL_ESTATE)).to.equal(
        impls.realEstate.target
      );
      expect(await factory.implementations(C.CONTRACT_KIND.SECURITIES)).to.equal(
        impls.securities.target
      );
    });
  });

  describe('Phase 4 — Create token via factory.deploy()', () => {
    it('4.1  identity-registers issuer, SPV and investors', async () => {
      await F.registerInvestors(
        ir,
        [issuer, spvOperator, alice, bob, carol, dave],
        C.COUNTRY.NA,
        deployer
      );
      expect(await ir.isVerified(alice.address)).to.equal(true);
    });

    it('4.2  deploys a fresh EnclavesBiomass clone with full init params', async () => {
      const base = F.biomassBaseParams({
        issuer,
        platformAgent,
        spvOperator,
        ir,
        compliance,
        staking,
        options: {
          maxSupply: MAX_SUPPLY.toString(),
          coolingPeriod: COOLING,
          initialValuation: ASSET_VALUE_USD,
        },
      });
      const biomass = F.biomassParams({
        revenueStartDate: (await latestTime()) + 86400,
        revenueEndDate: (await latestTime()) + 5 * 365 * 86400,
      });
      ({ token } = await F.deployBiomassToken({
        factory,
        impls,
        base,
        biomass,
        salt: k('LIFECYCLE_TEST'),
        from: deployer,
      }));
      expect(token.target).to.not.equal(C.ZERO);
    });

    it('4.3  the freshly-deployed token starts in AssetState.Registered', async () => {
      expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
      expect(await token.totalIssued()).to.equal(0n);
      expect(await token.mintFinalized()).to.equal(false);
    });

    it('4.4  the token is indexed in the factory registry', async () => {
      expect(await factory.allTokensLength()).to.equal(1n);
      expect(await factory.allTokens(0)).to.equal(token.target);
      const rec = await factory.tokenRegistry(token.target);
      expect(rec.issuer).to.equal(issuer.address);
      expect(rec.spvOperator).to.equal(spvOperator.address);
      expect(rec.contractKind).to.equal(C.CONTRACT_KIND.BIOMASS);
    });

    it('4.5  the token has the spec-required identity fields', async () => {
      expect(await token.spvEntityId()).to.equal(toBytes32('EXAMPLE_BIOMASS_SPV'));
      expect(await token.trustClass()).to.equal(BigInt(C.TRUST_CLASS.V));
      expect(await token.maxSupply()).to.equal(MAX_SUPPLY);
      expect(await token.coolingPeriod()).to.equal(BigInt(COOLING));
    });

    it('4.6  the token cannot be re-initialized', async () => {
      const base = F.biomassBaseParams({
        issuer,
        platformAgent,
        spvOperator,
        ir,
        compliance,
        staking,
      });
      await expect(token.initialize(base as any, F.biomassParams() as any)).to.be.reverted;
    });
  });

  describe('Phase 5 — Wire compliance for the new token', () => {
    it('5.1  enclave admin registers the token with compliance', async () => {
      await compliance.connect(deployer).registerToken(token.target);
      expect(await compliance.registeredTokens(token.target)).to.equal(true);
    });

    it('5.2  platform whitelists the destination country', async () => {
      await compliance
        .connect(platformAgent)
        .setDefaultCountryAllowed(C.COUNTRY.NA, true);
      expect(await compliance.countryAllowed(token.target, C.COUNTRY.NA)).to.equal(true);
    });

    it('5.3  platform SPV-approves all known investors', async () => {
      await compliance
        .connect(platformAgent)
        .batchSetSpvApproval(
          token.target,
          [
            alice.address,
            bob.address,
            carol.address,
            dave.address,
            issuer.address,
            spvOperator.address,
          ],
          true
        );
      expect(await compliance.spvApproved(token.target, alice.address)).to.equal(true);
    });
  });

  describe('Phase 6 — Lock maturity terms', () => {
    it('6.1  deploys the stablecoin used for buyback', async () => {
      stable = await F.deployStablecoin({ deployer });
      expect(await stable.symbol()).to.equal('USDC');
    });

    it('6.2  platform sets maturity terms (locks them in)', async () => {
      maturityAt = (await latestTime()) + MATURITY_IN;
      await expect(
        token
          .connect(platformAgent)
          .setMaturityTerms(maturityAt, PRICE_PER_TOKEN, stable.target)
      ).to.emit(token, 'MaturityTermsSet');
      expect(await token.maturityDate()).to.equal(BigInt(maturityAt));
      expect(await token.buybackPricePerToken()).to.equal(PRICE_PER_TOKEN);
      expect(await token.buybackToken()).to.equal(stable.target);
    });

    it('6.3  maturity terms are immutable once set', async () => {
      await expect(
        token.connect(platformAgent).setMaturityTerms(0, 0, stable.target)
      ).to.be.reverted;
    });
  });

  describe('Phase 7 — Platform sets mint conditions', () => {
    it('7.1  mint reverts while no conditions are set', async () => {
      await expect(token.connect(platformAgent).mint(alice.address, toEth('1'))).to.be
        .reverted;
    });

    it('7.2  platform sets verificationComplete', async () => {
      await token.connect(platformAgent).setMintCondition('verificationComplete', true);
      expect((await token.mintConditions()).verificationComplete).to.equal(true);
    });

    it('7.3  platform sets spvActive', async () => {
      await token.connect(platformAgent).setMintCondition('spvActive', true);
      expect((await token.mintConditions()).spvActive).to.equal(true);
    });

    it('7.4  platform sets noEncumbrances', async () => {
      await token.connect(platformAgent).setMintCondition('noEncumbrances', true);
      expect((await token.mintConditions()).noEncumbrances).to.equal(true);
    });

    it('7.5  platform sets documentGatingSatisfied', async () => {
      await token
        .connect(platformAgent)
        .setMintCondition('documentGatingSatisfied', true);
      expect((await token.mintConditions()).documentGatingSatisfied).to.equal(true);
    });

    it('7.6  state is still Registered until SPV approves', async () => {
      expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
      expect(await token.isMintReady()).to.equal(false);
    });
  });

  describe('Phase 8 — SPV approves the mint', () => {
    it('8.1  SPV calls approveMint() → state transitions to MintReady', async () => {
      await expect(token.connect(spvOperator).approveMint()).to.emit(
        token,
        'AssetStateChanged'
      );
      expect(await token.assetState()).to.equal(BigInt(C.STATE.MINT_READY));
    });

    it('8.2  isMintReady is still false (cooling not elapsed + no bond)', async () => {
      expect(await token.isMintReady()).to.equal(false);
    });
  });

  describe('Phase 9 — Issuer bonds ENCL', () => {
    it('9.1  issuer transfers + approves required ENCL', async () => {
      const required = await staking.getRequiredStake(C.TRUST_CLASS.V, ASSET_VALUE_USD);
      expect(required).to.equal(toEth('12800000'));
      bondAmount = required;
    });

    it('9.2  issuer calls StakingBond.bond() and isBonded becomes true', async () => {
      await encl.connect(treasury).transfer(issuer.address, bondAmount);
      await encl.connect(issuer).approve(staking.target, bondAmount);
      await expect(
        staking
          .connect(issuer)
          .bond(token.target, bondAmount, C.TRUST_CLASS.V, ASSET_VALUE_USD)
      ).to.emit(staking, 'Bonded');
      expect(await staking.isBonded(token.target)).to.equal(true);
    });

    it('9.3  isMintReady is still false (cooling not elapsed)', async () => {
      expect(await token.isMintReady()).to.equal(false);
    });
  });

  describe('Phase 10 — Cooling period elapses', () => {
    it('10.1  mint reverts before cooling expires', async () => {
      await expect(token.connect(platformAgent).mint(alice.address, toEth('1'))).to.be
        .reverted;
    });

    it('10.2  after the cooling window, isMintReady() returns true', async () => {
      await advanceTime(COOLING + 1);
      expect(await token.isMintReady()).to.equal(true);
    });
  });

  describe('Phase 11 — First mint', () => {
    it('11.1  platform mints 1500 tokens to alice', async () => {
      await expect(token.connect(platformAgent).mint(alice.address, toEth('1500'))).to
        .emit(token, 'IssuanceRoundRecorded');
      expect(await token.balanceOf(alice.address)).to.equal(toEth('1500'));
      expect(await token.totalIssued()).to.equal(toEth('1500'));
    });

    it('11.2  alice is recorded as a holder', async () => {
      expect(await token.isHolder(alice.address)).to.equal(true);
      expect(await token.holderCount()).to.equal(1n);
    });

    it('11.3  alice has an issuance round under her ONCHAINID', async () => {
      const rounds = await token.getIssuanceRounds(alice.address);
      expect(rounds.length).to.equal(1);
      expect(rounds[0].amount).to.equal(toEth('1500'));
    });

    it('11.4  rejects mint to an un-verified address', async () => {
      const intruder = '0x000000000000000000000000000000000000dead';
      await expect(token.connect(platformAgent).mint(intruder, toEth('1'))).to.be
        .reverted;
    });
  });

  describe('Phase 12 — batchMint to remaining investors', () => {
    it('12.1  platform batchMints to bob (1500) + carol (1000)', async () => {
      await expect(
        token
          .connect(platformAgent)
          .batchMint([bob.address, carol.address], [toEth('1500'), toEth('1000')])
      ).to.emit(token, 'IssuanceRoundRecorded');
      expect(await token.balanceOf(bob.address)).to.equal(toEth('1500'));
      expect(await token.balanceOf(carol.address)).to.equal(toEth('1000'));
    });

    it('12.2  totalIssued equals maxSupply', async () => {
      expect(await token.totalIssued()).to.equal(MAX_SUPPLY);
    });
  });

  describe('Phase 13 — Auto-finalisation', () => {
    it('13.1  mintFinalized flips to true', async () => {
      expect(await token.mintFinalized()).to.equal(true);
    });

    it('13.2  state transitions to Active', async () => {
      expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
    });

    it('13.3  further mints revert permanently', async () => {
      await expect(token.connect(platformAgent).mint(alice.address, 1)).to.be.reverted;
    });
  });

  describe('Phase 14 — Secondary market transfer', () => {
    it('14.1  alice sends 500 tokens to dave; compliance accepts', async () => {
      const res = await token.preTransferCheck(alice.address, dave.address, toEth('500'));
      expect(res.code).to.equal(0n);
      await token.connect(alice).transfer(dave.address, toEth('500'));
      expect(await token.balanceOf(alice.address)).to.equal(toEth('1000'));
      expect(await token.balanceOf(dave.address)).to.equal(toEth('500'));
    });

    it('14.2  holderCount now includes dave', async () => {
      expect(await token.holderCount()).to.equal(4n);
      expect(await token.isHolder(dave.address)).to.equal(true);
    });
  });

  describe('Phase 15 — Snapshot + yield distribution', () => {
    it('15.1  deploys YieldDistributor and grants it the platform-agent role', async () => {
      distributor = await F.deployYieldDistributor({
        deployer,
        platformAgent,
        token,
        owner: deployer,
      });
      await token.connect(issuer).setPlatformAgent(distributor.target);
      expect(await token.platformAgent()).to.equal(distributor.target);
    });

    it('15.2  platform creates a $100K yield distribution period', async () => {
      const amount = toUSDC('100000');
      await stable.connect(deployer).mint(platformAgent.address, amount);
      await stable.connect(platformAgent).approve(distributor.target, amount);
      await expect(
        distributor.connect(platformAgent).createDistribution(amount, stable.target, 0)
      ).to.emit(distributor, 'DistributionCreated');
      expect(await distributor.currentPeriod()).to.equal(1n);
    });

    it('15.3  each holder claims their pro-rata share', async () => {
      const before = await Promise.all([
        stable.balanceOf(alice.address),
        stable.balanceOf(bob.address),
        stable.balanceOf(carol.address),
        stable.balanceOf(dave.address),
      ]);
      await distributor.connect(alice).claim(1);
      await distributor.connect(bob).claim(1);
      await distributor.connect(carol).claim(1);
      await distributor.connect(dave).claim(1);
      const after = await Promise.all([
        stable.balanceOf(alice.address),
        stable.balanceOf(bob.address),
        stable.balanceOf(carol.address),
        stable.balanceOf(dave.address),
      ]);
      expect(after[0] - before[0]).to.equal(toUSDC('25000'));
      expect(after[1] - before[1]).to.equal(toUSDC('37500'));
      expect(after[2] - before[2]).to.equal(toUSDC('25000'));
      expect(after[3] - before[3]).to.equal(toUSDC('12500'));
    });

    it('15.4  rotates the platform agent back to the canonical wallet', async () => {
      await token.connect(issuer).setPlatformAgent(platformAgent.address);
      expect(await token.platformAgent()).to.equal(platformAgent.address);
    });
  });

  describe('Phase 16 — Suspend / Resume by SPV', () => {
    it('16.1  SPV suspends the asset → transfers blocked', async () => {
      await token.connect(spvOperator).suspend();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.SUSPENDED));
      expect(await token.paused()).to.equal(true);
      await expect(token.connect(alice).transfer(bob.address, toEth('1'))).to.be.reverted;
    });

    it('16.2  SPV resumes → transfers re-open', async () => {
      await token.connect(spvOperator).resume();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
      await token.connect(alice).transfer(bob.address, toEth('1'));
      expect(await token.balanceOf(bob.address)).to.equal(toEth('1501'));
    });
  });

  describe('Phase 17 — Update valuation', () => {
    it('17.1  platform updates valuation; TVL fields refresh', async () => {
      await expect(
        token.connect(platformAgent).updateValuation(25_000_000, k('NAV'))
      ).to.emit(token, 'ValuationUpdated');
      expect(await token.assetValuation()).to.equal(25_000_000n);
      expect(await token.valuationMethodology()).to.equal(k('NAV'));
    });
  });

  describe('Phase 18 — Operational flags', () => {
    it('18.1  platform raises underAudit', async () => {
      await token.connect(platformAgent).setOperationalFlag('underAudit', true);
      const s = await token.getOperationalStatus();
      expect(s.underAudit).to.equal(true);
    });

    it('18.2  platform lowers underAudit', async () => {
      await token.connect(platformAgent).setOperationalFlag('underAudit', false);
      const s = await token.getOperationalStatus();
      expect(s.underAudit).to.equal(false);
    });
  });

  describe('Phase 19 — Maturity trigger + escrow funding', () => {
    it('19.1  deploys and wires the RedemptionEscrow', async () => {
      escrow = await F.deployRedemptionEscrow({
        deployer,
        platformAgent,
        token,
        paymentToken: stable,
        owner: deployer,
      });
      await token.connect(platformAgent).setRedemptionEscrow(escrow.target);
      expect(await token.redemptionEscrow()).to.equal(escrow.target);
    });

    it('19.2  platform funds the escrow for the full buyback', async () => {
      const buybackTotal = toUSDC('20000000');
      await stable.connect(deployer).mint(platformAgent.address, buybackTotal);
      await stable.connect(platformAgent).approve(escrow.target, buybackTotal);
      await escrow.connect(platformAgent).fund(buybackTotal);
      expect(await escrow.availableFunds()).to.equal(buybackTotal);
    });

    it('19.3  maturity cannot trigger before its timestamp', async () => {
      await expect(token.triggerMaturity()).to.be.revertedWith('not yet');
    });

    it('19.4  fast-forward past maturity then anyone triggers it', async () => {
      await advanceTime(MATURITY_IN + 10);
      await expect(token.triggerMaturity()).to.emit(token, 'AssetMatured');
      expect(await token.matured()).to.equal(true);
    });
  });

  describe('Phase 20 — Holders redeem at maturity', () => {
    it('20.1  alice redeems her tokens for the spec-defined payout', async () => {
      const aliceBalance = await token.balanceOf(alice.address);
      const expectedPayout = (aliceBalance * PRICE_PER_TOKEN) / toEth('1');
      const before = await stable.balanceOf(alice.address);
      await token.connect(alice).redeemAtMaturity(aliceBalance);
      const after = await stable.balanceOf(alice.address);
      expect(after - before).to.equal(expectedPayout);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });

    it('20.2  all remaining holders redeem; supply reaches zero', async () => {
      for (const wallet of [bob, carol, dave]) {
        const bal = await token.balanceOf(wallet.address);
        if (bal > 0n) await token.connect(wallet).redeemAtMaturity(bal);
      }
      expect(await token.totalSupply()).to.equal(0n);
      expect(await token.holderCount()).to.equal(0n);
    });
  });

  describe('Phase 21 — SPV retires the asset', () => {
    it('21.1  SPV initiates redemption', async () => {
      await token.connect(spvOperator).initiateRedemption();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.REDEEMING));
    });

    it('21.2  SPV retires the asset', async () => {
      await token.connect(spvOperator).retire();
      expect(await token.assetState()).to.equal(BigInt(C.STATE.RETIRED));
    });
  });

  describe('Phase 22 — Issuer unbonds ENCL', () => {
    it('22.1  issuer recovers exactly the original bond amount', async () => {
      const before = await encl.balanceOf(issuer.address);
      await staking.connect(issuer).unbond(token.target);
      const after = await encl.balanceOf(issuer.address);
      expect(after - before).to.equal(bondAmount);
      expect(await staking.isBonded(token.target)).to.equal(false);
    });
  });
});
