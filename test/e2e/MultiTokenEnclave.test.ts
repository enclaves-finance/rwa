/**
 * E2E — multiple tokens deployed under a single Enclave.
 *
 * Validates that the per-Enclave shared services (Factory + Compliance +
 * StakingBond) correctly isolate state across multiple deployed tokens.
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toBytes32, toEth, advanceTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('E2E — Multi-token Enclave', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let biomassIssuer: HardhatEthersSigner;
  let biomassSPV: HardhatEthersSigner;
  let realEstateIssuer: HardhatEthersSigner;
  let realEstateSPV: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  const BIOMASS_VALUE = 10_000_000;
  const REALESTATE_VALUE = 30_000_000;
  const BIOMASS_MAX = toEth('2000');
  const REALESTATE_MAX = toEth('3000');
  const COOLING = 30;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let biomassToken: F.EnclavesBiomass;
  let realEstateToken: F.EnclavesRealEstate;
  let biomassBond: bigint;
  let realEstateBond: bigint;

  before(async () => {
    [
      deployer,
      platformAgent,
      biomassIssuer,
      biomassSPV,
      realEstateIssuer,
      realEstateSPV,
      treasury,
      alice,
      bob,
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
      [biomassIssuer, biomassSPV, realEstateIssuer, realEstateSPV, alice, bob],
      C.COUNTRY.NA,
      deployer
    );
  });

  it('deploys two independent tokens under the same factory', async () => {
    const biomassBase = F.biomassBaseParams({
      issuer: biomassIssuer,
      platformAgent,
      spvOperator: biomassSPV,
      ir,
      compliance,
      staking,
      options: {
        maxSupply: BIOMASS_MAX.toString(),
        coolingPeriod: COOLING,
        initialValuation: BIOMASS_VALUE,
        name: 'Example Biomass',
        symbol: 'EBIO',
      },
    });
    ({ token: biomassToken } = await F.deployBiomassToken({
      factory,
      impls,
      base: biomassBase,
      biomass: F.biomassParams(),
      salt: k('MULTI_BIO'),
      from: deployer,
    }));

    const reBase = F.biomassBaseParams({
      issuer: realEstateIssuer,
      platformAgent,
      spvOperator: realEstateSPV,
      ir,
      compliance,
      staking,
      options: {
        trustClass: C.TRUST_CLASS.II,
        maxSupply: REALESTATE_MAX.toString(),
        coolingPeriod: COOLING,
        initialValuation: REALESTATE_VALUE,
        name: 'Berlin Tower',
        symbol: 'BTWR',
      },
    });
    reBase.contractKind = C.CONTRACT_KIND.REAL_ESTATE;
    reBase.jurisdiction = toBytes32('DE');
    ({ token: realEstateToken } = await F.deployRealEstateToken({
      factory,
      impls,
      base: reBase,
      realEstate: {
        propertyRegistryId: toBytes32('GRUNDBUCH_42'),
        propertyType: k('OFFICE'),
        totalAreaSqm: 25_000,
        rentalStatus: k('LEASED'),
      },
      salt: k('MULTI_RE'),
      from: deployer,
    }));

    expect(biomassToken.target).to.not.equal(realEstateToken.target);
  });

  it('factory registry indexes both tokens correctly', async () => {
    expect(await factory.allTokensLength()).to.equal(2n);
    const byKindBio = await factory.getTokensByContractKind(C.CONTRACT_KIND.BIOMASS);
    const byKindRE = await factory.getTokensByContractKind(C.CONTRACT_KIND.REAL_ESTATE);
    expect(byKindBio.length).to.equal(1);
    expect(byKindBio[0]).to.equal(biomassToken.target);
    expect(byKindRE.length).to.equal(1);
    expect(byKindRE[0]).to.equal(realEstateToken.target);

    const byIssuerBio = await factory.getTokensByIssuer(biomassIssuer.address);
    const byIssuerRE = await factory.getTokensByIssuer(realEstateIssuer.address);
    expect(byIssuerBio.length).to.equal(1);
    expect(byIssuerRE.length).to.equal(1);
    expect(byIssuerBio[0]).to.not.equal(byIssuerRE[0]);

    const bySPVBio = await factory.getTokensBySPV(biomassSPV.address);
    const bySPVRE = await factory.getTokensBySPV(realEstateSPV.address);
    expect(bySPVBio[0]).to.equal(biomassToken.target);
    expect(bySPVRE[0]).to.equal(realEstateToken.target);
  });

  it('compliance approvals are strictly per-token', async () => {
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance.connect(deployer).registerToken(biomassToken.target);
    await compliance.connect(deployer).registerToken(realEstateToken.target);

    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(
        biomassToken.target,
        [alice.address, biomassIssuer.address, biomassSPV.address],
        true
      );
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(
        realEstateToken.target,
        [bob.address, realEstateIssuer.address, realEstateSPV.address],
        true
      );

    expect(await compliance.spvApproved(biomassToken.target, alice.address)).to.equal(true);
    expect(await compliance.spvApproved(biomassToken.target, bob.address)).to.equal(false);
    expect(await compliance.spvApproved(realEstateToken.target, alice.address)).to.equal(
      false
    );
    expect(await compliance.spvApproved(realEstateToken.target, bob.address)).to.equal(
      true
    );
  });

  it('StakingBond holds independent bonds per token', async () => {
    biomassBond = await staking.getRequiredStake(C.TRUST_CLASS.V, BIOMASS_VALUE);
    expect(biomassBond).to.equal(toEth('6400000'));
    await encl.connect(treasury).transfer(biomassIssuer.address, biomassBond);
    await encl.connect(biomassIssuer).approve(staking.target, biomassBond);
    await staking
      .connect(biomassIssuer)
      .bond(biomassToken.target, biomassBond, C.TRUST_CLASS.V, BIOMASS_VALUE);

    realEstateBond = await staking.getRequiredStake(C.TRUST_CLASS.II, REALESTATE_VALUE);
    expect(realEstateBond).to.equal(toEth('4800000'));
    await encl.connect(treasury).transfer(realEstateIssuer.address, realEstateBond);
    await encl.connect(realEstateIssuer).approve(staking.target, realEstateBond);
    await staking
      .connect(realEstateIssuer)
      .bond(realEstateToken.target, realEstateBond, C.TRUST_CLASS.II, REALESTATE_VALUE);

    expect(await staking.isBonded(biomassToken.target)).to.equal(true);
    expect(await staking.isBonded(realEstateToken.target)).to.equal(true);

    const bioBond = await staking.bonds(biomassToken.target);
    const reBond = await staking.bonds(realEstateToken.target);
    expect(bioBond.staker).to.equal(biomassIssuer.address);
    expect(reBond.staker).to.equal(realEstateIssuer.address);
    expect(bioBond.amount).to.equal(biomassBond);
    expect(reBond.amount).to.equal(realEstateBond);
  });

  it('each token can be minted independently to its approved investors', async () => {
    await F.setAllMintConditions(biomassToken as any, platformAgent);
    await biomassToken.connect(biomassSPV).approveMint();
    await F.setAllMintConditions(realEstateToken as any, platformAgent);
    await realEstateToken.connect(realEstateSPV).approveMint();

    await advanceTime(COOLING + 1);

    await biomassToken.connect(platformAgent).mint(alice.address, BIOMASS_MAX);
    await realEstateToken.connect(platformAgent).mint(bob.address, REALESTATE_MAX);

    expect(await biomassToken.balanceOf(alice.address)).to.equal(BIOMASS_MAX);
    expect(await realEstateToken.balanceOf(bob.address)).to.equal(REALESTATE_MAX);

    expect(await biomassToken.balanceOf(bob.address)).to.equal(0n);
    expect(await realEstateToken.balanceOf(alice.address)).to.equal(0n);
  });

  it('a transfer rejected by one token does NOT block the other', async () => {
    const res = await biomassToken.preTransferCheck(alice.address, bob.address, toEth('1'));
    expect(res.code).to.equal(BigInt(C.REASON.COMPLIANCE_REJECTED));

    await expect(biomassToken.connect(alice).transfer(bob.address, toEth('1'))).to.be
      .reverted;

    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(realEstateToken.target, [alice.address], true);
    await realEstateToken.connect(bob).transfer(alice.address, toEth('100'));
    expect(await realEstateToken.balanceOf(alice.address)).to.equal(toEth('100'));
  });

  it('investor counts are independent per token', async () => {
    expect(await biomassToken.investorCount()).to.equal(1n);
    expect(await realEstateToken.investorCount()).to.equal(2n);
  });

  it('suspending one token leaves the other tradable', async () => {
    await biomassToken.connect(biomassSPV).suspend();
    expect(await biomassToken.assetState()).to.equal(BigInt(C.STATE.SUSPENDED));
    expect(await realEstateToken.paused()).to.equal(false);
    await realEstateToken.connect(bob).transfer(alice.address, toEth('100'));
    expect(await realEstateToken.balanceOf(alice.address)).to.equal(toEth('200'));

    await biomassToken.connect(biomassSPV).resume();
    expect(await biomassToken.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
  });

  it('unbonding from one token does NOT free the other bond', async () => {
    await biomassToken.connect(biomassSPV).initiateRedemption();
    await biomassToken.connect(biomassSPV).retire();

    await staking.connect(biomassIssuer).unbond(biomassToken.target);
    expect(await staking.isBonded(biomassToken.target)).to.equal(false);

    expect(await staking.isBonded(realEstateToken.target)).to.equal(true);
  });
});
