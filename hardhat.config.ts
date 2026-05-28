/**
 * Hardhat configuration for the Enclaves RWA contracts.
 *
 * See <https://hardhat.org/hardhat-runner/docs/config> for the full list
 * of options. Network credentials are loaded from `.env`
 * (see `.env.example`).
 *
 * Stack: Hardhat 2 + ethers v6 + TypeChain (ethers-v6 target) +
 * @nomicfoundation/hardhat-chai-matchers for `revertedWith`-style
 * assertions in Mocha.
 */

import 'dotenv/config';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import 'solidity-coverage';
import '@nomicfoundation/hardhat-verify';
import '@typechain/hardhat';

import type { HardhatUserConfig, HttpNetworkAccountsUserConfig } from 'hardhat/types';

const {
  MNEMONIC,
  DEPLOYER_PRIVATE_KEY,
  SEPOLIA_RPC_URL,
  POLYGON_RPC_URL,
  POLYGON_AMOY_RPC_URL,
  MAINNET_RPC_URL,
  ETHERSCAN_API_KEY,
  POLYGONSCAN_API_KEY,
} = process.env;

function accounts(): HttpNetworkAccountsUserConfig | undefined {
  if (DEPLOYER_PRIVATE_KEY) return [DEPLOYER_PRIVATE_KEY];
  if (MNEMONIC) return { mnemonic: MNEMONIC };
  return undefined;
}

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.30',
    settings: {
      // Optimize for deployment size. ERC-3643 + lifecycle + category
      // extensions sit right at the EIP-170 24,576-byte ceiling, so we
      // bias the optimizer towards smaller bytecode (low `runs`) and
      // enable the IR pipeline for further code-size reductions.
      optimizer: {
        enabled: true,
        runs: 1,
        details: {
          yul: true,
        },
      },
      viaIR: true,
      // Pin to London so deployed bytecode runs on every L1 + L2 we
      // target — no Shanghai PUSH0 (default since 0.8.20) and no Cancun
      // transient storage in the output.
      evmVersion: 'london',
    },
  },

  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },

  typechain: {
    target: 'ethers-v6',
    outDir: 'typechain-types',
    alwaysGenerateOverloads: false,
    discriminateTypes: false,
  },

  networks: {
    hardhat: {
      chainId: 31337,
      blockGasLimit: 30_000_000,
      // The test suite destructures up to 20 accounts (see the
      // `const [deployer, …]` patterns in test files); make sure Hardhat
      // Network provides at least that many.
      accounts: {
        count: 20,
      },
    },
    // `npm run node` exposes the in-process chain on :8545.
    localhost: {
      url: 'http://127.0.0.1:8545',
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL || '',
      chainId: 11155111,
      accounts: accounts(),
    },
    polygonAmoy: {
      url: POLYGON_AMOY_RPC_URL || '',
      chainId: 80002,
      accounts: accounts(),
    },
    polygon: {
      url: POLYGON_RPC_URL || '',
      chainId: 137,
      accounts: accounts(),
    },
    mainnet: {
      url: MAINNET_RPC_URL || '',
      chainId: 1,
      accounts: accounts(),
    },
  },

  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY || '',
      mainnet: ETHERSCAN_API_KEY || '',
      polygon: POLYGONSCAN_API_KEY || '',
      polygonAmoy: POLYGONSCAN_API_KEY || '',
    },
  },

  mocha: {
    timeout: 120_000,
  },
};

export default config;
