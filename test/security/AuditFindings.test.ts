import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toEth, toUSDC, advanceTime, latestTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * Regression tests for the security audit findings (2026-06-05).
 *
 * Each `describe` pins the corrected behaviour for one finding so the
 * vulnerability cannot silently reappear:
 *
 *   C-1  StakingBond.bond() — issuer-gated, parameters derived on-chain,
 *        requirement re-derived against the live valuation.
 *   C-2  YieldDistributor.sweepUnclaimed() — sweeps only the period residual,
 *        never another period's funded balance; not sweepable twice.
 *   C-3  Implementation clones are initializer-locked.
 *   H-1  Frozen holders cannot exit via the redemption burns.
 *   M-1  A dedicated snapshotter can drive distributions without the full
 *        platform-agent surface.
 *   M-2  Mint enforces the recipient-side compliance caps.
 */
describe('Security — audit findings regression', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let enclaveOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let intruder: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;

  const ASSET_VALUE = 20_000_000;

  beforeEach(async () => {
    [deployer, platformAgent, issuer, enclaveOperator, treasury, alice, bob, intruder] =
      await ethers.getSigners();

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
      [issuer, enclaveOperator, alice, bob, intruder],
      C.COUNTRY.NA,
      deployer
    );
  });

  async function deployToken(
    options: Record<string, unknown> = {}
  ): Promise<F.EnclavesBiomass> {
    const base = F.biomassBaseParams({
      issuer,
      platformAgent,
      enclaveOperator,
      ir,
      compliance,
      staking,
      options: { maxSupply: toEth('1000').toString(), coolingPeriod: 0, ...options },
    });
    const { token } = await F.deployBiomassToken({
      factory,
      impls,
      base,
      biomass: F.biomassParams(),
      salt: k('SEC_TOKEN'),
      from: deployer,
    });
    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(token.target, [alice.address, bob.address], true);
    return token;
  }

  async function makeBondable(token: F.EnclavesBiomass): Promise<void> {
    await F.setAllMintConditions(token as any, platformAgent);
    await token.connect(enclaveOperator).approveMint();
  }

  async function mintTo(token: F.EnclavesBiomass): Promise<void> {
    await makeBondable(token);
    await F.fundAndBond({
      encl,
      staking,
      treasury,
      staker: issuer,
      token,
      trustClass: C.TRUST_CLASS.V,
      assetValueUsd: ASSET_VALUE,
    });
    await token.connect(platformAgent).mint(alice.address, toEth('600'));
    await token.connect(platformAgent).mint(bob.address, toEth('400'));
  }

  // ===================================================================
  // C-1 — StakingBond collateral gate
  // ===================================================================

  describe('C-1 — bond() cannot be bypassed or hijacked', () => {
    it('only the token issuer may open the bond (no front-run hijack)', async () => {
      const token = await deployToken();
      await makeBondable(token);
      await expect(
        staking.connect(intruder).bond(token.target, toEth('1'))
      ).to.be.revertedWith('not issuer');
    });

    it('collateral cannot be understated — a dust bond is rejected', async () => {
      const token = await deployToken();
      await makeBondable(token);
      // There is no caller-supplied trust class / value any more, so the
      // requirement is derived from the token's real $20M Class-V profile.
      await expect(
        staking.connect(issuer).bond(token.target, 1n)
      ).to.be.revertedWith('insufficient amount');
    });

    it('a later valuation increase makes the existing bond insufficient', async () => {
      const token = await deployToken();
      await makeBondable(token);

      const required = await staking.getRequiredStake(C.TRUST_CLASS.V, ASSET_VALUE);
      await encl.connect(treasury).transfer(issuer.address, required);
      await encl.connect(issuer).approve(staking.target, required);
      await staking.connect(issuer).bond(token.target, required);
      expect(await staking.isBonded(token.target)).to.equal(true);

      // Platform revalues the asset upward — the live re-derivation lifts the
      // requirement above the staked amount until the issuer tops up.
      await token.connect(platformAgent).updateValuation(ASSET_VALUE * 2, k('NAV'));
      expect(await staking.isBonded(token.target)).to.equal(false);

      const requiredAfter = await staking.getRequiredStake(
        C.TRUST_CLASS.V,
        ASSET_VALUE * 2
      );
      const delta = requiredAfter - required;
      await encl.connect(treasury).transfer(issuer.address, delta);
      await encl.connect(issuer).approve(staking.target, delta);
      await staking.connect(issuer).topUp(token.target, delta);
      expect(await staking.isBonded(token.target)).to.equal(true);
    });
  });

  // ===================================================================
  // C-2 — YieldDistributor per-period escrow accounting
  // ===================================================================

  describe('C-2 — sweepUnclaimed() cannot drain other open periods', () => {
    it('sweeps only the residual of the named period', async () => {
      const token = await deployToken();
      await mintTo(token);

      const stable = await F.deployStablecoin({ deployer });
      const distributor = await F.deployYieldDistributor({
        deployer,
        platformAgent,
        token,
        owner: deployer,
      });
      // M-1: the distributor only needs the snapshotter role, not the full
      // platform-agent surface, to open distributions.
      await token.connect(issuer).setSnapshotter(distributor.target);

      const amount = toUSDC('1000');
      await stable.connect(deployer).mint(platformAgent.address, amount * 2n);
      await stable.connect(platformAgent).approve(distributor.target, amount * 2n);

      const now = await latestTime();
      await distributor
        .connect(platformAgent)
        .createDistribution(amount, stable.target, now + 60); // period 1
      await distributor
        .connect(platformAgent)
        .createDistribution(amount, stable.target, now + 100_000); // period 2
      expect(await stable.balanceOf(distributor.target)).to.equal(amount * 2n);

      // Period 1's window closes; period 2 is still open and fully funded.
      await advanceTime(120);
      await distributor.connect(deployer).sweepUnclaimed(1, deployer.address);

      // Only period 1's 1000 USDC left; period 2's 1000 USDC is untouched.
      expect(await stable.balanceOf(distributor.target)).to.equal(amount);

      // A holder of the still-open period 2 can therefore still claim.
      const before = await stable.balanceOf(alice.address);
      await distributor.connect(alice).claim(2);
      const after = await stable.balanceOf(alice.address);
      expect(after - before).to.equal(toUSDC('600'));
    });

    it('a period cannot be swept twice', async () => {
      const token = await deployToken();
      await mintTo(token);

      const stable = await F.deployStablecoin({ deployer });
      const distributor = await F.deployYieldDistributor({
        deployer,
        platformAgent,
        token,
        owner: deployer,
      });
      await token.connect(issuer).setSnapshotter(distributor.target);

      const amount = toUSDC('1000');
      await stable.connect(deployer).mint(platformAgent.address, amount);
      await stable.connect(platformAgent).approve(distributor.target, amount);
      const now = await latestTime();
      await distributor
        .connect(platformAgent)
        .createDistribution(amount, stable.target, now + 60);

      await advanceTime(120);
      await distributor.connect(deployer).sweepUnclaimed(1, deployer.address);
      await expect(
        distributor.connect(deployer).sweepUnclaimed(1, deployer.address)
      ).to.be.revertedWith('already swept');
    });
  });

  // ===================================================================
  // C-3 — Implementation contracts are initializer-locked
  // ===================================================================

  describe('C-3 — implementation clones are initializer-locked', () => {
    it('the registered implementation cannot be initialized directly', async () => {
      const impl = impls.biomass;
      const base = F.biomassBaseParams({
        issuer,
        platformAgent,
        enclaveOperator,
        ir,
        compliance,
        staking,
      });
      await expect(
        impl.initialize(base as any, F.biomassParams() as any)
      ).to.be.revertedWith('Initializable: contract is already initialized');
    });
  });

  // ===================================================================
  // H-1 — Frozen holders cannot exit through redemption burns
  // ===================================================================

  describe('H-1 — redemption burns enforce the freeze', () => {
    it('a frozen holder cannot redeemBurn during Redeeming', async () => {
      const token = await deployToken();
      await mintTo(token);

      await token.connect(enclaveOperator).initiateRedemption();
      await token.connect(platformAgent).setAddressFrozen(alice.address, true);

      await expect(token.connect(alice).redeemBurn(toEth('100'))).to.be.reverted;
      // An unfrozen holder can still exit normally.
      await token.connect(bob).redeemBurn(toEth('100'));
      expect(await token.balanceOf(bob.address)).to.equal(toEth('300'));
    });

    it('a frozen holder cannot redeemAtMaturity', async () => {
      const stable = await F.deployStablecoin({ deployer });
      const token = await deployToken();

      // Maturity terms must be set before any mint.
      const maturityAt = (await latestTime()) + 1000;
      await token
        .connect(platformAgent)
        .setMaturityTerms(maturityAt, toUSDC('1'), stable.target);

      await mintTo(token);

      const escrow = await F.deployRedemptionEscrow({
        deployer,
        platformAgent,
        token,
        paymentToken: stable,
        owner: deployer,
      });
      await token.connect(platformAgent).setRedemptionEscrow(escrow.target);
      const funding = toUSDC('1000');
      await stable.connect(deployer).mint(platformAgent.address, funding);
      await stable.connect(platformAgent).approve(escrow.target, funding);
      await escrow.connect(platformAgent).fund(funding);

      await advanceTime(2000);
      await token.triggerMaturity();

      await token.connect(platformAgent).setAddressFrozen(alice.address, true);
      await expect(token.connect(alice).redeemAtMaturity(toEth('100'))).to.be.reverted;

      // Unfrozen holder redeems and receives the stablecoin payout.
      const before = await stable.balanceOf(bob.address);
      await token.connect(bob).redeemAtMaturity(toEth('400'));
      const after = await stable.balanceOf(bob.address);
      expect(after - before).to.equal(toUSDC('400'));
    });
  });

  // ===================================================================
  // M-2 — Mint enforces recipient-side compliance caps
  // ===================================================================

  describe('M-2 — issuance enforces the per-holder balance ceiling', () => {
    it('rejects a mint that would breach maxBalancePerHolder', async () => {
      const token = await deployToken();
      await makeBondable(token);
      await F.fundAndBond({
        encl,
        staking,
        treasury,
        staker: issuer,
        token,
        trustClass: C.TRUST_CLASS.V,
        assetValueUsd: ASSET_VALUE,
      });

      await compliance
        .connect(platformAgent)
        .setMaxBalancePerHolder(token.target, toEth('500'));

      await token.connect(platformAgent).mint(alice.address, toEth('500'));
      await expect(
        token.connect(platformAgent).mint(alice.address, toEth('1'))
      ).to.be.reverted;
    });
  });
});
