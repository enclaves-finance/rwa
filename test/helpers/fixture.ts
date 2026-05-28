/**
 * Deployment fixtures used by every test tier.
 *
 *   deployGlobals()   → ENCL + StakingBond + MockIdentityRegistry
 *   deployEnclave()   → Compliance + all category implementations + Factory
 *   deployBiomassToken(...)
 *   deployRealEstateToken(...)
 *   deploySecuritiesToken(...)
 *
 * The fixtures intentionally mirror the production deploy order so that
 * any drift between tests and `scripts/deploy.ts` is impossible.
 */

import { ethers } from 'hardhat';
import type { ContractTransactionResponse } from 'ethers';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

import { k, toBytes32, toEth, toUSDC } from './utils';
import * as C from './constants';

import type {
  ENCL,
  StakingBond,
  MockIdentityRegistry,
  MockStablecoin,
  EnclavesCompliance,
  EnclavesTokenFactory,
  EnclavesBiomass,
  EnclavesRealEstate,
  EnclavesPreciousMetals,
  EnclavesSecurities,
  EnclavesCollectibles,
  YieldDistributor,
  RedemptionEscrow,
} from '../../typechain-types';

// Re-export the contract types so test files can `import type { ENCL }
// from '../helpers/fixture'` rather than reaching into typechain-types
// across every relative-path boundary.
export type {
  ENCL,
  StakingBond,
  MockIdentityRegistry,
  MockStablecoin,
  EnclavesCompliance,
  EnclavesTokenFactory,
  EnclavesBiomass,
  EnclavesRealEstate,
  EnclavesPreciousMetals,
  EnclavesSecurities,
  EnclavesCollectibles,
  YieldDistributor,
  RedemptionEscrow,
};

export interface GlobalsHandles {
  encl: ENCL;
  staking: StakingBond;
  ir: MockIdentityRegistry;
  totalSupply: bigint;
}

export async function deployGlobals({
  deployer,
  treasury,
  slashReceiver,
}: {
  deployer: HardhatEthersSigner;
  treasury: HardhatEthersSigner;
  slashReceiver: HardhatEthersSigner;
}): Promise<GlobalsHandles> {
  const totalSupply = toEth(C.ENCL_TOTAL_SUPPLY);
  const ENCL = await ethers.getContractFactory('ENCL', deployer);
  const encl = await ENCL.deploy(treasury.address, totalSupply);
  await encl.waitForDeployment();

  const StakingBond = await ethers.getContractFactory('StakingBond', deployer);
  const staking = await StakingBond.deploy(
    await encl.getAddress(),
    deployer.address,
    slashReceiver.address,
    C.ENCL_PRICE_USD
  );
  await staking.waitForDeployment();

  const MockIdentityRegistry = await ethers.getContractFactory(
    'MockIdentityRegistry',
    deployer
  );
  const ir = await MockIdentityRegistry.deploy();
  await ir.waitForDeployment();

  return { encl, staking, ir, totalSupply };
}

export interface EnclaveImpls {
  biomass: EnclavesBiomass;
  realEstate: EnclavesRealEstate;
  preciousMetals: EnclavesPreciousMetals;
  securities: EnclavesSecurities;
  collectibles: EnclavesCollectibles;
}

export interface EnclaveHandles {
  compliance: EnclavesCompliance;
  factory: EnclavesTokenFactory;
  impls: EnclaveImpls;
}

