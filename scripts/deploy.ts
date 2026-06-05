/**
 * Deploys the full Enclaves RWA stack on whatever network Hardhat is
 * pointed at.
 *
 *   npx hardhat run scripts/deploy.ts --network <network>
 *
 * Step 1 — globals:
 *   - ENCL   (skipped if ENCL_ADDRESS is set; ENCL lives in @enclaves/encl)
 *   - StakingBond
 *
 * Step 2 — per-Enclave:
 *   - MockIdentityRegistry  (skipped if IR_ADDRESS is set)
 *   - EnclavesCompliance
 *   - Category implementations (Biomass, RealEstate, PreciousMetals,
 *     Securities, Collectibles)
 *   - EnclavesTokenFactory + implementation registration
 *
 * Addresses are cached to `.deployments-cache/<network>.json` so the
 * follow-up verify-deployment.ts / export-addresses.ts scripts can find
 * the contracts without redeploying.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ethers, network } from 'hardhat';

/**
 * Canonical Enclave code for this deployment. The on-chain `enclaveId`
 * is `keccak256(toUtf8Bytes(ENCLAVE_CODE.toUpperCase()))`; downstream
 * callers (off-chain backends, indexers, the platform UI) MUST use the
 * exact same hashing convention when referencing the Enclave on chain.
 *
 * For multi-Enclave deployments, pass `ENCLAVE_CODE` per run:
 *   ENCLAVE_CODE=difc-default npx hardhat run scripts/deploy.ts --network ...
 */
const ENCLAVE_CODE = (process.env.ENCLAVE_CODE || 'ENCLAVE_DEFAULT').toUpperCase();

