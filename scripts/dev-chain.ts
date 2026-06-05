#!/usr/bin/env ts-node
/**
 * rwa/scripts/dev-chain.ts
 *
 * One-shot bootstrap for the local development chain:
 *  1. Spawns `hardhat node` on :8545 with a deterministic mnemonic so
 *     account[2] (the platform agent) has the same address across restarts.
 *  2. Waits until the RPC accepts an `eth_blockNumber` call.
 *  3. Runs `hardhat run scripts/deploy.ts --network localhost`.
 *  4. Exports addresses to `deployments/development.json` via the existing
 *     export script.
 *  5. Pre-funds the platform agent with ENCL (transferred from the deployer
 *     account after deployment). Account ETH balances are already seeded by
 *     Hardhat Node from the deterministic mnemonic.
 *  6. If a sibling Enclaves `platform/` workspace is detected (i.e. you're
 *     running this from inside the monorepo), it also patches
 *     `platform/.env` with `RWA_*` and `PLATFORM_AGENT_*` values so the
 *     platform services can connect without manual copy-paste. When run
 *     standalone (this repo alone), this step is silently skipped.
 *
 * Ctrl-C cleanly stops Hardhat Node. Default mode blocks; pass `--detach`
 * to background it and exit.
 *
 * The Hardhat Node mirrors what `npm run test` uses (the same in-process
 * Hardhat Network), so a green dev chain is the same chain the suite was
 * green against.
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';

const RWA_ROOT = path.resolve(__dirname, '..');
const PLATFORM_ROOT = path.resolve(__dirname, '..', '..', 'platform');
const PLATFORM_ENV = path.join(PLATFORM_ROOT, '.env');

// Deterministic mnemonic — DO NOT USE IN PRODUCTION. This is a well-known
// test mnemonic; never put real value behind these keys.
const TEST_MNEMONIC =
  process.env.TEST_MNEMONIC ||
  'test test test test test test test test test test test junk';
const PORT = Number(process.env.HARDHAT_NODE_PORT || 8545);
// Hardhat Node defaults to chainId 31337 when started ad-hoc, regardless of
// the `networks.hardhat.chainId` in config. Set DEV_CHAIN_ID to override.
const CHAIN_ID = Number(process.env.DEV_CHAIN_ID || 31337);
const AGENT_ACCOUNT_INDEX = Number(process.env.AGENT_ACCOUNT_INDEX || 2);
const AGENT_ENCL_AMOUNT =
  process.env.AGENT_ENCL_AMOUNT || '1000000000000000000000000'; // 1M ENCL (18 decimals)

const detach = process.argv.includes('--detach');
const skipBoot = process.argv.includes('--no-boot');
const noFund = process.argv.includes('--no-fund');

interface DeploymentsFile {
  contracts?: Record<string, string>;
}

async function main(): Promise<void> {
  const nodeProc: ChildProcess | null = skipBoot ? null : startHardhatNode();
  try {
    await waitForRpc();
    runDeploy();
    runExport();
    if (!noFund) await fundPlatformAgent();
    await patchPlatformEnv();
    log(`Dev chain ready on http://127.0.0.1:${PORT} (chainId ${CHAIN_ID}).`);
  } catch (err) {
    const e = err as { stack?: string; message?: string };
    log(`bootstrap failed: ${e.stack || e.message}`);
    if (nodeProc) nodeProc.kill('SIGTERM');
    process.exit(1);
  }

  if (!nodeProc) return; // skipBoot mode
  if (detach) {
    nodeProc.unref();
    log(`Hardhat Node detached. Stop with \`kill ${nodeProc.pid}\`.`);
    return;
  }
  log('Press Ctrl-C to stop Hardhat Node.');
  // Keep the parent alive so the user can Ctrl-C cleanly.
  process.on('SIGINT', () => {
    nodeProc.kill('SIGINT');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    nodeProc.kill('SIGTERM');
    process.exit(0);
  });
}

function startHardhatNode(): ChildProcess {
  log(`Starting Hardhat Node on :${PORT} (mnemonic preset)\u2026`);
  const proc = spawn(
    'npx',
    ['hardhat', 'node', '--hostname', '127.0.0.1', '--port', String(PORT)],
    {
      cwd: RWA_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Hardhat Node honours these env vars for its accounts.
        MNEMONIC: TEST_MNEMONIC,
      },
    }
  );
  proc.on('exit', (code) => {
    log(`hardhat node exited with code ${code}`);
    if (code !== 0 && code !== null) process.exit(code);
  });
  return proc;
}

async function waitForRpc(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`RPC did not become ready within ${timeoutMs}ms`);
    }
    const ok = await rpcCall('eth_blockNumber').then(
      () => true,
      () => false
    );
    if (ok) return;
    await sleep(500);
  }
}

function runDeploy(): void {
  log('Running hardhat run scripts/deploy.ts --network localhost\u2026');
  const res = spawnSync(
    'npx',
    ['hardhat', 'run', 'scripts/deploy.ts', '--network', 'localhost'],
    { cwd: RWA_ROOT, stdio: 'inherit' }
  );
  if (res.status !== 0) throw new Error('hardhat run deploy.ts failed');
}

function runExport(): void {
  log('Exporting deployment addresses\u2026');
  // Hardhat exposes the localhost network; the export script writes to
  // `deployments/<network>.json` which we map back to the conventional
  // `development.json` filename for backwards compat.
  const res = spawnSync(
    'npx',
    ['hardhat', 'run', 'scripts/export-addresses.ts', '--network', 'localhost'],
    { cwd: RWA_ROOT, stdio: 'inherit' }
  );
  if (res.status !== 0) throw new Error('export-addresses failed');

  // Mirror to development.json for callers still expecting the legacy name.
  const src = path.join(RWA_ROOT, 'deployments', 'localhost.json');
  const dst = path.join(RWA_ROOT, 'deployments', 'development.json');
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}

async function fundPlatformAgent(): Promise<void> {
  log('Pre-funding platform agent with ENCL\u2026');
  const accounts = (await rpcCall('eth_accounts')) as string[];
  if (!Array.isArray(accounts) || accounts.length <= AGENT_ACCOUNT_INDEX) {
    log('  skipped: not enough accounts on Hardhat Node');
    return;
  }
  const deployer = accounts[0];
  const agent = accounts[AGENT_ACCOUNT_INDEX];

  const deployments = readDeployments();
  if (!deployments?.contracts?.ENCL) {
    log('  skipped: ENCL not in deployments/development.json');
    return;
  }
  const encl = deployments.contracts.ENCL;

  // encoding `transfer(address,uint256)` selector + args
  const selector = '0xa9059cbb';
  const toPadded = agent.toLowerCase().replace('0x', '').padStart(64, '0');
  const amtHex = BigInt(AGENT_ENCL_AMOUNT).toString(16).padStart(64, '0');
  const data = selector + toPadded + amtHex;

  const tx = {
    from: deployer,
    to: encl,
    data,
    gas: '0x186a0',
  };
  const txHash = await rpcCall('eth_sendTransaction', [tx]);
  log(`  ENCL.transfer(${agent}, ${AGENT_ENCL_AMOUNT}) \u2192 ${txHash}`);
}

async function patchPlatformEnv(): Promise<void> {
  // Only patch the sibling platform workspace if we're running inside the
  // monorepo. When the rwa repo is checked out on its own (the OSS case),
  // there is no ../../platform directory and we just skip this step.
  if (!fs.existsSync(PLATFORM_ROOT)) {
    log('No sibling platform/ workspace detected — skipping env patch.');
    return;
  }

  const deployments = readDeployments();
  if (!deployments) return;

  const accounts = (await rpcCall('eth_accounts')) as string[];
  const agent = accounts[AGENT_ACCOUNT_INDEX];

  const updates = {
    RWA_NETWORK: 'development',
    RWA_RPC_URL: `http://127.0.0.1:${PORT}`,
    RWA_CHAIN_ID: String(CHAIN_ID),
    PLATFORM_AGENT_ADDRESS: agent,
    SIGNING_SERVICE_URL: 'http://127.0.0.1:4023',
    INDEXER_ENABLED: 'true',
  };
  mergeEnvFile(PLATFORM_ENV, updates);
  log(`Patched ${PLATFORM_ENV}:`);
  for (const [k, v] of Object.entries(updates)) log(`  ${k}=${v}`);
  log(
    `NOTE: PLATFORM_AGENT_PRIVATE_KEY must be copied from Hardhat Node's startup output ` +
      `(use account index ${AGENT_ACCOUNT_INDEX}). The mnemonic is the test mnemonic.`
  );
}

function readDeployments(): DeploymentsFile | null {
  const file = path.join(RWA_ROOT, 'deployments', 'development.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mergeEnvFile(file: string, updates: Record<string, string>): void {
  let existing = '';
  if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8');
  const lines = existing.split('\n');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      out.push(`${m[1]}=${updates[m[1]]}`);
      seen.add(m[1]);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) {
      if (out[out.length - 1] !== '') out.push('');
      out.push(`${k}=${v}`);
    }
  }
  fs.writeFileSync(file, out.join('\n'));
}

let rpcId = 1;
function rpcCall(method: string, params: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { result?: unknown; error?: { message: string } };
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed.result);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  process.stderr.write(`[dev-chain] ${msg}\n`);
}

main().catch((err) => {
  const e = err as { stack?: string; message?: string };
  log(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