export async function deployEnclave({
  deployer,
  platformAgent,
  ir,
  staking,
}: {
  deployer: HardhatEthersSigner;
  platformAgent: HardhatEthersSigner;
  ir: MockIdentityRegistry;
  staking: StakingBond;
}): Promise<EnclaveHandles> {
  const ECF = await ethers.getContractFactory('EnclavesCompliance', deployer);
  const compliance = await ECF.deploy(
    C.ENCLAVE_ID,
    await ir.getAddress(),
    platformAgent.address
  );
  await compliance.waitForDeployment();

  const EBF = await ethers.getContractFactory('EnclavesBiomass', deployer);
  const biomassImpl = await EBF.deploy();
  await biomassImpl.waitForDeployment();

  const ERF = await ethers.getContractFactory('EnclavesRealEstate', deployer);
  const realEstateImpl = await ERF.deploy();
  await realEstateImpl.waitForDeployment();

  const EPF = await ethers.getContractFactory('EnclavesPreciousMetals', deployer);
  const preciousImpl = await EPF.deploy();
  await preciousImpl.waitForDeployment();

  const ESF = await ethers.getContractFactory('EnclavesSecurities', deployer);
  const securitiesImpl = await ESF.deploy();
  await securitiesImpl.waitForDeployment();

  const ECoF = await ethers.getContractFactory('EnclavesCollectibles', deployer);
  const collectiblesImpl = await ECoF.deploy();
  await collectiblesImpl.waitForDeployment();

  const ETF = await ethers.getContractFactory('EnclavesTokenFactory', deployer);
  const factory = await ETF.deploy(
    C.ENCLAVE_ID,
    await ir.getAddress(),
    await compliance.getAddress(),
    await staking.getAddress(),
    platformAgent.address,
    deployer.address
  );
  await factory.waitForDeployment();

  await factory.registerImplementation(
    C.CONTRACT_KIND.BIOMASS,
    await biomassImpl.getAddress()
  );
  await factory.registerImplementation(
    C.CONTRACT_KIND.REAL_ESTATE,
    await realEstateImpl.getAddress()
  );
  await factory.registerImplementation(
    C.CONTRACT_KIND.PRECIOUS_METALS,
    await preciousImpl.getAddress()
  );
  await factory.registerImplementation(
    C.CONTRACT_KIND.SECURITIES,
    await securitiesImpl.getAddress()
  );
  await factory.registerImplementation(
    C.CONTRACT_KIND.COLLECTIBLES,
    await collectiblesImpl.getAddress()
  );

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

export async function registerInvestors(
  ir: MockIdentityRegistry,
  wallets: Array<HardhatEthersSigner | { address: string }>,
  country: number,
  deployer: HardhatEthersSigner
): Promise<void> {
  for (const wallet of wallets) {
    // The ONCHAINID is impersonated by the wallet itself for test purposes.
    await ir
      .connect(deployer)
      .setProfile(wallet.address, wallet.address, country, true);
  }
}

// The "base" / category-specific init parameter blobs the factory accepts
// are loose by design — the contracts validate them on-chain and a typed
// mirror would have to track every field across category extensions. We
// keep them as record-shaped values so tests can spread / override fields
// freely; the factory's ABI catches any shape drift at deploy time.
export type InitParamOverrides = Record<string, unknown>;
export type InitParams = Record<string, unknown>;

export function biomassBaseParams({
  issuer,
  platformAgent,
  spvOperator,
  ir,
  compliance,
  staking,
  options = {},
}: {
  issuer: HardhatEthersSigner;
  platformAgent: HardhatEthersSigner;
  spvOperator: HardhatEthersSigner;
  ir: MockIdentityRegistry;
  compliance: EnclavesCompliance;
  staking: StakingBond;
  options?: InitParamOverrides;
}): InitParams {
  const o = options as Record<string, any>;
  return {
    issuer: issuer.address,
    platformAgent: platformAgent.address,
    spvOperator: spvOperator.address,
    enclaveId: C.ENCLAVE_ID,
    jurisdiction: toBytes32('SKN'),
    trustClass: o.trustClass ?? C.TRUST_CLASS.V,
    contractKind: C.CONTRACT_KIND.BIOMASS,
    spvEntityId: toBytes32('EXAMPLE_BIOMASS_SPV'),
    spvJurisdiction: toBytes32('SKN'),
    spvLegalStructure: toBytes32('SPV_LLC'),
    spvRegistryId: toBytes32('REG_EXAMPLE_001'),
    maxSupply: o.maxSupply ?? 4000,
    coolingPeriod: o.coolingPeriod ?? 0,
    initialValuation: o.initialValuation ?? 20_000_000,
    denominationCurrency: k('USD'),
    valuationMethodology: k('APPRAISAL'),
    name: o.name ?? 'Example Biomass Rights',
    symbol: o.symbol ?? 'EBIO',
    metadataURI: o.metadataURI ?? 'ipfs://Qm...',
    identityRegistry: ir.target,
    compliance: compliance.target,
    stakingBond: staking.target,
  };
}

export function biomassParams(opts: InitParamOverrides = {}): InitParams {
  const o = opts as Record<string, any>;
  return {
    landRegistryRef: toBytes32('EXAMPLE_LAND_REG'),
    totalHectares: o.totalHectares ?? 20000,
    hectaresPerToken: o.hectaresPerToken ?? 5,
    biomassType: k('EXAMPLE_FEEDSTOCK'),
    certificationStandard: k('APPRAISAL'),
    countryCode: k('XX'),
    regionCode: k('EXAMPLE_REGION'),
    farms: o.farms ?? [
      {
        farmId: toBytes32('FARM_A'),
        farmName: 'Farm A',
        hectares: 5500,
        latitude: 0,
        longitude: 0,
        region: toBytes32('Example Region'),
      },
      {
        farmId: toBytes32('FARM_B'),
        farmName: 'Farm B',
        hectares: 9500,
        latitude: 0,
        longitude: 0,
        region: toBytes32('Example Region'),
      },
      {
        farmId: toBytes32('FARM_C'),
        farmName: 'Farm C',
        hectares: 5000,
        latitude: 0,
        longitude: 0,
        region: toBytes32('Example Region'),
      },
    ],
    revenueStartDate: o.revenueStartDate ?? 1727740800,
    revenueEndDate: o.revenueEndDate ?? 1759190400,
    biocharRatePerTon: o.biocharRatePerTon ?? 4800,
    woodVinegarRatePerLitre: o.woodVinegarRatePerLitre ?? 96,
    distributionFrequency: o.distributionFrequency ?? 7776000,
    minimumRaiseAmount: o.minimumRaiseAmount ?? 500000,
  };
}

export interface DeployedToken<T> {
  tokenAddress: string;
  tx: ContractTransactionResponse;
  token: T;
}

// Resolve the address of the token deployed by a factory.deploy(...)
// transaction by parsing the TokenDeployed event from its receipt.
async function tokenAddressFromTx(
  tx: ContractTransactionResponse,
  factory: EnclavesTokenFactory
): Promise<string> {
  const receipt = await tx.wait();
  if (!receipt) throw new Error('tx receipt missing');
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (parsed && parsed.name === 'TokenDeployed') {
        return parsed.args.token as string;
      }
    } catch {
      // Logs from other contracts (proxies, init events) don't parse —
      // skip them.
    }
  }
  throw new Error('TokenDeployed event not emitted');
}

