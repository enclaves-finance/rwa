import { ethers } from 'hardhat';
import { expect } from 'chai';

import * as F from '../../helpers/fixture';
import { k, toBytes32 } from '../../helpers/utils';
import * as C from '../../helpers/constants';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

describe('EnclavesBiomass (contractKind)', () => {
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
  let token: F.EnclavesBiomass;

  before(async () => {
    [deployer, platformAgent, issuer, spvOperator, treasury, alice] =
      await ethers.getSigners();
  });

  async function build(opts: { base?: F.InitParamOverrides; biomass?: F.InitParamOverrides } = {}) {
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
      options: opts.base || {},
    });
    const biomass = F.biomassParams(opts.biomass || {});
    ({ token } = await F.deployBiomassToken({
      factory,
      impls,
      base,
      biomass,
      salt: k(`BIOMASS_${Math.random()}`),
      from: deployer,
    }));
  }

  describe('initialization', () => {
    it('records every immutable biomass field', async () => {
      await build();
      expect(await token.landRegistryRef()).to.equal(toBytes32('EXAMPLE_LAND_REG'));
      expect(await token.totalHectares()).to.equal(20000n);
      expect(await token.hectaresPerToken()).to.equal(5n);
      expect(await token.biomassType()).to.equal(k('EXAMPLE_FEEDSTOCK'));
      expect(await token.certificationStandard()).to.equal(k('APPRAISAL'));
      expect(await token.countryCode()).to.equal(k('XX'));
      expect(await token.regionCode()).to.equal(k('EXAMPLE_REGION'));
      expect(await token.farmCount()).to.equal(3n);
    });

    it('stores every farm allocation', async () => {
      await build();
      const farms = await token.getFarms();
      expect(farms.length).to.equal(3);
      expect(farms[0].farmName).to.equal('Farm A');
      expect(farms[1].farmName).to.equal('Farm B');
      expect(farms[2].farmName).to.equal('Farm C');
      expect(farms[0].hectares).to.equal(5500n);
      expect(farms[1].hectares).to.equal(9500n);
      expect(farms[2].hectares).to.equal(5000n);
    });

    it('rejects mismatched farm-hectare totals', async () => {
      // build the stack first so factory + impls are populated
      await build();
      const base = F.biomassBaseParams({
        issuer,
        platformAgent,
        spvOperator,
        ir,
        compliance,
        staking,
      });
      const biomass = F.biomassParams({
        farms: [
          {
            farmId: toBytes32('A'),
            farmName: 'A',
            hectares: 10000,
            latitude: 0,
            longitude: 0,
            region: toBytes32('R'),
          },
          {
            farmId: toBytes32('B'),
            farmName: 'B',
            hectares: 9000,
            latitude: 0,
            longitude: 0,
            region: toBytes32('R'),
          },
        ],
      });
      await expect(
        F.deployBiomassToken({
          factory,
          impls,
          base,
          biomass,
          salt: k('BAD_HECTARES'),
          from: deployer,
        })
      ).to.be.revertedWith('farm hectares mismatch totalHectares');
    });

    it('records revenue rights window + rates', async () => {
      await build();
      expect(await token.revenueStartDate()).to.equal(1727740800n);
      expect(await token.revenueEndDate()).to.equal(1759190400n);
      expect(await token.biocharRatePerTon()).to.equal(4800n);
      expect(await token.woodVinegarRatePerLitre()).to.equal(96n);
      expect(await token.distributionFrequency()).to.equal(7776000n);
      expect(await token.minimumRaiseAmount()).to.equal(500000n);
    });
  });

  describe('production reports', () => {
    beforeEach(async () => build());

    it('platform submits a report and tracks the latest period', async () => {
      await expect(
        token
          .connect(platformAgent)
          .submitProductionReport(1, 100, 500, 4800 * 100 + 96 * 500, k('REPORT_Q1'))
      ).to.emit(token, 'ProductionReportSubmitted');
      expect(await token.latestProductionPeriod()).to.equal(1n);
      const r = await token.productionReports(1);
      expect(r.biocharTons).to.equal(100n);
      expect(r.woodVinegarLitres).to.equal(500n);
      expect(r.verified).to.equal(false);
    });

    it('platform verifies a previously submitted report', async () => {
      await token.connect(platformAgent).submitProductionReport(1, 1, 1, 1, k('R'));
      await expect(token.connect(platformAgent).verifyProductionReport(1)).to.emit(
        token,
        'ProductionReportVerified'
      );
      const r = await token.productionReports(1);
      expect(r.verified).to.equal(true);
    });

    it('rejects regression on period numbers', async () => {
      await token.connect(platformAgent).submitProductionReport(5, 1, 1, 1, k('R5'));
      await expect(
        token.connect(platformAgent).submitProductionReport(3, 1, 1, 1, k('R3'))
      ).to.be.revertedWith('period regress');
    });

    it('rejects verification of an unsubmitted report', async () => {
      await expect(
        token.connect(platformAgent).verifyProductionReport(7)
      ).to.be.revertedWith('no report');
    });

    it('only platform can submit / verify', async () => {
      await expect(
        token.connect(alice).submitProductionReport(1, 1, 1, 1, k('R'))
      ).to.be.reverted;
    });
  });

  describe('revenue rates + impact + minimum raise', () => {
    beforeEach(async () => build());

    it('platform updates revenue rates', async () => {
      await expect(token.connect(platformAgent).setRevenueRates(5000, 100)).to.emit(
        token,
        'RevenueRatesUpdated'
      );
      expect(await token.biocharRatePerTon()).to.equal(5000n);
      expect(await token.woodVinegarRatePerLitre()).to.equal(100n);
    });

    it('platform updates impact metrics', async () => {
      await expect(
        token.connect(platformAgent).updateImpactMetrics(100, 80, 50, k('IMPACT'))
      ).to.emit(token, 'ImpactMetricsUpdated');
      const i = await token.impact();
      expect(i.totalBushClearedTons).to.equal(100n);
      expect(i.totalCarbonRemovedTons).to.equal(80n);
      expect(i.totalHectaresRestored).to.equal(50n);
      expect(i.latestImpactReportHash).to.equal(k('IMPACT'));
    });

    it('platform flips the minimum-raise flag once', async () => {
      expect(await token.minimumRaiseMet()).to.equal(false);
      await expect(token.connect(platformAgent).setMinimumRaiseMet()).to.emit(
        token,
        'MinimumRaiseMet'
      );
      expect(await token.minimumRaiseMet()).to.equal(true);
    });
  });
});
