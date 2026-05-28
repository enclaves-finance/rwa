/**
 * E2E — frozen-address regulatory flow.
 *
 * Compliance + regulator workflow when a holder must be frozen mid-life.
 * See per-test docstrings for the exact scenario steps.
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toEth, advanceTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('E2E — FrozenAddressFlow', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let recoveryWallet: HardhatEthersSigner;

  const ASSET_VALUE = 10_000_000;
  const MAX_SUPPLY = toEth('3000');
  const COOLING = 30;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesBiomass;

  before(async () => {
    [
      deployer,
      platformAgent,
      issuer,
      spvOperator,
      treasury,
      alice,
      bob,
      carol,
      recoveryWallet,
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
      [issuer, spvOperator, alice, bob, carol, recoveryWallet],
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
      salt: k('FROZEN_TEST'),
      from: deployer,
    }));

    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(
        token.target,
        [
          alice.address,
          bob.address,
          carol.address,
          recoveryWallet.address,
          issuer.address,
          spvOperator.address,
        ],
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
      assetValueUsd: ASSET_VALUE,
    });
    await advanceTime(COOLING + 1);
    await token
      .connect(platformAgent)
      .batchMint(
        [alice.address, bob.address, carol.address],
        [toEth('1500'), toEth('1000'), toEth('500')]
      );
    expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
  });

  it('baseline: all three holders can transfer freely', async () => {
    await token.connect(alice).transfer(carol.address, toEth('10'));
    expect(await token.balanceOf(carol.address)).to.equal(toEth('510'));
    await token.connect(carol).transfer(alice.address, toEth('10'));
    expect(await token.balanceOf(alice.address)).to.equal(toEth('1500'));
  });

  it('platform freezes alice; AddressFrozen event fires', async () => {
    await expect(token.connect(platformAgent).setAddressFrozen(alice.address, true))
      .to.emit(token, 'AddressFrozen')
      .withArgs(alice.address, true);
    expect(await token.isFrozen(alice.address)).to.equal(true);
  });

  it('alice cannot send: preTransferCheck returns SENDER_FROZEN (7)', async () => {
    const res = await token.preTransferCheck(alice.address, bob.address, toEth('1'));
    expect(res.code).to.equal(BigInt(C.REASON.SENDER_FROZEN));
    await expect(token.connect(alice).transfer(bob.address, toEth('1'))).to.be.reverted;
  });

  it('alice cannot receive: preTransferCheck returns RECIPIENT_FROZEN (8)', async () => {
    const res = await token.preTransferCheck(bob.address, alice.address, toEth('1'));
    expect(res.code).to.equal(BigInt(C.REASON.RECIPIENT_FROZEN));
    await expect(token.connect(bob).transfer(alice.address, toEth('1'))).to.be.reverted;
  });

  it('bob ↔ carol transfers remain unaffected', async () => {
    await token.connect(bob).transfer(carol.address, toEth('5'));
    expect(await token.balanceOf(carol.address)).to.equal(toEth('505'));
  });

  it('platform seize() bypasses the freeze and moves alice → recoveryWallet', async () => {
    const aliceBefore = await token.balanceOf(alice.address);
    await expect(
      token
        .connect(platformAgent)
        .seize(alice.address, recoveryWallet.address, aliceBefore, 'OFAC_SANCTIONS')
    )
      .to.emit(token, 'Seized')
      .withArgs(alice.address, recoveryWallet.address, aliceBefore, 'OFAC_SANCTIONS');
    expect(await token.balanceOf(alice.address)).to.equal(0n);
    expect(await token.balanceOf(recoveryWallet.address)).to.equal(aliceBefore);
  });

  it('seize() to an un-verified destination is rejected', async () => {
    const unknown = '0x000000000000000000000000000000000000abcd';
    await expect(
      token
        .connect(platformAgent)
        .seize(recoveryWallet.address, unknown, toEth('1'), 'malformed')
    ).to.be.reverted;
  });

  it('alice remains frozen after the seize (state is independent)', async () => {
    expect(await token.isFrozen(alice.address)).to.equal(true);
    // Bob sends some tokens back; the refund to alice must fail (frozen).
    await token.connect(recoveryWallet).transfer(bob.address, toEth('1'));
    await expect(token.connect(bob).transfer(alice.address, toEth('1'))).to.be.reverted;
  });

  it('platform unfreezes alice; she can transfer normally again', async () => {
    await token.connect(platformAgent).setAddressFrozen(alice.address, false);
    expect(await token.isFrozen(alice.address)).to.equal(false);
    await token.connect(recoveryWallet).transfer(alice.address, toEth('100'));
    await token.connect(alice).transfer(carol.address, toEth('5'));
    expect(await token.balanceOf(alice.address)).to.equal(toEth('95'));
  });

  it('freeze persists across suspend / resume cycles', async () => {
    await token.connect(platformAgent).setAddressFrozen(alice.address, true);
    await token.connect(spvOperator).suspend();
    expect(await token.assetState()).to.equal(BigInt(C.STATE.SUSPENDED));
    await token.connect(spvOperator).resume();
    expect(await token.isFrozen(alice.address)).to.equal(
      true,
      'freeze must survive suspend cycle'
    );
    await token.connect(platformAgent).setAddressFrozen(alice.address, false);
  });

  it('non-platform cannot freeze (only the platform agent is authorised)', async () => {
    await expect(token.connect(issuer).setAddressFrozen(bob.address, true)).to.be
      .reverted;
    await expect(token.connect(spvOperator).setAddressFrozen(bob.address, true)).to.be
      .reverted;
    expect(await token.isFrozen(bob.address)).to.equal(false);
  });
});
