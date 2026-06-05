/**
 * scripts/export-addresses.ts
 *
 * Reads the cached deployment addresses written by `scripts/deploy.ts` and
 * emits a tidy `deployments/<network>.json` summarising every deployed
 * contract on the current network. The output is what the platform /
 * indexer reads to discover addresses; commit it alongside each
 * testnet/mainnet deploy.
 *
 *   npx hardhat run scripts/export-addresses.ts --network sepolia
 *
 * Output (deployments/sepolia.json):
 *   {
 *     "network": "sepolia",
 *     "chainId": 11155111,
 *     "deployedAt": "2026-05-19T…",
 *     "contracts": {
 *       "ENCL":                 "0x…",
 *       "StakingBond":          "0x…",
 *       "MockIdentityRegistry": "0x…",
 *       "EnclavesCompliance":   "0x…",
 *       "EnclavesTokenFactory": "0x…",
 *       "EnclavesBiomass":      "0x…",
 *       …
 *     },
 *     "tokens": []  // appended by scripts/deploy-token.ts
 *   }
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ethers, network } from 'hardhat';

const CONTRACTS_OF_INTEREST = [
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
] as const;

interface TokenRecord {
  address: string;
  name?: string;
  symbol: string;
  contractKind?: string;
  category?: string;
  salt?: string;
  deployedAt?: string;
}

async function main(): Promise<void> {
  const { chainId } = await ethers.provider.getNetwork();

  const cacheFile = path.join(__dirname, '..', '.deployments-cache', `${network.name}.json`);
  if (!fs.existsSync(cacheFile)) {
    throw new Error(
      `No cached addresses at ${cacheFile}. Run "npx hardhat run scripts/deploy.ts --network ${network.name}" first.`
    );
  }
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
    contracts: Record<string, string>;
  };

  const out: {
    network: string;
    chainId: number;
    deployedAt: string;
    contracts: Record<string, string>;
    tokens: TokenRecord[];
  } = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    contracts: {},
    tokens: [],
  };

  for (const name of CONTRACTS_OF_INTEREST) {
    if (cache.contracts[name]) out.contracts[name] = cache.contracts[name];
  }

  const outDir = path.join(__dirname, '..', 'deployments');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);

  // Preserve existing tokens[] when re-exporting.
  let existing: { tokens?: TokenRecord[] } = {};
  if (fs.existsSync(outFile)) {
    existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  }
  out.tokens = existing.tokens || [];

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${Object.keys(out.contracts).length} addresses to ${outFile}`);
  for (const [k, v] of Object.entries(out.contracts)) {
    console.log(`  ${k.padEnd(24)} ${v}`);
  }
  if (out.tokens.length) {
    console.log(`\nTokens (${out.tokens.length} preserved):`);
    for (const t of out.tokens) {
      console.log(`  ${t.symbol.padEnd(8)} ${t.address}  (${t.contractKind || t.category})`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
