import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toBytes32 } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('EnclavesTokenFactory', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let intruder: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let factory: F.EnclavesTokenFactory;
  let compliance: F.EnclavesCompliance;
  let impls: F.EnclaveImpls;

  beforeEach(async () => {
    [deployer, platformAgent, issuer, spvOperator, intruder] = await ethers.getSigners();

    ({ encl, staking, ir } = await F.deployGlobals({
      deployer,
      treasury: deployer,
      slashReceiver: deployer,
    }));
    ({ compliance, factory, impls } = await F.deployEnclave({
      deployer,
      platformAgent,
      ir,
      staking,
    }));
  });

  describe('construction', () => {
    it('binds the enclave wiring', async () => {
      expect(await factory.enclaveId()).to.equal(C.ENCLAVE_ID);
      expect(await factory.identityRegistry()).to.equal(ir.target);
      expect(await factory.compliance()).to.equal(compliance.target);
      expect(await factory.stakingBond()).to.equal(staking.target);
      expect(await factory.platformAgent()).to.equal(platformAgent.address);
    });

    it('grants DEFAULT_ADMIN + ADMIN + DEPLOYER roles to the admin', async () => {
      const ADMIN = await factory.ADMIN_ROLE();
      const DEPLOYER_ROLE = await factory.DEPLOYER_ROLE();
      const DEFAULT_ADMIN = await factory.DEFAULT_ADMIN_ROLE();
      expect(await factory.hasRole(DEFAULT_ADMIN, deployer.address)).to.equal(true);
      expect(await factory.hasRole(ADMIN, deployer.address)).to.equal(true);
      expect(await factory.hasRole(DEPLOYER_ROLE, deployer.address)).to.equal(true);
    });
  });

  describe('implementation registry', () => {
    it('admin registers + unregisters implementations', async () => {
      const oldImpl = await factory.implementations(C.CONTRACT_KIND.BIOMASS);
      expect(oldImpl).to.equal(impls.biomass.target);

      await expect(
        factory.connect(deployer).unregisterImplementation(C.CONTRACT_KIND.BIOMASS)
      ).to.emit(factory, 'ImplementationUnregistered');
      expect(await factory.implementations(C.CONTRACT_KIND.BIOMASS)).to.equal(C.ZERO);

      await factory
        .connect(deployer)
        .registerImplementation(C.CONTRACT_KIND.BIOMASS, impls.biomass.target);
      expect(await factory.implementations(C.CONTRACT_KIND.BIOMASS)).to.equal(
        impls.biomass.target
      );
    });

    it('non-admin cannot register', async () => {
      await expect(
        factory
          .connect(intruder)
          .registerImplementation(k('FAKE_CAT'), impls.biomass.target)
      ).to.be.reverted;
    });

    it('rejects zero-address implementation', async () => {
      await expect(
        factory.connect(deployer).registerImplementation(k('FAKE_CAT'), C.ZERO)
      ).to.be.revertedWith('bad impl');
    });
  });

  describe('wiring rotation', () => {
    it('admin rotates identityRegistry / compliance / stakingBond / platformAgent', async () => {
      await factory.connect(deployer).setIdentityRegistry(ir.target);
      await factory.connect(deployer).setCompliance(compliance.target);
      await factory.connect(deployer).setStakingBond(staking.target);
      await factory.connect(deployer).setPlatformAgent(platformAgent.address);
    });

    it('non-admin cannot rotate', async () => {
      await expect(factory.connect(intruder).setPlatformAgent(intruder.address)).to.be
        .reverted;
    });
  });

  describe('deploy()', () => {
    function buildBase() {
      return F.biomassBaseParams({
        issuer,
        platformAgent,
        spvOperator,
        ir,
        compliance,
        staking,
      });
    }

    it('clones the implementation, initializes it and emits TokenDeployed', async () => {
      const base = buildBase();
      const biomass = F.biomassParams();
      const initData = impls.biomass.interface.encodeFunctionData('initialize', [
        base as any,
        biomass as any,
      ]);
      const salt = k('SALT_1');

      const predicted = await factory.predictDeployment(C.CONTRACT_KIND.BIOMASS, salt);

      const tx = await factory.connect(deployer).deploy({
        contractKind: C.CONTRACT_KIND.BIOMASS,
        issuer: issuer.address,
        spvOperator: spvOperator.address,
        spvEntityId: base.spvEntityId as string,
        trustClass: base.trustClass as number,
        denominationCurrency: base.denominationCurrency as string,
        salt,
        initData,
      });

      const receipt = await tx.wait();
      if (!receipt) throw new Error('no receipt');
      let evArgs: any | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = factory.interface.parseLog({
            topics: [...log.topics],
            data: log.data,
          });
          if (parsed && parsed.name === 'TokenDeployed') {
            evArgs = parsed.args;
            break;
          }
        } catch {
          // skip
        }
      }
      expect(evArgs, 'TokenDeployed not emitted').to.not.equal(undefined);
      expect(evArgs!.token).to.equal(predicted);
      expect(evArgs!.enclaveId).to.equal(C.ENCLAVE_ID);
      expect(evArgs!.contractKind).to.equal(C.CONTRACT_KIND.BIOMASS);
      expect(evArgs!.issuer).to.equal(issuer.address);
      expect(evArgs!.spvOperator).to.equal(spvOperator.address);

      const tokenAddress = evArgs!.token as string;
      const rec = await factory.tokenRegistry(tokenAddress);
      expect(rec.tokenAddress).to.equal(tokenAddress);
      expect(rec.issuer).to.equal(issuer.address);
      expect(rec.spvOperator).to.equal(spvOperator.address);

      expect(await factory.allTokens(0)).to.equal(tokenAddress);
      expect(await factory.allTokensLength()).to.equal(1n);
      expect(await factory.getTokensByIssuer(issuer.address)).to.deep.equal([
        tokenAddress,
      ]);
      expect(await factory.getTokensBySPV(spvOperator.address)).to.deep.equal([
        tokenAddress,
      ]);
      expect(
        await factory.getTokensByContractKind(C.CONTRACT_KIND.BIOMASS)
      ).to.deep.equal([tokenAddress]);
    });

    it('reverts when category has no registered implementation', async () => {
      await expect(
        factory.connect(deployer).deploy({
          contractKind: k('UNREG_CAT'),
          issuer: issuer.address,
          spvOperator: spvOperator.address,
          spvEntityId: toBytes32('X'),
          trustClass: 1,
          denominationCurrency: k('USD'),
          salt: k('S'),
          initData: '0x',
        })
      ).to.be.revertedWith('no implementation');
    });

    it('bubbles up the initializer revert reason', async () => {
      const base = buildBase();
      base.platformAgent = C.ZERO;
      const biomass = F.biomassParams();
      const initData = impls.biomass.interface.encodeFunctionData('initialize', [
        base as any,
        biomass as any,
      ]);
      await expect(
        factory.connect(deployer).deploy({
          contractKind: C.CONTRACT_KIND.BIOMASS,
          issuer: issuer.address,
          spvOperator: spvOperator.address,
          spvEntityId: base.spvEntityId as string,
          trustClass: base.trustClass as number,
          denominationCurrency: base.denominationCurrency as string,
          salt: k('SALT_X'),
          initData,
        })
      ).to.be.reverted;
    });

    it('non-deployer cannot deploy', async () => {
      const base = buildBase();
      const initData = impls.biomass.interface.encodeFunctionData('initialize', [
        base as any,
        F.biomassParams() as any,
      ]);
      await expect(
        factory.connect(intruder).deploy({
          contractKind: C.CONTRACT_KIND.BIOMASS,
          issuer: issuer.address,
          spvOperator: spvOperator.address,
          spvEntityId: base.spvEntityId as string,
          trustClass: base.trustClass as number,
          denominationCurrency: base.denominationCurrency as string,
          salt: k('SALT_INTRUDER'),
          initData,
        })
      ).to.be.reverted;
    });

    it('predictDeployment returns the actually-deployed address', async () => {
      const base = buildBase();
      const biomass = F.biomassParams();
      const salt = k('PREDICT');

      const predicted = await factory.predictDeployment(C.CONTRACT_KIND.BIOMASS, salt);
      const { tokenAddress } = await F.deployBiomassToken({
        factory,
        impls,
        base,
        biomass,
        salt,
        from: deployer,
      });
      expect(tokenAddress).to.equal(predicted);
    });

    it('predictDeployment returns zero for unregistered category', async () => {
      expect(await factory.predictDeployment(k('UNREG'), k('S'))).to.equal(C.ZERO);
    });
  });
});
