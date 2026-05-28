import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../helpers/fixture';
import { k, toEth, advanceTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * Integration: bond / mint flow.
 *
 * Touches every contract on the mint authorization path simultaneously:
 *
 *   IdentityRegistry → EnclavesCompliance → EnclavesRWA → StakingBond → ENCL
 *
 * Confirms that *no* single role can bypass the gate, and that recovery
 * paths (slash + top-up + re-bond) restore the gate as expected.
 */

describe('Integration — bond / mint flow', () => {
  let deployer: HardhatEthersSigner;
  let platformAgent: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;
  let token: F.EnclavesBiomass;
  const ASSET_VALUE = 20_000_000;

  beforeEach(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury, alice, bob] =
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
    await F.registerInvestors(
      ir,
      [issuer, spvOperator, alice, bob],
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
      options: { coolingPeriod: 60, maxSupply: toEth('1000').toString() },
    });
    const biomass = F.biomassParams();
    ({ token } = await F.deployBiomassToken({
      factory,
      impls,
      base,
      biomass,
      salt: k('INT_BOND_MINT'),
      from: deployer,
    }));
    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(platformAgent).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance
      .connect(platformAgent)
      .batchSetSpvApproval(token.target, [alice.address, bob.address], true);
  });

  it('reverts mint until: conditions ∧ SPV-approval ∧ cooling-elapsed ∧ bond-funded', async () => {
    await expect(token.connect(platformAgent).mint(alice.address, 1)).to.be.reverted;

    await F.setAllMintConditions(token as any, platformAgent);
    expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));

    await token.connect(spvOperator).approveMint();
    expect(await token.assetState()).to.equal(BigInt(C.STATE.MINT_READY));
    expect(await token.isMintReady()).to.equal(false);

    await F.fundAndBond({
      encl,
      staking,
      treasury,
      staker: issuer,
      token,
      trustClass: C.TRUST_CLASS.V,
      assetValueUsd: ASSET_VALUE,
    });
    expect(await token.isMintReady()).to.equal(false);

    await advanceTime(70);
    expect(await token.isMintReady()).to.equal(true);

    await token.connect(platformAgent).mint(alice.address, toEth('100'));
    expect(await token.balanceOf(alice.address)).to.equal(toEth('100'));
  });

  it('slashing below required disables next mint until top-up', async () => {
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
    await advanceTime(70);

    await token.connect(platformAgent).mint(alice.address, toEth('100'));

    await staking.connect(deployer).slash(token.target, 1, 'oops');
    expect(await staking.isBonded(token.target)).to.equal(false);
    await expect(token.connect(platformAgent).mint(alice.address, toEth('100'))).to.be
      .reverted;

    await encl.connect(treasury).transfer(issuer.address, 1n);
    await encl.connect(issuer).approve(staking.target, 1n);
    await staking.connect(issuer).topUp(token.target, 1n);
    expect(await staking.isBonded(token.target)).to.equal(true);
    await token.connect(platformAgent).mint(alice.address, toEth('100'));
  });

  it('SPV revoking approval after MintReady but before mint stops the flow', async () => {
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
    await advanceTime(70);

    await token.connect(spvOperator).revokeMintApproval();
    expect(await token.assetState()).to.equal(BigInt(C.STATE.REGISTERED));
    await expect(token.connect(platformAgent).mint(alice.address, 1)).to.be.reverted;
  });

  it('cannot mint past maxSupply across multiple batches', async () => {
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
    await advanceTime(70);

    await token.connect(platformAgent).mint(alice.address, toEth('500'));
    await token.connect(platformAgent).mint(bob.address, toEth('400'));
    await expect(token.connect(platformAgent).mint(alice.address, toEth('200'))).to.be
      .reverted;

    await expect(
      token
        .connect(platformAgent)
        .batchMint([alice.address, bob.address], [toEth('60'), toEth('60')])
    ).to.be.reverted;
  });
});