export async function deployBiomassToken({
  factory,
  impls,
  base,
  biomass,
  salt,
  from,
}: {
  factory: EnclavesTokenFactory;
  impls: Pick<EnclaveImpls, 'biomass'>;
  base: InitParams;
  biomass: InitParams;
  salt?: string;
  from: HardhatEthersSigner;
}): Promise<DeployedToken<EnclavesBiomass>> {
  const initData = impls.biomass.interface.encodeFunctionData('initialize', [
    base as any,
    biomass as any,
  ]);
  const tx = await factory.connect(from).deploy({
    contractKind: C.CONTRACT_KIND.BIOMASS,
    issuer: base.issuer as string,
    spvOperator: base.spvOperator as string,
    spvEntityId: base.spvEntityId as string,
    trustClass: base.trustClass as number,
    denominationCurrency: base.denominationCurrency as string,
    salt: salt ?? k('TEST_BIOMASS_SALT'),
    initData,
  });
  const tokenAddress = await tokenAddressFromTx(tx, factory);
  const token = await ethers.getContractAt('EnclavesBiomass', tokenAddress);
  return { tokenAddress, tx, token };
}

export async function deployRealEstateToken({
  factory,
  impls,
  base,
  realEstate,
  salt,
  from,
}: {
  factory: EnclavesTokenFactory;
  impls: Pick<EnclaveImpls, 'realEstate'>;
  base: InitParams;
  realEstate: InitParams;
  salt?: string;
  from: HardhatEthersSigner;
}): Promise<DeployedToken<EnclavesRealEstate>> {
  const initData = impls.realEstate.interface.encodeFunctionData('initialize', [
    base as any,
    realEstate as any,
  ]);
  const tx = await factory.connect(from).deploy({
    contractKind: C.CONTRACT_KIND.REAL_ESTATE,
    issuer: base.issuer as string,
    spvOperator: base.spvOperator as string,
    spvEntityId: base.spvEntityId as string,
    trustClass: base.trustClass as number,
    denominationCurrency: base.denominationCurrency as string,
    salt: salt ?? k('TEST_RE_SALT'),
    initData,
  });
  const tokenAddress = await tokenAddressFromTx(tx, factory);
  const token = await ethers.getContractAt('EnclavesRealEstate', tokenAddress);
  return { tokenAddress, tx, token };
}

