import { ethers } from 'hardhat';
import { expect } from 'chai';

import { toEth } from '../helpers/utils';
import { TRUST_CLASS, STATE, ENCL_PRICE_USD, ENCL_TOTAL_SUPPLY } from '../helpers/constants';
import type { ENCL, StakingBond, MockRWAState } from '../../typechain-types';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * StakingBond unit tests.
 *
 * Some tests need an EnclavesRWA-like contract that exposes `assetState()`
 * so the `unbond` path can pretend the token is Retired. Rather than
 * instantiate a real RWA (which requires the whole compliance stack),
 * we use a tiny mock — `MockRWAState` — registered via the
 * `contracts/mocks/` directory.
 */

describe('StakingBond', () => {
  let deployer: HardhatEthersSigner;
  let slasher: HardhatEthersSigner;
  let staker: HardhatEthersSigner;
  let intruder: HardhatEthersSigner;

  let encl: ENCL;
  let staking: StakingBond;

  beforeEach(async () => {
    [deployer, slasher, staker, intruder] = await ethers.getSigners();

    const ENCLF = await ethers.getContractFactory('ENCL', deployer);
    encl = await ENCLF.deploy(deployer.address, toEth(ENCL_TOTAL_SUPPLY));
    await encl.waitForDeployment();

    const SBF = await ethers.getContractFactory('StakingBond', deployer);
    staking = await SBF.deploy(
      encl.target,
      deployer.address,
      slasher.address,
      ENCL_PRICE_USD
    );
    await staking.waitForDeployment();
  });

  describe('configuration', () => {
    it('seeds the six default trust-class bonding rates', async () => {
      expect(await staking.bondingRateBps(1)).to.equal(150n);
      expect(await staking.bondingRateBps(2)).to.equal(400n);
      expect(await staking.bondingRateBps(3)).to.equal(700n);
      expect(await staking.bondingRateBps(4)).to.equal(1000n);
      expect(await staking.bondingRateBps(5)).to.equal(1600n);
      expect(await staking.bondingRateBps(6)).to.equal(2000n);
    });

    it('admin can overwrite a class rate', async () => {
      await staking.connect(deployer).setBondingRate(3, 500);
      expect(await staking.bondingRateBps(3)).to.equal(500n);
    });

    it('non-admin cannot set bonding rates or price', async () => {
      await expect(
        staking.connect(intruder).setBondingRate(3, 500)
      ).to.be.revertedWith('not admin');
      await expect(
        staking.connect(intruder).setEnclPrice(toEth('1'))
      ).to.be.revertedWith('not admin');
    });

    it('only owner can rotate admin / slash receiver', async () => {
      await expect(staking.connect(intruder).setAdmin(intruder.address)).to.be.reverted;
      await staking.connect(deployer).setAdmin(staker.address);
      await staking.connect(staker).setBondingRate(1, 200);
    });
  });

  describe('required-stake math', () => {
    it('matches the spec for Class V on $20M', async () => {
      const required = await staking.getRequiredStake(TRUST_CLASS.V, 20_000_000);
      expect(required).to.equal(toEth('12800000'));
    });

    it('scales with the bonding rate for every class', async () => {
      expect(await staking.getRequiredStake(TRUST_CLASS.I, 10_000_000)).to.equal(
        toEth('600000')
      );
      expect(await staking.getRequiredStake(TRUST_CLASS.II, 10_000_000)).to.equal(
        toEth('1600000')
      );
      expect(await staking.getRequiredStake(TRUST_CLASS.III, 10_000_000)).to.equal(
        toEth('2800000')
      );
      expect(await staking.getRequiredStake(TRUST_CLASS.VI, 10_000_000)).to.equal(
        toEth('8000000')
      );
    });

    it('responds to price changes', async () => {
      await staking.connect(deployer).setEnclPrice(BigInt(ENCL_PRICE_USD) / 2n);
      const r = await staking.getRequiredStake(TRUST_CLASS.V, 20_000_000);
      expect(r).to.equal(toEth('25600000'));
    });

    it('reverts on an unknown trust class', async () => {
      await expect(staking.getRequiredStake(9, 1000)).to.be.revertedWith(
        'unknown trust class'
      );
    });
  });

  describe('bond / topUp / unbond', () => {
    let token: MockRWAState;
    const ASSET_VALUE = 1_000_000;

    beforeEach(async () => {
      const MF = await ethers.getContractFactory('MockRWAState', deployer);
      token = await MF.deploy();
      await token.waitForDeployment();

      const required = await staking.getRequiredStake(TRUST_CLASS.V, ASSET_VALUE);
      await encl.connect(deployer).transfer(staker.address, required);
      await encl.connect(staker).approve(staking.target, required);
    });

    it('bonds exactly the required amount and reports isBonded()', async () => {
      const required = await staking.getRequiredStake(TRUST_CLASS.V, ASSET_VALUE);
      await expect(
        staking.connect(staker).bond(token.target, required, TRUST_CLASS.V, ASSET_VALUE)
      ).to.emit(staking, 'Bonded');
      expect(await staking.isBonded(token.target)).to.equal(true);

      const b = await staking.bonds(token.target);
      expect(b.staker).to.equal(staker.address);
      expect(b.amount).to.equal(required);
      expect(b.required).to.equal(required);
      expect(b.active).to.equal(true);
      expect(b.trustClass).to.equal(BigInt(TRUST_CLASS.V));
      expect(b.assetValueAtBond).to.equal(BigInt(ASSET_VALUE));
    });

    it('rejects bond amount below required', async () => {
      const required = await staking.getRequiredStake(TRUST_CLASS.V, ASSET_VALUE);
      const tooLittle = required - 1n;
      await expect(
        staking.connect(staker).bond(token.target, tooLittle, TRUST_CLASS.V, ASSET_VALUE)
      ).to.be.revertedWith('insufficient amount');
    });

    it('refuses double-bond for the same token', async () => {
      const required = await staking.getRequiredStake(TRUST_CLASS.V, ASSET_VALUE);
      await staking
        .connect(staker)
        .bond(token.target, required, TRUST_CLASS.V, ASSET_VALUE);
      await expect(
        staking.connect(staker).bond(token.target, required, TRUST_CLASS.V, ASSET_VALUE)
      ).to.be.reverted;
    });

    it('topUp grows the bond', async () => {
      const required = await staking.getRequiredStake(TRUST_CLASS.V, ASSET_VALUE);
      await staking
        .connect(staker)
        .bond(token.target, required, TRUST_CLASS.V, ASSET_VALUE);

      const extra = toEth('100');
      await encl.connect(deployer).transfer(staker.address, extra);
      await encl.connect(staker).approve(staking.target, extra);
      await staking.connect(staker).topUp(token.target, extra);

      const b = await staking.bonds(token.target);
      expect(b.amount).to.equal(required + extra);
    });

    it('unbond requires the token to be Retired', async () => {
      const required = await staking.getRequiredStake(TRUST_CLASS.V, ASSET_VALUE);
      await staking
        .connect(staker)
        .bond(token.target, required, TRUST_CLASS.V, ASSET_VALUE);

      await expect(staking.connect(staker).unbond(token.target)).to.be.revertedWith(
        'not retired'
      );
      await token.setState(STATE.RETIRED);
      await staking.connect(staker).unbond(token.target);
      expect(await staking.isBonded(token.target)).to.equal(false);
      expect(await encl.balanceOf(staker.address)).to.equal(required);
    });

    it('only the original staker can unbond', async () => {
      const required = await staking.getRequiredStake(TRUST_CLASS.V, ASSET_VALUE);
      await staking
        .connect(staker)
        .bond(token.target, required, TRUST_CLASS.V, ASSET_VALUE);
      await token.setState(STATE.RETIRED);

      await expect(staking.connect(intruder).unbond(token.target)).to.be.revertedWith(
        'not staker'
      );
    });
  });

  describe('slashing', () => {
    let token: MockRWAState;
    const ASSET_VALUE = 1_000_000;
    let required: bigint;

    beforeEach(async () => {
      const MF = await ethers.getContractFactory('MockRWAState', deployer);
      token = await MF.deploy();
      await token.waitForDeployment();

      required = await staking.getRequiredStake(TRUST_CLASS.V, ASSET_VALUE);
      await encl.connect(deployer).transfer(staker.address, required);
      await encl.connect(staker).approve(staking.target, required);
      await staking
        .connect(staker)
        .bond(token.target, required, TRUST_CLASS.V, ASSET_VALUE);
    });

    it('admin slashes partial → still bonded when buffer remains', async () => {
      const extra = toEth('2');
      await encl.connect(deployer).transfer(staker.address, extra);
      await encl.connect(staker).approve(staking.target, extra);
      await staking.connect(staker).topUp(token.target, extra);

      const slashAmount = toEth('1');
      const before = await encl.balanceOf(slasher.address);
      await expect(
        staking.connect(deployer).slash(token.target, slashAmount, 'misbehavior')
      ).to.emit(staking, 'Slashed');
      const after = await encl.balanceOf(slasher.address);
      expect(after - before).to.equal(slashAmount);
      expect(await staking.isBonded(token.target)).to.equal(true);
    });

    it('slashing below required disables isBonded()', async () => {
      await staking.connect(deployer).slash(token.target, toEth('1'), 'bad');
      expect(await staking.isBonded(token.target)).to.equal(false);
    });

    it('rejects slash > bond', async () => {
      await expect(
        staking.connect(deployer).slash(token.target, required + 1n, 'too much')
      ).to.be.revertedWith('exceeds bond');
    });

    it('non-admin cannot slash', async () => {
      await expect(
        staking.connect(intruder).slash(token.target, toEth('1'), 'oops')
      ).to.be.revertedWith('not admin');
    });
  });
});