async function main(): Promise<void> {
  const k = (s: string): string => ethers.id(s);
  const ENCLAVE_ID = k(ENCLAVE_CODE);

  const CONTRACT_KINDS = {
    BIOMASS: k('BIOMASS'),
    REAL_ESTATE: k('REAL_ESTATE'),
    PRECIOUS_METALS: k('PRECIOUS_METALS'),
    SECURITIES: k('SECURITIES'),
    COLLECTIBLES: k('COLLECTIBLES'),
  };

  const [deployer] = await ethers.getSigners();
  const deployerAccount = deployer.address;

  const treasury = process.env.ENCL_TREASURY || deployerAccount;
  const slashReceiver = process.env.ENCL_SLASH_RECEIVER || deployerAccount;
  const enclPriceUsd = process.env.ENCL_PRICE_USD || '250000000000000000'; // $0.25
  const enclAddressOverride = process.env.ENCL_ADDRESS;
  const platformAgent = process.env.PLATFORM_AGENT || deployerAccount;

  console.log(`\n=== Deploying Enclaves RWA on "${network.name}" ===`);
  console.log(`  deployer       : ${deployerAccount}`);
  console.log(`  enclaveCode    : ${ENCLAVE_CODE}`);
  console.log(`  enclaveId      : ${ENCLAVE_ID}\n`);

  // ---- 1. Globals ---------------------------------------------------------
  let enclAddress: string;
  if (enclAddressOverride) {
    enclAddress = enclAddressOverride;
    console.log(`  ENCL bound to existing deployment at ${enclAddress}`);
  } else {
    const initialSupply = ethers.parseEther('1000000000'); // 1B ENCL
    const ENCLFactory = await ethers.getContractFactory('ENCL', deployer);
    const encl = await ENCLFactory.deploy(treasury, initialSupply);
    await encl.waitForDeployment();
    enclAddress = await encl.getAddress();
    console.log(`  ENCL deployed at ${enclAddress} (dev convenience deploy)`);
  }

  const SBFactory = await ethers.getContractFactory('StakingBond', deployer);
  const stakingBond = await SBFactory.deploy(
    enclAddress,
    deployerAccount,
    slashReceiver,
    enclPriceUsd
  );
  await stakingBond.waitForDeployment();
  const stakingBondAddress = await stakingBond.getAddress();
  console.log(`  StakingBond deployed at ${stakingBondAddress}`);

  // ---- 2. Identity registry ----------------------------------------------
  let identityRegistryAddress: string;
  if (process.env.IR_ADDRESS) {
    identityRegistryAddress = process.env.IR_ADDRESS;
  } else {
    const IRFactory = await ethers.getContractFactory('MockIdentityRegistry', deployer);
    const ir = await IRFactory.deploy();
    await ir.waitForDeployment();
    identityRegistryAddress = await ir.getAddress();
    console.log(`  MockIdentityRegistry deployed at ${identityRegistryAddress}`);
  }

  // ---- 3. Compliance + factory + category implementations ----------------
  const ECFactory = await ethers.getContractFactory('EnclavesCompliance', deployer);
  const compliance = await ECFactory.deploy(
    ENCLAVE_ID,
    identityRegistryAddress,
    platformAgent
  );
  await compliance.waitForDeployment();
  const complianceAddress = await compliance.getAddress();
  console.log(`  EnclavesCompliance deployed at ${complianceAddress}`);

  async function deployImpl(name: string): Promise<{ name: string; address: string }> {
    const F = await ethers.getContractFactory(name, deployer);
    const impl = await F.deploy();
    await impl.waitForDeployment();
    return { name, address: await impl.getAddress() };
  }

  const biomassImpl = await deployImpl('EnclavesBiomass');
  const realEstateImpl = await deployImpl('EnclavesRealEstate');
  const preciousImpl = await deployImpl('EnclavesPreciousMetals');
  const securitiesImpl = await deployImpl('EnclavesSecurities');
  const collectiblesImpl = await deployImpl('EnclavesCollectibles');
  console.log(`  Category implementations deployed`);

  const ETFFactory = await ethers.getContractFactory('EnclavesTokenFactory', deployer);
  const factory = await ETFFactory.deploy(
    ENCLAVE_ID,
    identityRegistryAddress,
    complianceAddress,
    stakingBondAddress,
    platformAgent,
    deployerAccount
  );
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`  EnclavesTokenFactory deployed at ${factoryAddress}`);

  await factory.registerImplementation(CONTRACT_KINDS.BIOMASS, biomassImpl.address);
  await factory.registerImplementation(CONTRACT_KINDS.REAL_ESTATE, realEstateImpl.address);
  await factory.registerImplementation(
    CONTRACT_KINDS.PRECIOUS_METALS,
    preciousImpl.address
  );
  await factory.registerImplementation(CONTRACT_KINDS.SECURITIES, securitiesImpl.address);
  await factory.registerImplementation(
    CONTRACT_KINDS.COLLECTIBLES,
    collectiblesImpl.address
  );

  // ---- 4. Cache addresses for follow-up scripts --------------------------
  const { chainId } = await ethers.provider.getNetwork();
  const cache = {
    network: network.name,
    chainId: Number(chainId),
    enclaveCode: ENCLAVE_CODE,
    enclaveId: ENCLAVE_ID,
    contracts: {
      ENCL: enclAddress,
      StakingBond: stakingBondAddress,
      MockIdentityRegistry: identityRegistryAddress,
      EnclavesCompliance: complianceAddress,
      EnclavesTokenFactory: factoryAddress,
      EnclavesBiomass: biomassImpl.address,
      EnclavesRealEstate: realEstateImpl.address,
      EnclavesPreciousMetals: preciousImpl.address,
      EnclavesSecurities: securitiesImpl.address,
      EnclavesCollectibles: collectiblesImpl.address,
    },
  };

  const cacheDir = path.join(__dirname, '..', '.deployments-cache');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, `${network.name}.json`),
    JSON.stringify(cache, null, 2)
  );

  console.log(`\nDeployment complete. Cached addresses for "${network.name}":`);
  for (const [name, addr] of Object.entries(cache.contracts)) {
    console.log(`  ${name.padEnd(24)} ${addr}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
