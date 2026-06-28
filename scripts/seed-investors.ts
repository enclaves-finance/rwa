#!/usr/bin/env ts-node
/**
 * rwa/scripts/seed-investors.ts
 *
 * Makes the local dev chain mint-ready by registering a handful of Hardhat
 * accounts as verified investors in the MockIdentityRegistry and allowing
 * their country by default in EnclavesCompliance.
 *
 * Why this is needed: EnclavesRWA.mint() enforces the ERC-3643 invariants —
 * the recipient must be `identityRegistry.isVerified(to)` and pass
 * `compliance.canMint(to, …)` (which checks the investor's country). The
 * platform's signing-service only signs the allowlisted platform-agent
 * functions, so it cannot register identities; that has to be seeded
 * out-of-band. This script (run as the deployer, which is the MockIdentityRegistry
 * admin and the compliance owner/platform-agent) does exactly that.
 *
 * Idempotent — safe to re-run. Run against the live dev chain with:
 *   npx hardhat run scripts/seed-investors.ts --network localhost
 */

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

// ISO-3166 numeric for the United States. The same value must be used when
// registering the investor and when allowing the country, and it matches the
// e2e suite's expectation (specs/05-chain seeds US assets).
const COUNTRY = Number(process.env.SEED_INVESTOR_COUNTRY || 840);
// How many Hardhat accounts to register as verified investors. Account #1 is
// the e2e mint recipient; the rest give headroom for multi-holder scenarios.
const INVESTOR_COUNT = Number(process.env.SEED_INVESTOR_COUNT || 6);

async function main(): Promise<void> {
  const file = path.join(__dirname, '..', 'deployments', 'development.json');
  if (!fs.existsSync(file)) {
    throw new Error(`deployments/development.json not found — deploy the chain first (${file})`);
  }
  const dep = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    contracts?: Record<string, string>;
  };
  const irAddr = dep.contracts?.MockIdentityRegistry;
  const compAddr = dep.contracts?.EnclavesCompliance;
  if (!irAddr) throw new Error('MockIdentityRegistry not in deployments — this seed only supports the mock IR (dev).');
  if (!compAddr) throw new Error('EnclavesCompliance not in deployments.');

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const wallets = signers.slice(0, INVESTOR_COUNT);

  const ir = await ethers.getContractAt('MockIdentityRegistry', irAddr, deployer);
  for (const w of wallets) {
    // The ONCHAINID is impersonated by the wallet itself for dev purposes.
    const tx = await ir.setProfile(w.address, w.address, COUNTRY, true);
    await tx.wait();
  }

  const compliance = await ethers.getContractAt('EnclavesCompliance', compAddr, deployer);
  const tx = await compliance.setDefaultCountryAllowed(COUNTRY, true);
  await tx.wait();

  // eslint-disable-next-line no-console
  console.log(
    `Seeded ${wallets.length} verified investor(s) (country ${COUNTRY}) in ${irAddr} ` +
      `and allowed country ${COUNTRY} by default in ${compAddr}.`,
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
