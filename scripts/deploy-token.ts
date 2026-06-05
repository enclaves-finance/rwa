/**
 * scripts/deploy-token.ts
 *
 * Generic, env-driven token-clone deployment script. Supply a JSON config
 * (path passed via TOKEN_CONFIG) and this script will:
 *
 *   1. Locate the factory from FACTORY_ADDRESS (or read it from a
 *      deployments.json file via DEPLOYMENTS).
 *   2. Build the InitParams + contractKind-specific init blob.
 *   3. Call factory.deploy(...) with a deterministic salt.
 *   4. Append the new token's address (and metadata) into deployments.json
 *      so the platform / indexer can pick it up.
 *
 * Usage:
 *   TOKEN_CONFIG=scripts/examples/example-biomass.json \
 *   npx hardhat run scripts/deploy-token.ts --network sepolia
 *
 * Required env / args:
 *   - TOKEN_CONFIG               path to a JSON config (see examples/)
 *   - FACTORY_ADDRESS or         existing factory to deploy under
 *     DEPLOYMENTS                deployments.json path (the script reads
 *                                deployments[network].factory from it)
 *
 * Optional:
 *   - DEPLOYMENTS                deployments.json path (default ./deployments.json);
 *                                if set the script also APPENDS the new token.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ethers, network } from 'hardhat';

interface TokenCfg {
  issuer: string;
  platformAgent: string;
  spvOperator: string;
  enclaveId: string;
  jurisdiction: string;
  trustClass: number;
  contractKind?: string;
  category?: string;
  spvEntityId: string;
  spvJurisdiction: string;
  spvLegalStructure: string;
  spvRegistryId: string;
  maxSupply: string | number;
  coolingPeriod: number;
  initialValuationUsd: string | number;
  denominationCurrency?: string;
  valuationMethodology?: string;
  name: string;
  symbol: string;
  metadataURI?: string;
  salt: string;
  biomass?: BiomassCfg;
  realEstate?: RealEstateCfg;
}

interface BiomassCfg {
  landRegistryRef: string;
  totalHectares: number | string;
  hectaresPerToken: number | string;
  biomassType: string;
  certificationStandard: string;
  countryCode: string;
  regionCode: string;
  farms: Array<{
    farmId: string;
    farmName: string;
    hectares: number | string;
    latitude: number | string;
    longitude: number | string;
    region: string;
  }>;
  revenueStartDate: number | string;
  revenueEndDate: number | string;
  biocharRatePerTon: number | string;
  woodVinegarRatePerLitre: number | string;
  distributionFrequency: number | string;
  minimumRaiseAmount: number | string;
}

interface RealEstateCfg {
  propertyRegistryId: string;
  propertyType: string;
  totalAreaSqm: number | string;
  rentalStatus: string;
}

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();

  const k = (s: string): string => ethers.id(s);
  const toBytes32 = (s: string): string => ethers.encodeBytes32String(s);

  const IMPL_NAME_FOR: Record<string, string> = {
    BIOMASS: 'EnclavesBiomass',
    REAL_ESTATE: 'EnclavesRealEstate',
    PRECIOUS_METALS: 'EnclavesPreciousMetals',
    SECURITIES: 'EnclavesSecurities',
    COLLECTIBLES: 'EnclavesCollectibles',
  };

  function resolveImplAddress(kind: string): string | null {
    const cacheFile = path.join(
      __dirname,
      '..',
      '.deployments-cache',
      `${network.name}.json`
    );
    if (fs.existsSync(cacheFile)) {
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return cache.contracts[IMPL_NAME_FOR[kind]] ?? null;
    }
    if (process.env.DEPLOYMENTS && fs.existsSync(process.env.DEPLOYMENTS)) {
      const json = JSON.parse(fs.readFileSync(process.env.DEPLOYMENTS, 'utf8'));
      return (json.contracts && json.contracts[IMPL_NAME_FOR[kind]]) ?? null;
    }
    return null;
  }

  function resolveFactoryAddress(): string {
    if (process.env.FACTORY_ADDRESS) return process.env.FACTORY_ADDRESS;
    const file = process.env.DEPLOYMENTS;
    if (!file) {
      throw new Error(
        'Set FACTORY_ADDRESS or DEPLOYMENTS env var to locate the factory.'
      );
    }
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Support both the new layout (contracts.EnclavesTokenFactory) and the
    // legacy per-network entries (json[network].factory).
    const entry = json[network.name] || json[String(json.chainId)] || {};
    const fromLegacy = entry.factory;
    const fromExport = json.contracts && json.contracts.EnclavesTokenFactory;
    const found = fromLegacy || fromExport;
    if (!found) {
      throw new Error(`No factory address for network "${network.name}" in ${file}`);
    }
    return found;
  }

  function loadConfig(): TokenCfg {
    const file = process.env.TOKEN_CONFIG;
    if (!file) throw new Error('TOKEN_CONFIG env var is required (path to JSON).');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function buildBase(
    cfg: TokenCfg,
    wiring: { identityRegistry: string; compliance: string; stakingBond: string }
  ): Record<string, unknown> {
    return {
      issuer: cfg.issuer,
      platformAgent: cfg.platformAgent,
      spvOperator: cfg.spvOperator,
      // Canonical encoding: keccak256 of the upper-cased Enclave code. Must
      // equal the factory's immutable `enclaveId`.
      enclaveId: cfg.enclaveId.startsWith('0x')
        ? cfg.enclaveId
        : k(cfg.enclaveId.toUpperCase()),
      jurisdiction: toBytes32(cfg.jurisdiction),
      trustClass: cfg.trustClass,
      // `cfg.contractKind` is the upper-snake string (e.g. "BIOMASS") that
      // matches the factory's registered implementation key.
      contractKind: k((cfg.contractKind || cfg.category) as string),
      spvEntityId: toBytes32(cfg.spvEntityId),
      spvJurisdiction: toBytes32(cfg.spvJurisdiction),
      spvLegalStructure: toBytes32(cfg.spvLegalStructure),
      spvRegistryId: toBytes32(cfg.spvRegistryId),
      maxSupply: ethers.parseEther(String(cfg.maxSupply)).toString(),
      coolingPeriod: cfg.coolingPeriod,
      initialValuation: cfg.initialValuationUsd,
      denominationCurrency: k(cfg.denominationCurrency || 'USD'),
      valuationMethodology: k(cfg.valuationMethodology || 'APPRAISAL'),
      name: cfg.name,
      symbol: cfg.symbol,
      metadataURI: cfg.metadataURI || '',
      identityRegistry: wiring.identityRegistry,
      compliance: wiring.compliance,
      stakingBond: wiring.stakingBond,
    };
  }

  function buildContractInit(cfg: TokenCfg): Record<string, unknown> {
    const kind = cfg.contractKind || cfg.category;
    switch (kind) {
      case 'BIOMASS': {
        const b = cfg.biomass!;
        return {
          landRegistryRef: toBytes32(b.landRegistryRef),
          totalHectares: b.totalHectares,
          hectaresPerToken: b.hectaresPerToken,
          biomassType: k(b.biomassType),
          certificationStandard: k(b.certificationStandard),
          countryCode: k(b.countryCode),
          regionCode: k(b.regionCode),
          farms: b.farms.map((f) => ({
            farmId: toBytes32(f.farmId),
            farmName: f.farmName,
            hectares: f.hectares,
            latitude: f.latitude,
            longitude: f.longitude,
            region: toBytes32(f.region),
          })),
          revenueStartDate: b.revenueStartDate,
          revenueEndDate: b.revenueEndDate,
          biocharRatePerTon: b.biocharRatePerTon,
          woodVinegarRatePerLitre: b.woodVinegarRatePerLitre,
          distributionFrequency: b.distributionFrequency,
          minimumRaiseAmount: b.minimumRaiseAmount,
        };
      }
      case 'REAL_ESTATE': {
        const r = cfg.realEstate!;
        return {
          propertyRegistryId: toBytes32(r.propertyRegistryId),
          propertyType: k(r.propertyType),
          totalAreaSqm: r.totalAreaSqm,
          rentalStatus: k(r.rentalStatus),
        };
      }
      default:
        throw new Error(`Contract kind "${kind}" not yet wired into deploy-token.ts`);
    }
  }

  function appendDeployment(
    file: string,
    tokenAddress: string,
    cfg: TokenCfg
  ): void {
    const json = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : {};
    const entry = json[network.name] || (json[network.name] = {});
    entry.tokens = entry.tokens || [];
    entry.tokens.push({
      address: tokenAddress,
      name: cfg.name,
      symbol: cfg.symbol,
      contractKind: cfg.contractKind || cfg.category,
      salt: cfg.salt,
      deployedAt: new Date().toISOString(),
    });
    fs.writeFileSync(file, JSON.stringify(json, null, 2));
  }

  const cfg = loadConfig();
  const factoryAddress = resolveFactoryAddress();

  const factory = await ethers.getContractAt(
    'EnclavesTokenFactory',
    factoryAddress,
    signer
  );
  const wiring = {
    identityRegistry: await factory.identityRegistry(),
    compliance: await factory.compliance(),
    stakingBond: await factory.stakingBond(),
  };

  const kind = (cfg.contractKind || cfg.category) as string;
  const implName = IMPL_NAME_FOR[kind];
  if (!implName) throw new Error(`Unsupported contract kind: ${kind}`);
  const implAddress = resolveImplAddress(kind);
  if (!implAddress) {
    throw new Error(
      `Implementation contract for "${kind}" was not found. Run "npx hardhat run scripts/deploy.ts --network ${network.name}" first ` +
        `or point DEPLOYMENTS at a deployments/<network>.json that records the impls.`
    );
  }
  const impl = await ethers.getContractAt(implName, implAddress, signer);

  const base = buildBase(cfg, wiring);
  const contractInit = buildContractInit(cfg);
  const initData = impl.interface.encodeFunctionData('initialize', [
    base,
    contractInit,
  ]);

  const salt: string = cfg.salt.startsWith('0x') ? cfg.salt : k(cfg.salt);

  console.log(`Deploying ${cfg.name} (${cfg.symbol}) under ${factoryAddress}`);
  const tx = await factory.deploy({
    contractKind: base.contractKind as string,
    issuer: base.issuer as string,
    spvOperator: base.spvOperator as string,
    spvEntityId: base.spvEntityId as string,
    trustClass: base.trustClass as number,
    denominationCurrency: base.denominationCurrency as string,
    salt,
    initData,
  });
  const receipt = await tx.wait();
  if (!receipt) throw new Error('No deployment receipt returned');

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
      // skip non-factory logs
    }
  }
  if (!tokenAddress) throw new Error('TokenDeployed event not emitted');
  console.log(`  → ${cfg.symbol} deployed at ${tokenAddress}`);
  console.log(`     gasUsed: ${receipt.gasUsed.toString()}`);

  if (process.env.DEPLOYMENTS) {
    appendDeployment(process.env.DEPLOYMENTS, tokenAddress, cfg);
    console.log(`     recorded in ${process.env.DEPLOYMENTS}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
