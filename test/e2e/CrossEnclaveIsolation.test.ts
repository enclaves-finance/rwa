/**
 * E2E — Multi-Enclave deployment isolation.
 *
 * Two independent Enclaves share the same chain-wide globals (ENCL +
 * StakingBond + IdentityRegistry) but each operates its own factory,
 * compliance module, platform agent, SPV and admin. This proves
 * cross-tenant safety.
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toEth } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

const ENCLAVE_A = k('ENCLAVE_A_AFRICA');
const ENCLAVE_B = k('ENCLAVE_B_EUROPE');

async function buildEnclave({
  platformAgent,
  ir,
  staking,
  enclaveId,
  admin,
}: {
  platformAgent: HardhatEthersSigner;
  ir: F.MockIdentityRegistry;
  staking: F.StakingBond;
  enclaveId: string;
  admin: HardhatEthersSigner;
}): Promise<F.EnclaveHandles> {
  const EC = await ethers.getContractFactory('EnclavesCompliance', admin);
  const compliance = await EC.deploy(enclaveId, ir.target, platformAgent.address);
  await compliance.waitForDeployment();

  const EBF = await ethers.getContractFactory('EnclavesBiomass', admin);
  const biomassImpl = await EBF.deploy();
  await biomassImpl.waitForDeployment();

  const ERF = await ethers.getContractFactory('EnclavesRealEstate', admin);
  const realEstateImpl = await ERF.deploy();
  await realEstateImpl.waitForDeployment();

  const EPF = await ethers.getContractFactory('EnclavesPreciousMetals', admin);
  const preciousImpl = await EPF.deploy();
  await preciousImpl.waitForDeployment();

  const ESF = await ethers.getContractFactory('EnclavesSecurities', admin);
  const securitiesImpl = await ESF.deploy();
  await securitiesImpl.waitForDeployment();

  const ECoF = await ethers.getContractFactory('EnclavesCollectibles', admin);
  const collectiblesImpl = await ECoF.deploy();
  await collectiblesImpl.waitForDeployment();

  const ETF = await ethers.getContractFactory('EnclavesTokenFactory', admin);
  const factory = await ETF.deploy(
    enclaveId,
    ir.target,
    compliance.target,
    staking.target,
    platformAgent.address,
    admin.address
  );
  await factory.waitForDeployment();

  await factory
    .connect(admin)
    .registerImplementation(C.CONTRACT_KIND.BIOMASS, biomassImpl.target);
  await factory
    .connect(admin)
    .registerImplementation(C.CONTRACT_KIND.REAL_ESTATE, realEstateImpl.target);
  await factory
    .connect(admin)
    .registerImplementation(C.CONTRACT_KIND.PRECIOUS_METALS, preciousImpl.target);
  await factory
    .connect(admin)
    .registerImplementation(C.CONTRACT_KIND.SECURITIES, securitiesImpl.target);
  await factory
    .connect(admin)
    .registerImplementation(C.CONTRACT_KIND.COLLECTIBLES, collectiblesImpl.target);

  return {
    compliance,
    factory,
    impls: {
      biomass: biomassImpl,
      realEstate: realEstateImpl,
      preciousMetals: preciousImpl,
      securities: securitiesImpl,
      collectibles: collectiblesImpl,
    },
  };
}

describe('E2E — Cross-Enclave Isolation', () => {
  let deployer: HardhatEthersSigner;
  let platformAgentA: HardhatEthersSigner;
  let adminA: HardhatEthersSigner;
  let issuerA: HardhatEthersSigner;
  let spvA: HardhatEthersSigner;
  let platformAgentB: HardhatEthersSigner;
  let adminB: HardhatEthersSigner;
  let issuerB: HardhatEthersSigner;
  let spvB: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let A: F.EnclaveHandles;
  let B: F.EnclaveHandles;
  let tokenA: F.EnclavesBiomass;
  let tokenB: F.EnclavesBiomass;

  before(async () => {
    [
      deployer,
      platformAgentA,
      adminA,
      issuerA,
      spvA,
      platformAgentB,
      adminB,
      issuerB,
      spvB,
      treasury,
      alice,
      bob,
    ] = await ethers.getSigners();

    ({ encl, staking, ir } = await F.deployGlobals({
      deployer,
      treasury,
      slashReceiver: deployer,
    }));

    A = await buildEnclave({
      platformAgent: platformAgentA,
      ir,
      staking,
      enclaveId: ENCLAVE_A,
      admin: adminA,
    });
    B = await buildEnclave({
      platformAgent: platformAgentB,
      ir,
      staking,
      enclaveId: ENCLAVE_B,
      admin: adminB,
    });

    await F.registerInvestors(
      ir,
      [issuerA, spvA, issuerB, spvB, alice, bob],
      C.COUNTRY.NA,
      deployer
    );
  });

  it('Enclave A and Enclave B have distinct addresses for every component', async () => {
    expect(A.compliance.target).to.not.equal(B.compliance.target);
    expect(A.factory.target).to.not.equal(B.factory.target);
    expect(A.impls.biomass.target).to.not.equal(B.impls.biomass.target);
    expect(await A.factory.enclaveId()).to.equal(ENCLAVE_A);
    expect(await B.factory.enclaveId()).to.equal(ENCLAVE_B);
    expect(await A.compliance.platformAgent()).to.equal(platformAgentA.address);
    expect(await B.compliance.platformAgent()).to.equal(platformAgentB.address);
  });

  it('admin A has no privileges on Enclave B (factory)', async () => {
    await expect(
      B.factory
        .connect(adminA)
        .registerImplementation(C.CONTRACT_KIND.BIOMASS, A.impls.biomass.target)
    ).to.be.reverted;
  });

  it('platform agent A has no privileges on Enclave B (compliance)', async () => {
    await expect(
      B.compliance.connect(platformAgentA).setDefaultCountryAllowed(C.COUNTRY.NA, true)
    ).to.be.revertedWith('not platform');
  });

  it('deploys one biomass token in each enclave', async () => {
    const baseA = F.biomassBaseParams({
      issuer: issuerA,
      platformAgent: platformAgentA,
      spvOperator: spvA,
      ir,
      compliance: A.compliance,
      staking,
      options: {
        name: 'AfricaBio',
        symbol: 'ABIO',
        maxSupply: toEth('1000').toString(),
      },
    });
    baseA.enclaveId = ENCLAVE_A;
    ({ token: tokenA } = await F.deployBiomassToken({
      factory: A.factory,
      impls: A.impls,
      base: baseA,
      biomass: F.biomassParams(),
      salt: k('CROSS_A'),
      from: adminA,
    }));

    const baseB = F.biomassBaseParams({
      issuer: issuerB,
      platformAgent: platformAgentB,
      spvOperator: spvB,
      ir,
      compliance: B.compliance,
      staking,
      options: {
        name: 'EuropeBio',
        symbol: 'EBIO',
        maxSupply: toEth('1000').toString(),
      },
    });
    baseB.enclaveId = ENCLAVE_B;
    ({ token: tokenB } = await F.deployBiomassToken({
      factory: B.factory,
      impls: B.impls,
      base: baseB,
      biomass: F.biomassParams(),
      salt: k('CROSS_B'),
      from: adminB,
    }));

    expect(await tokenA.enclaveId()).to.equal(ENCLAVE_A);
    expect(await tokenB.enclaveId()).to.equal(ENCLAVE_B);
  });

  it('each factory only indexes its own token', async () => {
    expect(await A.factory.allTokensLength()).to.equal(1n);
    expect(await B.factory.allTokensLength()).to.equal(1n);
    expect(await A.factory.allTokens(0)).to.equal(tokenA.target);
    expect(await B.factory.allTokens(0)).to.equal(tokenB.target);
    const aFromB = await B.factory.tokenRegistry(tokenA.target);
    expect(aFromB.tokenAddress).to.equal(C.ZERO);
    const bFromA = await A.factory.tokenRegistry(tokenB.target);
    expect(bFromA.tokenAddress).to.equal(C.ZERO);
  });

  it('registering Token A with compliance B (or vice versa) requires B-admin', async () => {
    await expect(B.compliance.connect(adminA).registerToken(tokenA.target)).to.be
      .reverted;
  });

  it('drives token A to mint-ready and mints to alice (its only investor)', async () => {
    await A.compliance.connect(adminA).registerToken(tokenA.target);
    await A.compliance.connect(platformAgentA).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await A.compliance
      .connect(platformAgentA)
      .batchSetSpvApproval(
        tokenA.target,
        [alice.address, issuerA.address, spvA.address],
        true
      );
    await F.setAllMintConditions(tokenA as any, platformAgentA);
    await tokenA.connect(spvA).approveMint();
    await F.fundAndBond({
      encl,
      staking,
      treasury,
      staker: issuerA,
      token: tokenA,
      trustClass: C.TRUST_CLASS.V,
      assetValueUsd: 20_000_000,
    });
    await tokenA.connect(platformAgentA).mint(alice.address, toEth('1000'));
    expect(await tokenA.balanceOf(alice.address)).to.equal(toEth('1000'));
  });

  it('drives token B to mint-ready and mints to bob (its only investor)', async () => {
    await B.compliance.connect(adminB).registerToken(tokenB.target);
    await B.compliance.connect(platformAgentB).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await B.compliance
      .connect(platformAgentB)
      .batchSetSpvApproval(
        tokenB.target,
        [bob.address, issuerB.address, spvB.address],
        true
      );
    await F.setAllMintConditions(tokenB as any, platformAgentB);
    await tokenB.connect(spvB).approveMint();
    await F.fundAndBond({
      encl,
      staking,
      treasury,
      staker: issuerB,
      token: tokenB,
      trustClass: C.TRUST_CLASS.V,
      assetValueUsd: 20_000_000,
    });
    await tokenB.connect(platformAgentB).mint(bob.address, toEth('1000'));
    expect(await tokenB.balanceOf(bob.address)).to.equal(toEth('1000'));
  });

  it('investor count is tracked per token, not globally', async () => {
    expect(await tokenA.investorCount()).to.equal(1n);
    expect(await tokenB.investorCount()).to.equal(1n);
  });

  it('cross-enclave transfer is blocked: alice (A-approved) cannot receive token B', async () => {
    const res = await tokenB.preTransferCheck(bob.address, alice.address, toEth('1'));
    expect(res.code).to.equal(BigInt(C.REASON.COMPLIANCE_REJECTED));
    await expect(tokenB.connect(bob).transfer(alice.address, toEth('1'))).to.be.reverted;
  });

  it("Enclave A's seize cannot affect Enclave B tokens (different platform agents)", async () => {
    await expect(
      tokenB
        .connect(platformAgentA)
        .seize(bob.address, alice.address, toEth('1'), 'misuse')
    ).to.be.reverted;
  });

  it('suspending Enclave A token leaves Enclave B token tradable', async () => {
    await tokenA.connect(spvA).suspend();
    expect(await tokenA.assetState()).to.equal(BigInt(C.STATE.SUSPENDED));
    expect(await tokenB.paused()).to.equal(false);

    await ir
      .connect(deployer)
      .setProfile(issuerB.address, issuerB.address, C.COUNTRY.NA, true);
    await tokenB.connect(bob).transfer(issuerB.address, toEth('1'));
    expect(await tokenB.balanceOf(issuerB.address)).to.equal(toEth('1'));

    await tokenA.connect(spvA).resume();
  });

  it('StakingBond holds independent bonds per token regardless of enclave', async () => {
    expect(await staking.isBonded(tokenA.target)).to.equal(true);
    expect(await staking.isBonded(tokenB.target)).to.equal(true);

    const bondA = await staking.bonds(tokenA.target);
    const bondB = await staking.bonds(tokenB.target);
    expect(bondA.staker).to.equal(issuerA.address);
    expect(bondB.staker).to.equal(issuerB.address);
  });
});
