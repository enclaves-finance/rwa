import { ethers } from 'hardhat';
import { expect } from 'chai';

import { COUNTRY, ZERO } from '../helpers/constants';
import type { MockIdentityRegistry } from '../../typechain-types';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('MockIdentityRegistry', () => {
  let deployer: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let intruder: HardhatEthersSigner;
  let ir: MockIdentityRegistry;

  beforeEach(async () => {
    [deployer, alice, bob, intruder] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('MockIdentityRegistry', deployer);
    ir = await Factory.deploy();
    await ir.waitForDeployment();
  });

  it('starts with no profiles', async () => {
    expect(await ir.isVerified(alice.address)).to.equal(false);
    expect(await ir.identity(alice.address)).to.equal(ZERO);
    expect(await ir.investorCountry(alice.address)).to.equal(0n);
  });

  it('records a profile and returns it via every getter', async () => {
    await expect(
      ir.connect(deployer).setProfile(alice.address, bob.address, COUNTRY.DE, true)
    )
      .to.emit(ir, 'ProfileSet')
      .withArgs(alice.address, bob.address, COUNTRY.DE, true);

    expect(await ir.isVerified(alice.address)).to.equal(true);
    expect(await ir.identity(alice.address)).to.equal(bob.address);
    expect(await ir.investorCountry(alice.address)).to.equal(BigInt(COUNTRY.DE));
  });

  it('rejects setProfile from non-admin', async () => {
    await expect(
      ir.connect(intruder).setProfile(alice.address, alice.address, COUNTRY.US, true)
    ).to.be.revertedWith('not admin');
  });

  it('transfers admin', async () => {
    await ir.connect(deployer).setAdmin(alice.address);
    await expect(
      ir.connect(deployer).setProfile(bob.address, bob.address, COUNTRY.US, true)
    ).to.be.reverted;
    await ir.connect(alice).setProfile(bob.address, bob.address, COUNTRY.US, true);
    expect(await ir.isVerified(bob.address)).to.equal(true);
  });
});
