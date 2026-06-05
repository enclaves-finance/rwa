/**
 * scripts/verify-deployment.ts
 *
 * Post-deploy sanity check. Run this immediately after deploying to any
 * network — testnet or mainnet — to confirm that every contract is alive,
 * points at the right addresses, and has the right admin/agent set.
 *
 *   npx hardhat run scripts/verify-deployment.ts --network sepolia
 *
 * Fails loudly with a non-zero exit code if anything's off; logs a pretty
 * summary on success that's suitable for a deployment runbook.
 *
 * Addresses are resolved from `.deployments-cache/<network>.json` (written
 * by `scripts/deploy.ts`) and fall back to `deployments/<network>.json`.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ethers, network } from 'hardhat';

const ZERO = ethers.ZeroAddress;
const ZERO_BYTES32 = '0x' + '00'.repeat(32);

interface Check {
  label: string;
  status: 'ok' | 'FAIL';
  value: string;
}

const checks: Check[] = [];

function ok(label: string, value: string): void {
  checks.push({ label, status: 'ok', value });
}
function fail(label: string, value: string): void {
  checks.push({ label, status: 'FAIL', value });
}
function eq(label: string, actual: string, expected: string): void {
  if (actual === expected) ok(label, actual);
  else fail(label, `expected=${expected} actual=${actual}`);
}
function neq(label: string, actual: string, blocked: string): void {
  if (actual !== blocked) ok(label, actual);
  else fail(label, `unexpected value=${actual}`);
}

function loadAddresses(networkName: string): Record<string, string> {
  const cacheFile = path.join(
    __dirname,
    '..',
    '.deployments-cache',
    `${networkName}.json`
  );
  if (fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8')).contracts;
  }
  const deploymentsFile = path.join(
    __dirname,
    '..',
    'deployments',
    `${networkName}.json`
  );
  if (fs.existsSync(deploymentsFile)) {
    return JSON.parse(fs.readFileSync(deploymentsFile, 'utf8')).contracts;
  }
  throw new Error(
    `No deployment record for "${networkName}". Run "npx hardhat run scripts/deploy.ts --network ${networkName}" first.`
  );
}

async function main(): Promise<void> {
  const k = (s: string): string => ethers.id(s);
  const CONTRACT_KINDS = {
    BIOMASS: k('BIOMASS'),
    REAL_ESTATE: k('REAL_ESTATE'),
    PRECIOUS_METALS: k('PRECIOUS_METALS'),
    SECURITIES: k('SECURITIES'),
    COLLECTIBLES: k('COLLECTIBLES'),
  };

  const addr = loadAddresses(network.name);
  console.log(`\n=== Verifying deployment on "${network.name}" ===\n`);

  const encl = await ethers.getContractAt('ENCL', addr.ENCL);
  const staking = await ethers.getContractAt('StakingBond', addr.StakingBond);
  const ir = addr.MockIdentityRegistry
    ? await ethers.getContractAt('MockIdentityRegistry', addr.MockIdentityRegistry)
    : null;
  const compliance = await ethers.getContractAt(
    'EnclavesCompliance',
    addr.EnclavesCompliance
  );
  const factory = await ethers.getContractAt(
    'EnclavesTokenFactory',
    addr.EnclavesTokenFactory
  );
  const biomass = await ethers.getContractAt('EnclavesBiomass', addr.EnclavesBiomass);
  const realEstate = await ethers.getContractAt(
    'EnclavesRealEstate',
    addr.EnclavesRealEstate
  );
  const precious = await ethers.getContractAt(
    'EnclavesPreciousMetals',
    addr.EnclavesPreciousMetals
  );
  const securities = await ethers.getContractAt(
    'EnclavesSecurities',
    addr.EnclavesSecurities
  );
  const collectibles = await ethers.getContractAt(
    'EnclavesCollectibles',
    addr.EnclavesCollectibles
  );

  // ---- 1. Globals --------------------------------------------------------
  eq('ENCL.name', await encl.name(), 'Enclaves');
  eq('ENCL.symbol', await encl.symbol(), 'ENCL');
  eq('ENCL.decimals', (await encl.decimals()).toString(), '18');
  neq('ENCL.totalSupply > 0', (await encl.totalSupply()).toString(), '0');

  eq('StakingBond.enclToken', await staking.enclToken(), await encl.getAddress());
  neq('StakingBond.admin not zero', await staking.admin(), ZERO);
  neq('StakingBond.slashReceiver not zero', await staking.slashReceiver(), ZERO);
  neq('StakingBond.enclPriceUsd not zero', (await staking.enclPriceUsd()).toString(), '0');
  eq(
    'StakingBond.bondingRateBps[5] = 1600 (Class V)',
    (await staking.bondingRateBps(5)).toString(),
    '1600'
  );

  // ---- 2. Enclave wiring -------------------------------------------------
  neq('Compliance.enclaveId set', await compliance.enclaveId(), ZERO_BYTES32);
  neq('Compliance.platformAgent set', await compliance.platformAgent(), ZERO);
  if (ir) {
    eq(
      'Compliance.identityRegistry',
      await compliance.identityRegistry(),
      await ir.getAddress()
    );
  }

  eq(
    'Factory.identityRegistry',
    await factory.identityRegistry(),
    await compliance.identityRegistry()
  );
  eq('Factory.compliance', await factory.compliance(), await compliance.getAddress());
  eq('Factory.stakingBond', await factory.stakingBond(), await staking.getAddress());
  eq(
    'Factory.platformAgent',
    await factory.platformAgent(),
    await compliance.platformAgent()
  );

  // ---- 3. Implementation registry ----------------------------------------
  eq(
    'impl[BIOMASS]',
    await factory.implementations(CONTRACT_KINDS.BIOMASS),
    await biomass.getAddress()
  );
  eq(
    'impl[REAL_ESTATE]',
    await factory.implementations(CONTRACT_KINDS.REAL_ESTATE),
    await realEstate.getAddress()
  );
  eq(
    'impl[PRECIOUS_METALS]',
    await factory.implementations(CONTRACT_KINDS.PRECIOUS_METALS),
    await precious.getAddress()
  );
  eq(
    'impl[SECURITIES]',
    await factory.implementations(CONTRACT_KINDS.SECURITIES),
    await securities.getAddress()
  );
  eq(
    'impl[COLLECTIBLES]',
    await factory.implementations(CONTRACT_KINDS.COLLECTIBLES),
    await collectibles.getAddress()
  );

  // ---- 4. Predicted deploy address sanity --------------------------------
  const predicted: string = await factory.predictDeployment(
    CONTRACT_KINDS.BIOMASS,
    k('SANITY_CHECK')
  );
  neq('predictDeployment returns non-zero', predicted, ZERO);

  // ---- 5. Report ---------------------------------------------------------
  const okCount = checks.filter((c) => c.status === 'ok').length;
  const failCount = checks.filter((c) => c.status === 'FAIL').length;

  console.log('Address summary');
  console.log('---------------');
  console.log(`  ENCL:                  ${await encl.getAddress()}`);
  console.log(`  StakingBond:           ${await staking.getAddress()}`);
  if (ir) console.log(`  MockIdentityRegistry:  ${await ir.getAddress()}`);
  console.log(`  EnclavesCompliance:    ${await compliance.getAddress()}`);
  console.log(`  EnclavesTokenFactory:  ${await factory.getAddress()}`);
  console.log(`  EnclavesBiomass impl:  ${await biomass.getAddress()}`);
  console.log(`  EnclavesRealEstate:    ${await realEstate.getAddress()}`);
  console.log(`  EnclavesPreciousMetals:${await precious.getAddress()}`);
  console.log(`  EnclavesSecurities:    ${await securities.getAddress()}`);
  console.log(`  EnclavesCollectibles:  ${await collectibles.getAddress()}`);
  console.log();

  console.log('Checks');
  console.log('------');
  for (const c of checks) {
    const marker = c.status === 'ok' ? '  \u2713 ' : '  \u2717 ';
    console.log(`${marker}${c.label}: ${c.value}`);
  }
  console.log(`\n${okCount} ok, ${failCount} failed`);

  if (failCount > 0) {
    throw new Error(`${failCount} verification check(s) failed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
