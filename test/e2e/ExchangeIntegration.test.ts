import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toBytes32, toEth } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * E2E — secondary-market integration scenarios from the spec. Covers
 * the three exchange-integration models (custodial, direct, intermediary)
 * and proves SPV authority survives any of them.
 */

describe('E2E — exchange integration', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let exchangeWallet: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesBiomass;

  beforeEach(async () => {
    [
      deployer,
      platformAgent,
      issuer,
      spvOperator,
      treasury,
      alice,
      bob,
      carol,
      exchangeWallet,
      user1,
      user2,
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
      [issuer, spvOperator, alice, bob, carol],
      C.COUNTRY.NA,
      deployer
    );
    await ir
      .connect(deployer)
      .setProfile(exchangeWallet.address, exchangeWallet.address, C.COUNTRY.SG, true);
    await ir.connect(deployer).setProfile(user1.address, user1.address, C.COUNTRY.GB, true);
    await ir.connect(deployer).setProfile(user2.address, user2.address, C.COUNTRY.GB, true);

    const base = F.biomassBaseParams({
      issuer,
      platformAgent,
      spvOperator,
      ir,
      compliance,
      staking,
      options: { maxSupply: toEth('10000').toString() },
    });
    const biomass = F.biomassParams();
    ({ token } = await F.deployBiomassToken({
      factory,
      impls,
      base,
      biomass,
      salt: k('EXCHANGE_E2E'),
      from: deployer,
    }));

    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(
        token.target,
        [alice.address, bob.address, carol.address],
        true
      );

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
    await token
      .connect(platformAgent)
      .batchMint(
        [alice.address, bob.address, carol.address],
        [toEth('5000'), toEth('3000'), toEth('2000')]
      );
    expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
  });

  describe('Option A — custodial model (single SPV-approved wallet)', () => {
    it('exchange wallet receives tokens as a regular SPV-approved holder', async () => {
      await compliance
        .connect(platformAgent)
        .setSpvApproval(token.target, exchangeWallet.address, true);
      await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.SG, true);

      await token.connect(alice).transfer(exchangeWallet.address, toEth('2000'));
      expect(await token.balanceOf(exchangeWallet.address)).to.equal(toEth('2000'));

      await token.connect(exchangeWallet).transfer(carol.address, toEth('500'));
      expect(await token.balanceOf(carol.address)).to.equal(toEth('2500'));
      expect(await token.balanceOf(exchangeWallet.address)).to.equal(toEth('1500'));

      expect(await compliance.totalInvestorCount(token.target)).to.equal(4n);
    });
  });

  describe('Option B — direct model (batch-approved investor wallets)', () => {
    it('platform batch-approves and tokens flow into self-custody wallets', async () => {
      await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.GB, true);
      await compliance
        .connect(platformAgent)
        .batchSetSpvApproval(token.target, [user1.address, user2.address], true);

      await token.connect(alice).transfer(user1.address, toEth('200'));
      await token.connect(alice).transfer(user2.address, toEth('300'));
      expect(await token.balanceOf(user1.address)).to.equal(toEth('200'));
      expect(await token.balanceOf(user2.address)).to.equal(toEth('300'));

      expect(await compliance.totalInvestorCount(token.target)).to.equal(5n);
      expect(await compliance.holderCountByCountry(token.target, C.COUNTRY.GB)).to.equal(
        2n
      );
    });
  });

  describe('Option C — intermediary model (global pass)', () => {
    it('exchange registered as global-approval intermediary', async () => {
      await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.SG, true);
      await compliance
        .connect(platformAgent)
        .registerIntermediary(exchangeWallet.address, true, toBytes32('SECURITIZE'));
      expect(await compliance.spvApproved(token.target, exchangeWallet.address)).to.equal(
        false
      );
      await token.connect(alice).transfer(exchangeWallet.address, toEth('1000'));
      expect(await token.balanceOf(exchangeWallet.address)).to.equal(toEth('1000'));
    });

    it('intermediary can be deactivated mid-flow', async () => {
      await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.SG, true);
      await compliance
        .connect(platformAgent)
        .registerIntermediary(exchangeWallet.address, true, toBytes32('SECURITIZE'));
      await token.connect(alice).transfer(exchangeWallet.address, toEth('1000'));
      await compliance.connect(platformAgent).deactivateIntermediary(exchangeWallet.address);
      await expect(token.connect(bob).transfer(exchangeWallet.address, toEth('1'))).to.be
        .reverted;
    });
  });

  describe('SPV authority persists post-listing', () => {
    beforeEach(async () => {
      await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.SG, true);
      await compliance
        .connect(platformAgent)
        .setSpvApproval(token.target, exchangeWallet.address, true);
      await token.connect(alice).transfer(exchangeWallet.address, toEth('2000'));
    });

    it('SPV can suspend after listing', async () => {
      await token.connect(spvOperator).suspend();
      await expect(token.connect(exchangeWallet).transfer(carol.address, toEth('1'))).to
        .be.reverted;
    });

    it('platform can seize from the exchange wallet', async () => {
      await token
        .connect(platformAgent)
        .seize(exchangeWallet.address, alice.address, toEth('500'), 'regulatory');
      expect(await token.balanceOf(exchangeWallet.address)).to.equal(toEth('1500'));
      expect(await token.balanceOf(alice.address)).to.equal(toEth('3500'));
    });
  });
});
