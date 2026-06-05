/**
 * scripts/verify-etherscan.ts
 *
 * Verifies every contract from the deployment on Etherscan / Polygonscan
 * using Hardhat's first-party `@nomicfoundation/hardhat-verify` plugin.
 *
 *   npx hardhat run scripts/verify-etherscan.ts --network sepolia
 *
 * Addresses are read from `.deployments-cache/<network>.json` (written by
 * `scripts/deploy.ts`). Constructor arguments are reconstructed from the
 * same env vars that drove the deployment.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import hre, { ethers, network } from 'hardhat';

async function verify(label: string, address: string, constructorArguments: unknown[]): Promise<void> {
  try {
    await hre.run('verify:verify', { address, constructorArguments });
    console.log(`  \u2713 verified ${label} (${address})`);
  } catch (err) {
    const e = err as { message?: string };
    if (String(e.message || err).match(/already verified/i)) {
      console.log(`  \u2713 ${label} already verified (${address})`);
    } else {
      console.error(`  \u2717 failed to verify ${label}: ${e.message || err}`);
    }
  }
}

async function main(): Promise<void> {
  const cacheFile = path.join(
    __dirname,
    '..',
    '.deployments-cache',
    `${network.name}.json`
  );
  if (!fs.existsSync(cacheFile)) {
    throw new Error(
      `No cached addresses at ${cacheFile}. Run "npx hardhat run scripts/deploy.ts --network ${network.name}" first.`
    );
  }
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
    enclaveId: string;
    contracts: Record<string, string>;
  };
  const c = cache.contracts;

  const [deployer] = await ethers.getSigners();
  const deployerAccount = deployer.address;

  const treasury = process.env.ENCL_TREASURY || deployerAccount;
  const slashReceiver = process.env.ENCL_SLASH_RECEIVER || deployerAccount;
  const enclPriceUsd = process.env.ENCL_PRICE_USD || '250000000000000000';
  const platformAgent = process.env.PLATFORM_AGENT || deployerAccount;
  const initialSupply = ethers.parseEther('1000000000').toString();

  console.log(`\n=== Verifying source on Etherscan for "${network.name}" ===\n`);

  // ENCL — only verify when we deployed it ourselves; if ENCL_ADDRESS was
  // supplied the user owns its verification.
  if (!process.env.ENCL_ADDRESS) {
    await verify('ENCL', c.ENCL, [treasury, initialSupply]);
  } else {
    console.log(`  - skipping ENCL (bound to existing deployment ${c.ENCL})`);
  }

  await verify('StakingBond', c.StakingBond, [c.ENCL, deployerAccount, slashReceiver, enclPriceUsd]);

  if (c.MockIdentityRegistry) {
    await verify('MockIdentityRegistry', c.MockIdentityRegistry, []);
  }

  await verify('EnclavesCompliance', c.EnclavesCompliance, [
    cache.enclaveId,
    c.MockIdentityRegistry || process.env.IR_ADDRESS,
    platformAgent,
  ]);

  await verify('EnclavesBiomass', c.EnclavesBiomass, []);
  await verify('EnclavesRealEstate', c.EnclavesRealEstate, []);
  await verify('EnclavesPreciousMetals', c.EnclavesPreciousMetals, []);
  await verify('EnclavesSecurities', c.EnclavesSecurities, []);
  await verify('EnclavesCollectibles', c.EnclavesCollectibles, []);

  await verify('EnclavesTokenFactory', c.EnclavesTokenFactory, [
    cache.enclaveId,
    c.MockIdentityRegistry || process.env.IR_ADDRESS,
    c.EnclavesCompliance,
    c.StakingBond,
    platformAgent,
    deployerAccount,
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