export async function deploySecuritiesToken({
  factory,
  impls,
  base,
  securities,
  salt,
  from,
}: {
  factory: EnclavesTokenFactory;
  impls: Pick<EnclaveImpls, 'securities'>;
  base: InitParams;
  securities: InitParams;
  salt?: string;
  from: HardhatEthersSigner;
}): Promise<DeployedToken<EnclavesSecurities>> {
  const initData = impls.securities.interface.encodeFunctionData('initialize', [
    base as any,
    securities as any,
  ]);
  const tx = await factory.connect(from).deploy({
    contractKind: C.CONTRACT_KIND.SECURITIES,
    issuer: base.issuer as string,
    spvOperator: base.spvOperator as string,
    spvEntityId: base.spvEntityId as string,
    trustClass: base.trustClass as number,
    denominationCurrency: base.denominationCurrency as string,
    salt: salt ?? k('TEST_SEC_SALT'),
    initData,
  });
  const tokenAddress = await tokenAddressFromTx(tx, factory);
  const token = await ethers.getContractAt('EnclavesSecurities', tokenAddress);
  return { tokenAddress, tx, token };
}

// Structural subtype for the mint-condition surface — any category
// contract that inherits from EnclavesRWA exposes this method.
export interface MintConditionToken {
  setMintCondition(
    name: string,
    value: boolean,
    overrides?: { from?: never }
  ): Promise<ContractTransactionResponse>;
  connect(signer: HardhatEthersSigner): MintConditionToken;
}

export async function setAllMintConditions(
  token: MintConditionToken,
  platformAgent: HardhatEthersSigner
): Promise<void> {
  const t = token.connect(platformAgent);
  await t.setMintCondition('verificationComplete', true);
  await t.setMintCondition('spvActive', true);
  await t.setMintCondition('noEncumbrances', true);
  await t.setMintCondition('documentGatingSatisfied', true);
}

export interface AddressedToken {
  getAddress(): Promise<string>;
  target: string | bigint | { toString(): string };
}

export async function fundAndBond({
  encl,
  staking,
  treasury,
  staker,
  token,
  trustClass,
  assetValueUsd,
}: {
  encl: ENCL;
  staking: StakingBond;
  treasury: HardhatEthersSigner;
  staker: HardhatEthersSigner;
  token: AddressedToken;
  trustClass: number;
  assetValueUsd: number | string | bigint;
}): Promise<bigint> {
  const required = await staking.getRequiredStake(trustClass, assetValueUsd);
  await encl.connect(treasury).transfer(staker.address, required);
  await encl.connect(staker).approve(await staking.getAddress(), required);
  await staking
    .connect(staker)
    .bond(await token.getAddress(), required, trustClass, assetValueUsd);
  return required;
}

export async function deployStablecoin({
  deployer,
  name = 'USD Coin',
  symbol = 'USDC',
  decimals = 6,
}: {
  deployer: HardhatEthersSigner;
  name?: string;
  symbol?: string;
  decimals?: number;
}): Promise<MockStablecoin> {
  const Factory = await ethers.getContractFactory('MockStablecoin', deployer);
  const stable = await Factory.deploy(name, symbol, decimals);
  await stable.waitForDeployment();
  return stable;
}

export async function deployYieldDistributor({
  deployer,
  platformAgent,
  token,
  owner,
}: {
  deployer: HardhatEthersSigner;
  platformAgent: HardhatEthersSigner;
  token: AddressedToken;
  owner: HardhatEthersSigner;
}): Promise<YieldDistributor> {
  const Factory = await ethers.getContractFactory('YieldDistributor', deployer);
  const yd = await Factory.deploy(
    await token.getAddress(),
    platformAgent.address,
    owner.address
  );
  await yd.waitForDeployment();
  return yd;
}

export async function deployRedemptionEscrow({
  deployer,
  platformAgent,
  token,
  paymentToken,
  owner,
}: {
  deployer: HardhatEthersSigner;
  platformAgent: HardhatEthersSigner;
  token: AddressedToken;
  paymentToken: AddressedToken;
  owner: HardhatEthersSigner;
}): Promise<RedemptionEscrow> {
  const Factory = await ethers.getContractFactory('RedemptionEscrow', deployer);
  const escrow = await Factory.deploy(
    await token.getAddress(),
    await paymentToken.getAddress(),
    platformAgent.address,
    owner.address
  );
  await escrow.waitForDeployment();
  return escrow;
}

export { k, toBytes32, toEth, toUSDC };
