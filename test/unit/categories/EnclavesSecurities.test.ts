import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../../helpers/fixture';
import { k, toBytes32 } from '../../helpers/utils';
import * as C from '../../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('EnclavesSecurities (category)', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesSecurities;

  before(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury] = await ethers.getSigners();

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
    await F.registerInvestors(ir, [issuer, spvOperator], C.COUNTRY.US, deployer);

    const base = F.biomassBaseParams({
      issuer,
      platformAgent,
      spvOperator,
      ir,
      compliance,
      staking,
      options: {
        trustClass: C.TRUST_CLASS.IV,
        name: 'Treasury Note 2030',
        symbol: 'TN30',
      },
    });
    base.contractKind = C.CONTRACT_KIND.SECURITIES;
    const securities = {
      securityType: k('BOND'),
      isinCode: toBytes32('US123456789'),
      custodianId: toBytes32('STATE_STREET'),
      maturityDate: 1893456000,
      couponRateBps: 425,
    };
    ({ token } = await F.deploySecuritiesToken({
      factory,
      impls,
      base,
      securities,
      salt: k('SEC_TEST'),
      from: deployer,
    }));
  });

  it('initializes security-specific fields', async () => {
    expect(await token.securityType()).to.equal(k('BOND'));
    expect(await token.isinCode()).to.equal(toBytes32('US123456789'));
    expect(await token.custodianId()).to.equal(toBytes32('STATE_STREET'));
    expect(await token.securityMaturityDate()).to.equal(1893456000n);
    expect(await token.couponRateBps()).to.equal(425n);
  });

  it('inherits base wiring (Class IV)', async () => {
    expect(await token.trustClass()).to.equal(BigInt(C.TRUST_CLASS.IV));
    expect(await token.contractKind()).to.equal(C.CONTRACT_KIND.SECURITIES);
  });
});
