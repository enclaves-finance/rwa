import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toEth, toUSDC } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('RedemptionEscrow', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let intruder: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesBiomass;
  let stable: F.MockStablecoin;
  let escrow: F.RedemptionEscrow;

  beforeEach(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury, alice, intruder] =
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

    await F.registerInvestors(ir, [issuer, spvOperator, alice], C.COUNTRY.NA, deployer);

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
      salt: k('ESCROW_TEST'),
      from: deployer,
    }));

    stable = await F.deployStablecoin({ deployer });
    escrow = await F.deployRedemptionEscrow({
      deployer,
      platformAgent,
      token,
      paymentToken: stable,
      owner: deployer,
    });
  });

  it('binds the RWA, payment token and platform agent', async () => {
    expect(await escrow.rwa()).to.equal(token.target);
    expect(await escrow.paymentToken()).to.equal(stable.target);
    expect(await escrow.platformAgent()).to.equal(platformAgent.address);
  });

  it('pre-approves the RWA for unlimited transfers', async () => {
    const allowance = await stable.allowance(escrow.target, token.target);
    expect(allowance).to.equal(ethers.MaxUint256);
  });

  describe('fund', () => {
    it('platform funds the escrow', async () => {
      await stable.connect(deployer).mint(platformAgent.address, toUSDC('1000'));
      await stable.connect(platformAgent).approve(escrow.target, toUSDC('1000'));
      await expect(escrow.connect(platformAgent).fund(toUSDC('1000'))).to.emit(
        escrow,
        'Funded'
      );
      expect(await stable.balanceOf(escrow.target)).to.equal(toUSDC('1000'));
      expect(await escrow.availableFunds()).to.equal(toUSDC('1000'));
    });

    it('non-platform cannot fund', async () => {
      await stable.connect(deployer).mint(intruder.address, toUSDC('100'));
      await stable.connect(intruder).approve(escrow.target, toUSDC('100'));
      await expect(
        escrow.connect(intruder).fund(toUSDC('100'))
      ).to.be.revertedWith('not platform');
    });
  });

  describe('owner controls', () => {
    it('owner rotates the platform agent', async () => {
      await escrow.connect(deployer).setPlatformAgent(alice.address);
      expect(await escrow.platformAgent()).to.equal(alice.address);
    });

    it('non-owner cannot rotate', async () => {
      await expect(escrow.connect(intruder).setPlatformAgent(alice.address)).to.be
        .reverted;
    });

    it('owner can refresh approval', async () => {
      await expect(escrow.connect(deployer).refreshApproval()).to.emit(
        escrow,
        'ApprovalRefreshed'
      );
    });
  });
});
