/**
 * E2E — drives the production deploy fixture end-to-end.
 *
 * `test/helpers/fixture.ts` is the single source of truth for how the
 * platform's contracts wire together — every other test depends on it,
 * and `scripts/deploy.ts` mirrors the same call sequence on a real
 * network. So if every assertion here passes, `npm run deploy:sepolia`
 * will produce a system that mints its first token without further
 * surgery.
 *
 * What we verify:
 *
 *   - All globals + per-enclave contracts come up.
 *   - Every category implementation is registered with the factory.
 *   - Every contract has a compiled artifact under `artifacts/` with a
 *     non-empty ABI + bytecode (the same set `export-addresses.ts`
 *     touches).
 *   - `verify-deployment.ts` invariants pass against the live wiring.
 *   - A token can be deployed via factory.deploy with the same encoding
 *     `scripts/deploy-token.ts` produces.
 *   - The deployed token clears the full mint gate and accepts a real
 *     mint.
 */

import { ethers } from 'hardhat';
import { expect } from 'chai';
import fs from 'fs';
import path from 'path';

import * as F from '../helpers/fixture';
import { k, toBytes32, toEth, advanceTime } from '../helpers/utils';
import * as C from '../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('E2E — DeploymentScriptIntegration', () => {
  let deployer: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let spvOperator: HardhatEthersSigner;
  let alice: HardhatEthersSigner;

  const SALT = k('DEPLOYMENT_SMOKE_TEST_TOKEN');

  let encl: F.ENCL;
  let staking: F.StakingBond;
  let ir: F.MockIdentityRegistry;
  let compliance: F.EnclavesCompliance;
  let factory: F.EnclavesTokenFactory;
  let impls: F.EnclaveImpls;

  before(async () => {
    [deployer, treasury, issuer, spvOperator, alice] = await ethers.getSigners();
    ({ encl, staking, ir } = await F.deployGlobals({
      deployer,
      treasury: deployer,
      slashReceiver: deployer,
    }));
    ({ compliance, factory, impls } = await F.deployEnclave({
      deployer,
      platformAgent: deployer,
      ir,
      staking,
    }));
  });

  it('deploy step 1 (globals) produced a working ENCL + StakingBond', async () => {
    expect(await encl.name()).to.equal('Enclaves');
    expect(await encl.symbol()).to.equal('ENCL');
    expect(await encl.decimals()).to.equal(18n);
    expect(await staking.enclToken()).to.equal(encl.target);
    expect(await staking.bondingRateBps(5)).to.equal(1600n);
    expect(await staking.enclPriceUsd()).to.not.equal(0n);
  });

  it('deploy step 2 (enclave) produced Compliance + Factory + every category impl', async () => {
    expect(await compliance.enclaveId()).to.not.equal('0x' + '00'.repeat(32));
    expect(await compliance.identityRegistry()).to.equal(ir.target);

    expect(await factory.identityRegistry()).to.equal(ir.target);
    expect(await factory.compliance()).to.equal(compliance.target);
    expect(await factory.stakingBond()).to.equal(staking.target);

    expect(await factory.implementations(C.CONTRACT_KIND.BIOMASS)).to.equal(
      impls.biomass.target
    );
    expect(await factory.implementations(C.CONTRACT_KIND.REAL_ESTATE)).to.equal(
      impls.realEstate.target
    );
    expect(await factory.implementations(C.CONTRACT_KIND.PRECIOUS_METALS)).to.equal(
      impls.preciousMetals.target
    );
    expect(await factory.implementations(C.CONTRACT_KIND.SECURITIES)).to.equal(
      impls.securities.target
    );
    expect(await factory.implementations(C.CONTRACT_KIND.COLLECTIBLES)).to.equal(
      impls.collectibles.target
    );
  });

  it('export-addresses can find every artifact under the Hardhat layout', async () => {
    const artifactsDir = path.join(__dirname, '..', '..', 'artifacts');

    function findArtifact(root: string, contractName: string): string | null {
      const stack: string[] = [root];
      while (stack.length) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_err) {
          continue;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === `${contractName}.sol`) {
              const candidate = path.join(full, `${contractName}.json`);
              if (fs.existsSync(candidate)) return candidate;
            }
            stack.push(full);
          }
        }
      }
      return null;
    }

    const names = [
      'ENCL',
      'StakingBond',
      'MockIdentityRegistry',
      'EnclavesCompliance',
      'EnclavesTokenFactory',
      'EnclavesBiomass',
      'EnclavesRealEstate',
      'EnclavesPreciousMetals',
      'EnclavesSecurities',
      'EnclavesCollectibles',
    ];

    for (const name of names) {
      const file = findArtifact(artifactsDir, name);
      expect(file, `missing artifact for ${name}`).to.not.equal(null);
      const json = JSON.parse(fs.readFileSync(file!, 'utf8'));
      expect(Array.isArray(json.abi) && json.abi.length > 0, `${name} has empty ABI`).to
        .equal(true);
      expect(json.bytecode && json.bytecode.length > 2, `${name} has no bytecode`).to
        .equal(true);
    }
  });

  it('verify-deployment invariants all pass', async () => {
    expect(await staking.enclToken()).to.equal(encl.target);
    expect(await staking.admin()).to.not.equal(C.ZERO);
    expect(await staking.slashReceiver()).to.not.equal(C.ZERO);
    expect(await staking.enclPriceUsd()).to.not.equal(0n);
    expect(await factory.compliance()).to.equal(compliance.target);
    expect(await factory.stakingBond()).to.equal(staking.target);
    expect(await compliance.identityRegistry()).to.equal(ir.target);
    expect(
      await factory.predictDeployment(C.CONTRACT_KIND.BIOMASS, k('SANITY_CHECK'))
    ).to.not.equal(C.ZERO);
  });

  it('factory.deploy with deploy-token-style encoding clones a new token', async () => {
    await ir.connect(deployer).setProfile(issuer.address, issuer.address, C.COUNTRY.NA, true);
    await ir
      .connect(deployer)
      .setProfile(spvOperator.address, spvOperator.address, C.COUNTRY.NA, true);
    await ir.connect(deployer).setProfile(alice.address, alice.address, C.COUNTRY.NA, true);

    const enclaveId = await factory.enclaveId();

    const base = {
      issuer: issuer.address,
      platformAgent: deployer.address,
      spvOperator: spvOperator.address,
      enclaveId,
      jurisdiction: toBytes32('SKN'),
      trustClass: C.TRUST_CLASS.V,
      contractKind: C.CONTRACT_KIND.BIOMASS,
      spvEntityId: toBytes32('DEPLOY_TEST_SPV'),
      spvJurisdiction: toBytes32('SKN'),
      spvLegalStructure: toBytes32('SPV_LLC'),
      spvRegistryId: toBytes32('REG_TEST'),
      maxSupply: toEth('100').toString(),
      coolingPeriod: 30,
      initialValuation: 1_000_000,
      denominationCurrency: k('USD'),
      valuationMethodology: k('APPRAISAL'),
      name: 'Deployment Smoke Token',
      symbol: 'DSMK',
      metadataURI: 'ipfs://Qm...',
      identityRegistry: ir.target,
      compliance: compliance.target,
      stakingBond: staking.target,
    };
    const biomass = {
      landRegistryRef: toBytes32('TEST_LAND'),
      totalHectares: 100,
      hectaresPerToken: 1,
      biomassType: k('TEST'),
      certificationStandard: k('TEST_CERT'),
      countryCode: k('NA'),
      regionCode: k('TEST'),
      farms: [
        {
          farmId: toBytes32('TEST_FARM'),
          farmName: 'Test Farm',
          hectares: 100,
          latitude: 0,
          longitude: 0,
          region: toBytes32('Test'),
        },
      ],
      revenueStartDate: Math.floor(Date.now() / 1000),
      revenueEndDate: Math.floor(Date.now() / 1000) + 365 * 86400,
      biocharRatePerTon: 1000,
      woodVinegarRatePerLitre: 100,
      distributionFrequency: 7776000,
      minimumRaiseAmount: 1000,
    };

    const initData = impls.biomass.interface.encodeFunctionData('initialize', [
      base as any,
      biomass as any,
    ]);

    const tx = await factory.connect(deployer).deploy({
      contractKind: C.CONTRACT_KIND.BIOMASS,
      issuer: issuer.address,
      spvOperator: spvOperator.address,
      spvEntityId: base.spvEntityId,
      trustClass: C.TRUST_CLASS.V,
      denominationCurrency: base.denominationCurrency,
      salt: SALT,
      initData,
    });

    const receipt = await tx.wait();
    if (!receipt) throw new Error('no receipt');
    let tokenAddress: string | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed && parsed.name === 'TokenDeployed') {
          tokenAddress = parsed.args.token as string;
          break;
        }
      } catch {
        // skip
      }
    }
    expect(tokenAddress, 'TokenDeployed event must fire').to.not.equal(undefined);
    expect(await factory.allTokensLength()).to.equal(1n);
    expect(await factory.allTokens(0)).to.equal(tokenAddress!);

    const predicted = await factory.predictDeployment(C.CONTRACT_KIND.BIOMASS, SALT);
    expect(predicted).to.equal(tokenAddress!);
  });

  it('the deployed token clears the full mint gate end-to-end', async () => {
    const tokenAddress = await factory.allTokens(0);
    const token = await ethers.getContractAt('EnclavesBiomass', tokenAddress);

    await compliance.connect(deployer).registerToken(token.target);
    await compliance.connect(deployer).setDefaultCountryAllowed(C.COUNTRY.NA, true);
    await compliance
      .connect(deployer)
      .batchSetSpvApproval(
        token.target,
        [alice.address, issuer.address, spvOperator.address],
        true
      );

    await token.connect(deployer).setMintCondition('verificationComplete', true);
    await token.connect(deployer).setMintCondition('spvActive', true);
    await token.connect(deployer).setMintCondition('noEncumbrances', true);
    await token.connect(deployer).setMintCondition('documentGatingSatisfied', true);
    await token.connect(spvOperator).approveMint();

    const required = await staking.getRequiredStake(C.TRUST_CLASS.V, 1_000_000);
    expect(required).to.equal(toEth('640000'));

    await encl.connect(deployer).transfer(issuer.address, required);
    await encl.connect(issuer).approve(staking.target, required);
    await staking
      .connect(issuer)
      .bond(token.target, required, C.TRUST_CLASS.V, 1_000_000);
    expect(await staking.isBonded(token.target)).to.equal(true);

    await advanceTime(31);
    expect(await token.isMintReady()).to.equal(true);

    await token.connect(deployer).mint(alice.address, toEth('100'));
    expect(await token.balanceOf(alice.address)).to.equal(toEth('100'));
    expect(await token.assetState()).to.equal(BigInt(C.STATE.ACTIVE));
  });
});
