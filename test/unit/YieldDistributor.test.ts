import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toEth, toUSDC, advanceTime, latestTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('YieldDistributor', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
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
  let token: F.EnclavesBiomass;
  let stable: F.MockStablecoin;
  let distributor: F.YieldDistributor;

  beforeEach(async () => {
    [
      deployer,
      platformAgent,
      issuer,
      spvOperator,
      treasury,
      alice,
      bob,
      intruder,
    ] = await ethers.getSigners();

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
      C.COUNTRY.NA,
      deployer
    );

    const base = F.biomassBaseParams({
      issuer,
      platformAgent,
      spvOperator,
      ir,
      compliance,
      staking,
      options: { maxSupply: toEth('1000').toString() },
    });
    const biomass = F.biomassParams();
    ({ token } = await F.deployBiomassToken({
      factory,
      impls,
      base,
      biomass,
      salt: k('YIELD_TEST'),
      from: deployer,
    }));

    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(token.target, [alice.address, bob.address], true);

    await F.setAllMintConditions(token as any, platformAgent);
    await token.connect(spvOperator).approveMint();
    await F.fundAndBond({
      encl,
      staking,
      treasury,
      staker: issuer,
      token,
      trustClass: C.TRUST_CLASS.V,
      assetValueUsd: 20_000_000,
    });
    await token.connect(platformAgent).mint(alice.address, toEth('600'));
    await token.connect(platformAgent).mint(bob.address, toEth('400'));

    stable = await F.deployStablecoin({ deployer });
    distributor = await F.deployYieldDistributor({
      deployer,
      platformAgent,
      token,
      owner: deployer,
    });
  });

  describe('createDistribution', () => {
    it('only platform agent can create', async () => {
      await stable.connect(deployer).mint(intruder.address, toUSDC('100'));
      await stable.connect(intruder).approve(distributor.target, toUSDC('100'));
      await expect(
        distributor.connect(intruder).createDistribution(toUSDC('100'), stable.target, 0)
      ).to.be.revertedWith('not platform');
    });

    it('pulls funds and emits DistributionCreated', async () => {
      const amount = toUSDC('1000');
      await stable.connect(deployer).mint(platformAgent.address, amount);
      await stable.connect(platformAgent).approve(distributor.target, amount);
      // Distributor must call snapshot() on the token (which is gated by
      // platformAgent) so we promote the distributor to be the platform
      // agent of the token for the duration of the test.
      await token.connect(issuer).setPlatformAgent(distributor.target);

      await expect(
        distributor.connect(platformAgent).createDistribution(amount, stable.target, 0)
      ).to.emit(distributor, 'DistributionCreated');
      expect(await stable.balanceOf(distributor.target)).to.equal(amount);
      expect(await distributor.currentPeriod()).to.equal(1n);
    });

    it('rejects zero amount', async () => {
      await expect(
        distributor.connect(platformAgent).createDistribution(0, stable.target, 0)
      ).to.be.revertedWith('amount=0');
    });
  });

  describe('claim', () => {
    beforeEach(async () => {
      const amount = toUSDC('1000');
      await stable.connect(deployer).mint(platformAgent.address, amount);
      await stable.connect(platformAgent).approve(distributor.target, amount);
      await token.connect(issuer).setPlatformAgent(distributor.target);
      await distributor.connect(platformAgent).createDistribution(amount, stable.target, 0);
    });

    it('alice + bob each claim their pro-rata share', async () => {
      const aliceBefore = await stable.balanceOf(alice.address);
      const bobBefore = await stable.balanceOf(bob.address);
      await distributor.connect(alice).claim(1);
      await distributor.connect(bob).claim(1);
      const aliceAfter = await stable.balanceOf(alice.address);
      const bobAfter = await stable.balanceOf(bob.address);
      expect(aliceAfter - aliceBefore).to.equal(toUSDC('600'));
      expect(bobAfter - bobBefore).to.equal(toUSDC('400'));
    });

    it('cannot double-claim', async () => {
      await distributor.connect(alice).claim(1);
      await expect(distributor.connect(alice).claim(1)).to.be.revertedWith('claimed');
    });

    it('claimMultiple sums across periods', async () => {
      const amount = toUSDC('500');
      await stable.connect(deployer).mint(platformAgent.address, amount);
      await stable.connect(platformAgent).approve(distributor.target, amount);
      await distributor.connect(platformAgent).createDistribution(amount, stable.target, 0);

      const before = await stable.balanceOf(alice.address);
      await distributor.connect(alice).claimMultiple([1, 2]);
      const after = await stable.balanceOf(alice.address);
      expect(after - before).to.equal(toUSDC('900'));
    });

    it('getClaimable returns the share before claim and zero after', async () => {
      const before = await distributor.getClaimable(1, alice.address);
      expect(before).to.equal(toUSDC('600'));
      await distributor.connect(alice).claim(1);
      const after = await distributor.getClaimable(1, alice.address);
      expect(after).to.equal(0n);
    });

    it('non-holder gets zero share', async () => {
      expect(await distributor.getClaimable(1, intruder.address)).to.equal(0n);
      await expect(
        distributor.connect(intruder).claim(1)
      ).to.be.revertedWith('nothing to claim');
    });
  });

  describe('sweep', () => {
    it('owner can sweep after deadline', async () => {
      const amount = toUSDC('1000');
      await stable.connect(deployer).mint(platformAgent.address, amount);
      await stable.connect(platformAgent).approve(distributor.target, amount);
      await token.connect(issuer).setPlatformAgent(distributor.target);

      const now = await latestTime();
      await distributor
        .connect(platformAgent)
        .createDistribution(amount, stable.target, now + 60);
      await expect(
        distributor.connect(deployer).sweepUnclaimed(1, deployer.address)
      ).to.be.revertedWith('still open');
      await advanceTime(120);
      const before = await stable.balanceOf(deployer.address);
      await distributor.connect(deployer).sweepUnclaimed(1, deployer.address);
      const after = await stable.balanceOf(deployer.address);
      expect(after - before).to.equal(amount);
    });

    it('non-owner cannot sweep', async () => {
      const amount = toUSDC('1000');
      await stable.connect(deployer).mint(platformAgent.address, amount);
      await stable.connect(platformAgent).approve(distributor.target, amount);
      await token.connect(issuer).setPlatformAgent(distributor.target);
      const now = await latestTime();
      await distributor
        .connect(platformAgent)
        .createDistribution(amount, stable.target, now + 60);
      await advanceTime(120);
      await expect(
        distributor.connect(intruder).sweepUnclaimed(1, intruder.address)
      ).to.be.reverted;
    });
  });
});
