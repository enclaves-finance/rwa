import { ethers } from 'hardhat';
import { expect } from 'chai';

import { toBytes32 } from '../helpers/utils';
import { ENCLAVE_ID, COUNTRY, COMPLIANCE_REASON, ZERO } from '../helpers/constants';
import type {
  MockIdentityRegistry,
  EnclavesCompliance,
  MockStablecoin,
} from '../../typechain-types';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * EnclavesCompliance unit tests.
 *
 * The compliance module exposes both an admin/configuration surface and a
 * read-only `preTransferCheck` consumed by every EnclavesRWA token on
 * transfer. We pretend an EOA is the "token" — calling `registerToken` —
 * to exercise the hooks without standing up a real EnclavesRWA.
 */

describe('EnclavesCompliance', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let fakeToken: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let carol: HardhatEthersSigner;
  let dave: HardhatEthersSigner;
  let intermediary: HardhatEthersSigner;
  let intruder: HardhatEthersSigner;

  let ir: MockIdentityRegistry;
  let compliance: EnclavesCompliance;
  let underlying: MockStablecoin;

  beforeEach(async () => {
    [
      deployer,
      platformAgent,
      fakeToken,
      alice,
      bob,
      carol,
      dave,
      intermediary,
      intruder,
    ] = await ethers.getSigners();

    const IR = await ethers.getContractFactory('MockIdentityRegistry', deployer);
    ir = await IR.deploy();
    await ir.waitForDeployment();

    const EC = await ethers.getContractFactory('EnclavesCompliance', deployer);
    compliance = await EC.deploy(ENCLAVE_ID, ir.target, platformAgent.address);
    await compliance.waitForDeployment();

    const MS = await ethers.getContractFactory('MockStablecoin', deployer);
    underlying = await MS.deploy('Token', 'TKN', 18);
    await underlying.waitForDeployment();
  });

  describe('construction', () => {
    it('binds the enclave id, identity registry and platform agent', async () => {
      expect(await compliance.enclaveId()).to.equal(ENCLAVE_ID);
      expect(await compliance.identityRegistry()).to.equal(ir.target);
      expect(await compliance.platformAgent()).to.equal(platformAgent.address);
    });

    it('rejects zero-address identity registry / platform agent', async () => {
      const EC = await ethers.getContractFactory('EnclavesCompliance', deployer);
      await expect(
        EC.deploy(ENCLAVE_ID, ZERO, platformAgent.address)
      ).to.be.revertedWith('bad ir');
      await expect(
        EC.deploy(ENCLAVE_ID, ir.target, ZERO)
      ).to.be.revertedWith('bad agent');
    });
  });

  describe('token registration', () => {
    it('owner registers / unregisters tokens; non-owner cannot', async () => {
      await expect(compliance.connect(intruder).registerToken(fakeToken.address)).to.be
        .reverted;

      await expect(compliance.connect(deployer).registerToken(fakeToken.address))
        .to.emit(compliance, 'TokenRegistered')
        .withArgs(fakeToken.address);
      expect(await compliance.registeredTokens(fakeToken.address)).to.equal(true);

      await expect(
        compliance.connect(deployer).unregisterToken(fakeToken.address)
      ).to.emit(compliance, 'TokenUnregistered');
      expect(await compliance.registeredTokens(fakeToken.address)).to.equal(false);
    });

    it('only registered token contracts can call transferred/created/destroyed', async () => {
      await expect(compliance.connect(alice).created(bob.address, 100)).to.be.reverted;
    });
  });

  describe('platform-agent rotation', () => {
    it('owner rotates the platform agent', async () => {
      await compliance.connect(deployer).setPlatformAgent(alice.address);
      await compliance.connect(alice).setDefaultCountryAllowed(COUNTRY.NA, true);
      await expect(
        compliance.connect(deployer).setDefaultCountryAllowed(COUNTRY.NA, true)
      ).to.be.revertedWith('not platform');
    });
  });

  describe('country rules', () => {
    it('default allow-list applies when no per-token override is set', async () => {
      await compliance
        .connect(platformAgent)
        .setDefaultCountryAllowed(COUNTRY.NA, true);
      expect(await compliance.countryAllowed(fakeToken.address, COUNTRY.NA)).to.equal(
        true
      );
      expect(await compliance.countryAllowed(fakeToken.address, COUNTRY.US)).to.equal(
        false
      );
    });

    it('per-token override beats the default', async () => {
      await compliance
        .connect(platformAgent)
        .setDefaultCountryAllowed(COUNTRY.NA, true);
      await compliance
        .connect(platformAgent)
        .setCountryAllowed(fakeToken.address, COUNTRY.NA, false);
      expect(await compliance.countryAllowed(fakeToken.address, COUNTRY.NA)).to.equal(
        false
      );
    });
  });

  describe('SPV approval', () => {
    it('individual + batch SPV approval', async () => {
      await compliance
        .connect(platformAgent)
        .setSpvApproval(fakeToken.address, alice.address, true);
      expect(
        await compliance.spvApproved(fakeToken.address, alice.address)
      ).to.equal(true);

      await compliance
        .connect(platformAgent)
        .batchSetSpvApproval(fakeToken.address, [bob.address, carol.address], true);
      expect(await compliance.spvApproved(fakeToken.address, bob.address)).to.equal(
        true
      );
      expect(await compliance.spvApproved(fakeToken.address, carol.address)).to.equal(
        true
      );
    });

    it('non-platform cannot SPV-approve', async () => {
      await expect(
        compliance
          .connect(intruder)
          .setSpvApproval(fakeToken.address, alice.address, true)
      ).to.be.revertedWith('not platform');
    });
  });

  describe('intermediaries', () => {
    it('registers + grants per-token approval', async () => {
      await expect(
        compliance
          .connect(platformAgent)
          .registerIntermediary(intermediary.address, false, toBytes32('SECURITIZE'))
      ).to.emit(compliance, 'IntermediaryRegistered');

      await compliance
        .connect(platformAgent)
        .setIntermediaryTokenApproval(intermediary.address, fakeToken.address, true);
      expect(
        await compliance.intermediaryTokenApproval(
          intermediary.address,
          fakeToken.address
        )
      ).to.equal(true);
    });

    it('cannot approve token for a deactivated intermediary', async () => {
      await compliance
        .connect(platformAgent)
        .registerIntermediary(intermediary.address, false, toBytes32('X'));
      await compliance
        .connect(platformAgent)
        .deactivateIntermediary(intermediary.address);
      await expect(
        compliance
          .connect(platformAgent)
          .setIntermediaryTokenApproval(intermediary.address, fakeToken.address, true)
      ).to.be.revertedWith('intermediary inactive');
    });
  });

  describe('preTransferCheck', () => {
    beforeEach(async () => {
      await ir
        .connect(deployer)
        .setProfile(alice.address, alice.address, COUNTRY.NA, true);
      await ir
        .connect(deployer)
        .setProfile(bob.address, bob.address, COUNTRY.NA, true);
      await ir
        .connect(deployer)
        .setProfile(carol.address, carol.address, COUNTRY.DE, true);
      await ir
        .connect(deployer)
        .setProfile(dave.address, dave.address, COUNTRY.US, true);

      await compliance
        .connect(platformAgent)
        .batchSetSpvApproval(
          underlying.target,
          [alice.address, bob.address, carol.address, dave.address],
          true
        );

      await compliance
        .connect(platformAgent)
        .setDefaultCountryAllowed(COUNTRY.NA, true);
      await compliance
        .connect(platformAgent)
        .setDefaultCountryAllowed(COUNTRY.DE, true);
    });

    it('returns OK when all rules are satisfied', async () => {
      const res = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        1,
        underlying.target
      );
      expect(res.code).to.equal(0n);
      expect(res.reason).to.equal('ok');
    });

    it('rejects when sender not SPV-approved', async () => {
      const MS = await ethers.getContractFactory('MockStablecoin', deployer);
      const fresh = await MS.deploy('Other', 'OTH', 18);
      await fresh.waitForDeployment();
      await compliance
        .connect(platformAgent)
        .setSpvApproval(fresh.target, bob.address, true);
      const res = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        1,
        fresh.target
      );
      expect(res.code).to.equal(BigInt(COMPLIANCE_REASON.SENDER_NOT_APPROVED));
    });

    it('rejects when recipient not SPV-approved', async () => {
      const MS = await ethers.getContractFactory('MockStablecoin', deployer);
      const fresh = await MS.deploy('Other', 'OTH', 18);
      await fresh.waitForDeployment();
      await compliance
        .connect(platformAgent)
        .setSpvApproval(fresh.target, alice.address, true);
      const res = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        1,
        fresh.target
      );
      expect(res.code).to.equal(BigInt(COMPLIANCE_REASON.RECIPIENT_NOT_APPROVED));
    });

    it('rejects when destination country is not allowed', async () => {
      const res = await compliance.preTransferCheck(
        alice.address,
        dave.address,
        1,
        underlying.target
      );
      expect(res.code).to.equal(BigInt(COMPLIANCE_REASON.COUNTRY_NOT_ALLOWED));
    });

    it('enforces minimum transfer amount', async () => {
      await compliance
        .connect(platformAgent)
        .setMinTransferAmount(underlying.target, 100);
      const tooSmall = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        50,
        underlying.target
      );
      expect(tooSmall.code).to.equal(BigInt(COMPLIANCE_REASON.BELOW_MIN));
      const ok = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        100,
        underlying.target
      );
      expect(ok.code).to.equal(0n);
    });

    it('enforces maxBalancePerHolder concentration cap', async () => {
      await compliance
        .connect(platformAgent)
        .setMaxBalancePerHolder(underlying.target, 100);
      await underlying.connect(deployer).mint(bob.address, 80);
      const reject = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        50,
        underlying.target
      );
      expect(reject.code).to.equal(BigInt(COMPLIANCE_REASON.EXCEEDS_MAX_BALANCE));

      const accept = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        20,
        underlying.target
      );
      expect(accept.code).to.equal(0n);
    });

    it('enforces holder cap per country (only for new holders)', async () => {
      await compliance.connect(deployer).registerToken(underlying.target);
      await compliance
        .connect(platformAgent)
        .setMaxHoldersPerCountry(underlying.target, COUNTRY.NA, 1);

      const baseline = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        1,
        underlying.target
      );
      expect(baseline.code).to.equal(0n);

      await compliance
        .connect(platformAgent)
        .setMaxHoldersPerCountry(underlying.target, COUNTRY.NA, 0);
      const noCap = await compliance.preTransferCheck(
        alice.address,
        bob.address,
        1,
        underlying.target
      );
      expect(noCap.code).to.equal(0n);
    });

    it('canTransfer mirrors preTransferCheck code==0', async () => {
      expect(
        await compliance.canTransfer(alice.address, bob.address, 1, underlying.target)
      ).to.equal(true);
      expect(
        await compliance.canTransfer(alice.address, dave.address, 1, underlying.target)
      ).to.equal(false);
    });
  });

  describe('investor counting', () => {
    it('increments on first mint, decrements when balance reaches zero', async () => {
      const CC = await ethers.getContractFactory('ComplianceCaller', deployer);
      const tokenMock = await CC.deploy(compliance.target);
      await tokenMock.waitForDeployment();

      await compliance.connect(deployer).registerToken(tokenMock.target);

      await ir
        .connect(deployer)
        .setProfile(alice.address, alice.address, COUNTRY.NA, true);
      await ir
        .connect(deployer)
        .setProfile(bob.address, bob.address, COUNTRY.DE, true);

      await tokenMock.created(alice.address, 100);
      expect(await compliance.totalInvestorCount(tokenMock.target)).to.equal(1n);
      expect(
        await compliance.holderCountByCountry(tokenMock.target, COUNTRY.NA)
      ).to.equal(1n);

      await tokenMock.created(bob.address, 100);
      expect(await compliance.totalInvestorCount(tokenMock.target)).to.equal(2n);
      expect(
        await compliance.holderCountByCountry(tokenMock.target, COUNTRY.DE)
      ).to.equal(1n);

      await tokenMock.setBalance(alice.address, 0);
      await tokenMock.destroyed(alice.address, 100);
      expect(await compliance.totalInvestorCount(tokenMock.target)).to.equal(1n);
      expect(
        await compliance.holderCountByCountry(tokenMock.target, COUNTRY.NA)
      ).to.equal(0n);
    });
  });
});
