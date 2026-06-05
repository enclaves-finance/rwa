import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toEth, toBytes32 } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * Integration: every compliance rule against a fully-wired token + identity
 * registry + holder-tracking flow. Each rule is enforced both at the
 * preTransferCheck view layer AND at the actual `transfer()` call.
 */

describe('Integration — compliance transfer rules', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dave: HardhatEthersSigner;
  let exchange: HardhatEthersSigner;
  let intruder: HardhatEthersSigner;

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
      dave,
      exchange,
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

    await ir.connect(deployer).setProfile(alice.address, alice.address, C.COUNTRY.NA, true);
    await ir.connect(deployer).setProfile(bob.address, bob.address, C.COUNTRY.NA, true);
    await ir.connect(deployer).setProfile(carol.address, carol.address, C.COUNTRY.DE, true);
    await ir.connect(deployer).setProfile(dave.address, dave.address, C.COUNTRY.US, true);
    await ir
      .connect(deployer)
      .setProfile(exchange.address, exchange.address, C.COUNTRY.SG, true);
    await ir
      .connect(deployer)
      .setProfile(issuer.address, issuer.address, C.COUNTRY.NA, true);
    await ir
      .connect(deployer)
      .setProfile(spvOperator.address, spvOperator.address, C.COUNTRY.NA, true);

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
      salt: k('COMPLIANCE_INT'),
      from: deployer,
    }));

    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.DE, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(
        token.target,
        [alice.address, bob.address, carol.address, dave.address],
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
    await token.connect(platformAgent).mint(alice.address, toEth('1000'));
    await token.connect(platformAgent).mint(bob.address, toEth('500'));
  });

  it('blocks transfer to a country with no allow flag', async () => {
    await expect(token.connect(alice).transfer(dave.address, toEth('1'))).to.be.reverted;
  });

  it('allows transfer once the destination country is whitelisted', async () => {
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.US, true);
    await token.connect(alice).transfer(dave.address, toEth('1'));
    expect(await token.balanceOf(dave.address)).to.equal(toEth('1'));
  });

  it('honours per-token country override over the default', async () => {
    await compliance
      .connect(platformAgent)
      .setCountryAllowed(token.target, C.COUNTRY.DE, false);
    await expect(token.connect(alice).transfer(carol.address, toEth('1'))).to.be.reverted;
  });

  it('enforces maxBalancePerHolder', async () => {
    await compliance
      .connect(platformAgent)
      .setMaxBalancePerHolder(token.target, toEth('700'));
    await expect(token.connect(alice).transfer(bob.address, toEth('250'))).to.be.reverted;
    await token.connect(alice).transfer(bob.address, toEth('100'));
    expect(await token.balanceOf(bob.address)).to.equal(toEth('600'));
  });

  it('enforces minTransferAmount', async () => {
    await compliance
      .connect(platformAgent)
      .setMinTransferAmount(token.target, toEth('10'));
    await expect(token.connect(alice).transfer(bob.address, toEth('1'))).to.be.reverted;
    await token.connect(alice).transfer(bob.address, toEth('10'));
  });

  it('intermediary holder works without per-holder SPV approval when global=true', async () => {
    await compliance
      .connect(platformAgent)
      .registerIntermediary(exchange.address, true, toBytes32('SECURITIZE'));
    await expect(token.connect(alice).transfer(exchange.address, toEth('1'))).to.be
      .reverted;
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.SG, true);
    await token.connect(alice).transfer(exchange.address, toEth('1'));
  });

  it('intermediary scoped per-token approval', async () => {
    await compliance
      .connect(platformAgent)
      .registerIntermediary(exchange.address, false, toBytes32('TZERO'));
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.SG, true);
    await expect(token.connect(alice).transfer(exchange.address, toEth('1'))).to.be
      .reverted;
    await compliance
      .connect(platformAgent)
      .setIntermediaryTokenApproval(exchange.address, token.target, true);
    await token.connect(alice).transfer(exchange.address, toEth('1'));
  });

  it('investor count updates as holders enter / leave', async () => {
    expect(await compliance.totalInvestorCount(token.target)).to.equal(2n);
    expect(await compliance.holderCountByCountry(token.target, C.COUNTRY.NA)).to.equal(
      2n
    );

    await token.connect(alice).transfer(carol.address, toEth('1000'));
    expect(await compliance.totalInvestorCount(token.target)).to.equal(2n);
    expect(await compliance.holderCountByCountry(token.target, C.COUNTRY.NA)).to.equal(
      1n
    );
    expect(await compliance.holderCountByCountry(token.target, C.COUNTRY.DE)).to.equal(
      1n
    );
  });
});
