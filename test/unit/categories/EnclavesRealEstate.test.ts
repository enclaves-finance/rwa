import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../../helpers/fixture';
import { k, toBytes32 } from '../../helpers/utils';
import * as C from '../../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('EnclavesRealEstate (category)', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesRealEstate;

  before(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury, alice] =
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
    await F.registerInvestors(ir, [issuer, spvOperator, alice], C.COUNTRY.DE, deployer);

    const base = F.biomassBaseParams({
      issuer,
      platformAgent,
      spvOperator,
      ir,
      compliance,
      staking,
      options: {
        trustClass: C.TRUST_CLASS.II,
        name: 'Berlin Tower',
        symbol: 'BTOWER',
      },
    });
    base.contractKind = C.CONTRACT_KIND.REAL_ESTATE;
    base.jurisdiction = toBytes32('DE');
    const realEstate = {
      propertyRegistryId: toBytes32('GRUNDBUCH_BERLIN_123'),
      propertyType: k('OFFICE'),
      totalAreaSqm: 25_000,
      rentalStatus: k('LEASED'),
    };
    ({ token } = await F.deployRealEstateToken({
      factory,
      impls,
      base,
      realEstate,
      salt: k('RE_TEST'),
      from: deployer,
    }));
  });

  it('initializes the real-estate fields', async () => {
    expect(await token.propertyRegistryId()).to.equal(toBytes32('GRUNDBUCH_BERLIN_123'));
    expect(await token.propertyType()).to.equal(k('OFFICE'));
    expect(await token.totalAreaSqm()).to.equal(25000n);
    expect(await token.rentalStatus()).to.equal(k('LEASED'));
  });

  it('platform updates rental status', async () => {
    await expect(token.connect(platformAgent).setRentalStatus(k('VACANT'))).to.emit(
      token,
      'RentalStatusUpdated'
    );
    expect(await token.rentalStatus()).to.equal(k('VACANT'));
  });

  it('non-platform cannot update rental status', async () => {
    await expect(token.connect(alice).setRentalStatus(k('VACANT'))).to.be.reverted;
  });

  it('inherits the base lifecycle correctly', async () => {
    expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
    expect(await token.trustClass()).to.equal(BigInt(C.TRUST_CLASS.II));
  });
});
