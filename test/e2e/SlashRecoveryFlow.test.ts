/**
 * E2E — Slash + Recovery flow.
 *
 * Walks the full bond economy under stress: bond → mint → slash → cure
 * → resume minting → retire → unbond. See per-test docstrings for the
 * scenario steps.
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toEth, advanceTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('E2E — SlashRecoveryFlow', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  const ASSET_VALUE = 5_000_000;
  const MAX_SUPPLY = toEth('2000');
  const COOLING = 30;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesBiomass;
  let required: bigint;
  let initialBond: bigint;
  let firstSlash: bigint;
  let secondSlash: bigint;
  let topUpAmount: bigint;

  before(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury, alice, bob] =
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
      options: {
        maxSupply: MAX_SUPPLY.toString(),
        coolingPeriod: COOLING,
        initialValuation: ASSET_VALUE,
      },
    });
    ({ token } = await F.deployBiomassToken({
      factory,
      impls,
      base,
      biomass: F.biomassParams(),
      salt: k('SLASH_TEST'),
      from: deployer,
    }));

    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(
        token.target,
        [alice.address, bob.address, issuer.address, spvOperator.address],
        true
      );
    await F.setAllMintConditions(token as any, platformAgent);
    await token.connect(spvOperator).approveMint();
  });

  it('issuer bonds exactly the required ENCL — isBonded becomes true', async () => {
    required = await staking.getRequiredStake(C.TRUST_CLASS.V, ASSET_VALUE);
    expect(required).to.equal(toEth('3200000'));
    initialBond = required;
    await encl.connect(treasury).transfer(issuer.address, initialBond);
    await encl.connect(issuer).approve(staking.target, initialBond);
    await staking
      .connect(issuer)
      .bond(token.target, initialBond, C.TRUST_CLASS.V, ASSET_VALUE);
    expect(await staking.isBonded(token.target)).to.equal(true);
  });

  it('after cooling, platform mints partial supply', async () => {
    await advanceTime(COOLING + 1);
    expect(await token.isMintReady()).to.equal(true);
    await token.connect(platformAgent).mint(alice.address, toEth('500'));
    expect(await token.balanceOf(alice.address)).to.equal(toEth('500'));
  });

  it('admin pre-emptively tops up so the first slash leaves a buffer', async () => {
    topUpAmount = toEth('100000');
    await encl.connect(treasury).transfer(issuer.address, topUpAmount);
    await encl.connect(issuer).approve(staking.target, topUpAmount);
    await staking.connect(issuer).topUp(token.target, topUpAmount);

    const bond = await staking.bonds(token.target);
    expect(bond.amount).to.equal(initialBond + topUpAmount);
  });

  it('admin slashes 50K — bond stays healthy, minting continues', async () => {
    firstSlash = toEth('50000');
    const before = await encl.balanceOf(deployer.address);
    await expect(
      staking.connect(deployer).slash(token.target, firstSlash, 'reporting_late')
    )
      .to.emit(staking, 'Slashed')
      .withArgs(token.target, firstSlash, 'reporting_late');
    const after = await encl.balanceOf(deployer.address);
    expect(after - before).to.equal(firstSlash);

    expect(await staking.isBonded(token.target)).to.equal(true);
    expect(await token.isMintReady()).to.equal(true);

    await token.connect(platformAgent).mint(alice.address, toEth('500'));
    expect(await token.balanceOf(alice.address)).to.equal(toEth('1000'));
  });

  it('admin slashes another 80K — bond falls BELOW required, mint gate locks', async () => {
    secondSlash = toEth('80000');
    await staking.connect(deployer).slash(token.target, secondSlash, 'docs_missing');

    const bond = await staking.bonds(token.target);
    expect(bond.amount).to.equal(toEth('3170000'));
    expect(await staking.isBonded(token.target)).to.equal(false);
    expect(await token.isMintReady()).to.equal(false);

    await expect(token.connect(platformAgent).mint(alice.address, toEth('1'))).to.be
      .reverted;
  });

  it('existing holders can still trade — slashing only affects new mints', async () => {
    await token.connect(alice).transfer(bob.address, toEth('100'));
    expect(await token.balanceOf(bob.address)).to.equal(toEth('100'));
    expect(await token.balanceOf(alice.address)).to.equal(toEth('900'));
  });

  it('issuer cures by topping up the missing ENCL → isMintReady recovers', async () => {
    const cure = toEth('31000');
    await encl.connect(treasury).transfer(issuer.address, cure);
    await encl.connect(issuer).approve(staking.target, cure);
    await staking.connect(issuer).topUp(token.target, cure);

    const bond = await staking.bonds(token.target);
    expect(bond.amount).to.equal(toEth('3201000'));
    expect(await staking.isBonded(token.target)).to.equal(true);
    expect(await token.isMintReady()).to.equal(true);
  });

  it('platform resumes minting and reaches Active', async () => {
    await token
      .connect(platformAgent)
      .batchMint([alice.address, bob.address], [toEth('500'), toEth('500')]);
    expect(await token.totalIssued()).to.equal(MAX_SUPPLY);
    expect(await token.mintFinalized()).to.equal(true);
    expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
  });

  it('admin cannot slash more than the remaining bond', async () => {
    const bond = await staking.bonds(token.target);
    await expect(
      staking.connect(deployer).slash(token.target, bond.amount + toEth('1'), 'overshoot')
    ).to.be.revertedWith('exceeds bond');
  });

  it('non-admin cannot slash', async () => {
    await expect(
      staking.connect(platformAgent).slash(token.target, toEth('1'), 'denied')
    ).to.be.reverted;
    await expect(
      staking.connect(issuer).slash(token.target, toEth('1'), 'denied')
    ).to.be.reverted;
  });

  it('after retirement, issuer unbonds and recovers exactly the remaining amount', async () => {
    await token.connect(spvOperator).initiateRedemption();
    await token.connect(spvOperator).retire();

    const remaining = (await staking.bonds(token.target)).amount;
    expect(remaining).to.equal(toEth('3201000'));

    const before = await encl.balanceOf(issuer.address);
    await staking.connect(issuer).unbond(token.target);
    const after = await encl.balanceOf(issuer.address);
    expect(after - before).to.equal(remaining);
    expect(await staking.isBonded(token.target)).to.equal(false);
  });

  it('totalStakedBy reflects everything correctly post-unbond', async () => {
    expect(await staking.totalStakedBy(issuer.address)).to.equal(0n);
  });
});
