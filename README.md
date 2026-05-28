# @enclaves/rwa

ENCLAVES Real-World-Asset tokenization contracts.

This is the Solidity workspace that implements the **EnclavesRWA v3 conceptual
design** on top of the **ERC-3643 / T-REX** standard. It is a **Hardhat 2**
project so it slots straight into the existing ENCLAVES tooling.

> **TL;DR** &mdash; one abstract base, one per-Enclave compliance module, one
> per-Enclave factory, a global staking bond, and a small family of asset-
> category extensions (Biomass, Real Estate, Precious Metals, Securities,
> Collectibles).
>
> The **ENCL** utility / bonding token is intentionally **not** part of
> this repository. It lives in [`@enclaves/encl`](https://github.com/enclaves-finance/encl)
> and is consumed here as a compiled artifact via `file:../encl`. This keeps the
> token's governance, audit and address rotation independent of the RWA
> contracts. **Clone both repos side-by-side** so `file:../encl` resolves —
> see [Getting started](#getting-started) below.

## Contract map

```
T-REX Token (ERC-3643 base, deployed not written)
        ▲
        │ inherits / replaces
        │
EnclavesRWA (abstract)                       <-- contracts/EnclavesRWA.sol
   ├── EnclavesBiomass                       <-- contracts/categories/EnclavesBiomass.sol
   ├── EnclavesRealEstate
   ├── EnclavesPreciousMetals
   ├── EnclavesSecurities
   └── EnclavesCollectibles

EnclavesCompliance        per Enclave        <-- contracts/EnclavesCompliance.sol
EnclavesTokenFactory      per Enclave        <-- contracts/EnclavesTokenFactory.sol
StakingBond               global             <-- contracts/StakingBond.sol
ENCL                      global             <-- @enclaves/encl (separate repo)
YieldDistributor          per token          <-- contracts/distribution/YieldDistributor.sol
RedemptionEscrow          per token          <-- contracts/distribution/RedemptionEscrow.sol
```

`contracts/external/ENCLImport.sol` is a one-line shim that exists solely so
Hardhat compiles the canonical `@enclaves/encl/contracts/ENCL.sol` into a
local `artifacts/.../ENCL.json` artifact for use by `StakingBond` tests and
deploy scripts. **Do not edit the contract there — edit the source in the
`encl` repository.**

### EnclavesRWA — abstract base

Implements every base-contract responsibility from the v3 spec:

| Responsibility               | Where it lives                                  |
| ---------------------------- | ------------------------------------------------ |
| ERC-20 + snapshot            | OpenZeppelin `ERC20SnapshotUpgradeable`          |
| ERC-3643 compliance hook     | `_beforeTokenTransfer` → `preTransferCheck`      |
| Pause + freeze + seize       | `pause/unpause`, `isFrozen[..]`, `seize(..)`     |
| Asset identity (immutable)   | `enclaveId`, `trustClass`, `contractKind`, …     |
| SPV details                  | `spvOperator` (mutable) + immutable SPV fields   |
| Supply control               | `maxSupply`, `totalIssued`, `mintFinalized`      |
| Valuation (TVL input)        | `assetValuation`, `updateValuation(..)`          |
| Lifecycle state machine      | `assetState` (`Registered → … → Retired`)        |
| Mint authorization           | `MintConditions` + `approveMint()`               |
| Issuance rounds + lockups    | `_issuanceRounds` keyed by ONCHAINID             |
| Holder tracking              | `EnumerableSet` updated in `_afterTokenTransfer` |
| Maturity / buyback           | `setMaturityTerms`, `triggerMaturity`, `redeemAtMaturity` |
| Snapshot for distributions   | `snapshot()` (platform only)                     |

Concrete category contracts inherit the base and bolt on asset-specific
fields — see [`contracts/categories/EnclavesBiomass.sol`](contracts/categories/EnclavesBiomass.sol)
for the canonical biomass example.

### Deployment topology

```
Step 0a (once per chain, separate repo)
  - cd ../encl && npm run deploy:<network>      [deploys ENCL]
Step 0b (once per chain)
  - Deploy StakingBond bound to the ENCL addr   [scripts/deploy.ts step 1]
Step 1 (once per Enclave)
  - Deploy / connect IdentityRegistry            [scripts/deploy.ts step 2]
  - Deploy EnclavesCompliance
  - Deploy each category implementation
  - Deploy EnclavesTokenFactory & register each
    category implementation
Step 2 (per asset)
  - factory.deploy(req)                          [scripts/deploy-token.ts,
                                                  or the platform backend
                                                  in production]
```

## Getting started

> **Node version:** Hardhat's bundled solc download works on any Node ≥ 18,
> but the test suite is exercised on Node 20 / 22; see [`.nvmrc`](.nvmrc).

`rwa` depends on `encl` via `file:../encl`, so check out both repos
side-by-side first:

```bash
# Same parent directory:
git clone https://github.com/enclaves-finance/encl.git
git clone https://github.com/enclaves-finance/rwa.git
```

Then:

```bash
cd rwa
nvm use                # picks up .nvmrc (Node 20)
npm install            # resolves file:../encl
cp .env.example .env   # fill in RPC + deployer credentials
npm run compile        # hardhat compile

# Tests run against the in-process Hardhat Network — no separate chain needed:
npm test               # full suite (unit + integration + e2e — 277 tests)
npm run test:unit
npm run test:integration
npm run test:e2e

# Optional: a long-running Hardhat Node on :8545 for the platform services
npm run node           # blocks; serves at http://127.0.0.1:8545
# in another shell, run scripts against it with --network localhost
```

## Test suite

The suite is organised in three tiers (277 tests total, all green). ENCL's own
token tests live in [`enclaves-finance/encl`](https://github.com/enclaves-finance/encl)
— they aren't duplicated here.

```
test/
├── helpers/                          shared fixtures + constants
│   ├── constants.ts                  ENCLAVE_ID, CONTRACT_KIND, COUNTRY, STATE, …
│   ├── fixture.ts                    deployGlobals / deployEnclave / deployBiomassToken / …
│   └── utils.ts                      k, toBytes32, advanceTime, snapshot, …
├── unit/                             single-contract behavior
│   ├── MockIdentityRegistry.test.ts   4 tests
│   ├── StakingBond.test.ts           18 tests (bond math, slash, top-up, unbond)
│   ├── EnclavesCompliance.test.ts    20 tests (countries, intermediaries, investor counting)
│   ├── EnclavesTokenFactory.test.ts  13 tests (clone deploy, registry, predictDeployment)
│   ├── EnclavesRWA.test.ts           47 tests (lifecycle, mint gate, seize, maturity, snapshots)
│   ├── YieldDistributor.test.ts      10 tests
│   ├── RedemptionEscrow.test.ts       7 tests
│   └── categories/
│       ├── EnclavesBiomass.test.ts   12 tests (farms, production reports, impact, raise gate)
│       ├── EnclavesRealEstate.test.ts 4 tests
│       └── EnclavesSecurities.test.ts 2 tests
├── integration/                      multi-contract flows
│   ├── BondMintFlow.test.ts          4 tests (full mint-gate validation)
│   └── ComplianceTransferRules.test.ts  8 tests (country / cap / intermediary)
└── e2e/                              full lifecycle scenarios
    ├── Lifecycle.test.ts             61 tests — biomass, 22 phases, every phase
    │                                 is its own `it()` so failures pinpoint
    │                                 the exact step (create / mint / activate
    │                                 / suspend / mature / redeem / retire / unbond)
    ├── RealEstateLifecycle.test.ts   10 tests — Berlin Tower walks the same
    │                                 lifecycle as biomass to prove the base
    │                                 contract is category-agnostic
    ├── MultiTokenEnclave.test.ts      9 tests — two tokens under one Enclave;
    │                                 verifies factory registry, per-token
    │                                 compliance, independent bonds + states
    ├── CrossEnclaveIsolation.test.ts 13 tests — two SEPARATE enclaves (multi-
    │                                 tenant deployment); proves admin/agent
    │                                 boundaries hold across enclaves
    ├── FrozenAddressFlow.test.ts     11 tests — regulatory freeze / unfreeze /
    │                                 seize bypass; covers the sanctions kill
    │                                 switch path end-to-end
    ├── SlashRecoveryFlow.test.ts     12 tests — bond → slash below required →
    │                                 mint gate locks → topUp → recovers; full
    │                                 economic-safety loop
    ├── DeploymentScriptIntegration.test.ts
    │                                  6 tests — runs against the REAL deploy
    │                                 script + deploy-token-style encoding.
    │                                 Green here ≈ "deploy will work on testnet"
    └── ExchangeIntegration.test.ts    6 tests (custodial / direct / intermediary)
```

The `Lifecycle.test.ts` file is the canonical reference for the contract
lifecycle. Running just that file produces a step-by-step narrative of every
transition the spec requires:

```bash
npx hardhat test test/e2e/Lifecycle.test.ts
```

Local end-to-end deployment:

```bash
npm run dev:chain            # spins up Hardhat Node + deploy + export + env patch
# or step by step:
npm run node &               # local chain on :8545
npm run deploy:local         # runs scripts/deploy.ts
npm run verify               # post-deploy invariant checks
npm run export               # writes deployments/localhost.json
```

## Testnet runbook

The full happy-path for Sepolia (or Polygon Amoy — substitute the network name):

```bash
# 1. Deploy ENCL (one-time, from the encl repo)
cd ../encl
cp .env.example .env         # set MNEMONIC + SEPOLIA_RPC_URL + ENCL_TREASURY
npm run deploy:sepolia       # deploy + verify + export

# 2. Copy the address that encl/deployments/sepolia.json holds into rwa's .env
cd ../rwa
cp .env.example .env
# Edit .env: ENCL_ADDRESS=<value from encl/deployments/sepolia.json>
#            PLATFORM_AGENT=<your platform wallet>
#            ENCL_SLASH_RECEIVER=<your slash-receiver wallet>

# 3. Deploy the rwa stack
npm run deploy:sepolia       # deploy + verify-deployment + export-addresses
                             # writes deployments/sepolia.json

# 4. Verify on Etherscan (requires ETHERSCAN_API_KEY in .env)
npm run verify:etherscan

# 5. Deploy your first token
TOKEN_CONFIG=scripts/examples/example-biomass.json \
DEPLOYMENTS=deployments/sepolia.json \
npx hardhat run scripts/deploy-token.ts --network sepolia
```

After step 5 the new token's address is appended to `deployments/sepolia.json`
under the `tokens[]` array, and the indexer / platform can pick it up.

| Script                              | When to run                           |
| ----------------------------------- | ------------------------------------- |
| `hardhat run scripts/deploy.ts`     | Once per network (globals + enclave)  |
| `scripts/verify-deployment.ts`      | Immediately after every deploy        |
| `scripts/export-addresses.ts`       | Immediately after every deploy        |
| `scripts/deploy-token.ts`           | Once per RWA token                    |
| `scripts/verify-etherscan.ts`       | After source-level changes go live    |

The `e2e/DeploymentScriptIntegration.test.ts` suite exercises the same wiring
locally inside `hardhat test`, so a CI green light is a high-confidence
prediction of testnet success.

## Production wiring — Identity Registry

For development, [`contracts/mocks/MockIdentityRegistry.sol`](contracts/mocks/MockIdentityRegistry.sol)
stands in for the real ERC-3643 identity stack. In production, point the
factory and compliance module at the canonical T-REX `IdentityRegistry`
deployed for the Enclave (`IR_ADDRESS` env var on `scripts/deploy.ts`).

## Lifecycle reference (per the spec)

```
Registered ──[all conditions met]──→ MintReady
MintReady  ──[full supply minted]──→ Active
Active     ──[SPV suspends]────────→ Suspended
Suspended  ──[SPV resumes]─────────→ Active
Active|Suspended ──[SPV redeems]───→ Redeeming
Redeeming  ──[SPV retires]─────────→ Retired
```

All five state-transition functions live on `EnclavesRWA` (`suspend`,
`resume`, `initiateRedemption`, `retire`) plus the implicit
`MintReady → Active` triggered by `_mintInternal` once `totalIssued == maxSupply`.

## Mint authorization summary

`mint(...)` will revert unless **all** of the following hold:

1. `mintFinalized == false`
2. `assetState == MintReady`
3. `block.timestamp >= mintReadyAt + coolingPeriod`
4. `stakingBond.isBonded(address(this)) == true`
5. `identityRegistry.isVerified(to) == true`
6. `totalIssued + amount <= maxSupply`
7. Caller has the platform-agent role

## Yield distribution

For revenue-bearing assets, deploy a `YieldDistributor` per token. The
platform agent then:

1. Approves the distributor to spend stablecoin from the platform/SPV wallet.
2. Calls `createDistribution(amount, paymentToken, claimDeadline)` — the
   distributor calls `token.snapshot()`, pulls the stablecoin, and opens a
   new period.
3. Holders call `claim(period)` (or `claimMultiple([..])`).

## Maturity & redemption

Bounded-term assets (e.g. a 5-year biomass revenue right) configure
maturity once via `setMaturityTerms(...)` and deploy a
`RedemptionEscrow` per token. Once the maturity date passes, anyone can call
`triggerMaturity()`; the escrow funds the buyback; holders redeem.

## Not in scope here (platform side)

Per the spec, the following are off-chain platform services and are **not**
implemented in this repo:

- Trust Score Engine
- Document Vault
- Valuation Engine (writes results via `updateValuation`)
- Actor Registry / KYC orchestration
- Fee Collection (ENCL billing)
- Verification Orchestrator
- Trust Certificate
- Event Indexer
- Governance UI

## Toolchain notes

This is a **Hardhat 2 + TypeScript + ethers v6 + TypeChain** project,
deliberately so:

- **Hardhat 2** is the audited-on-mainnet line that Tokeny's reference
  ERC-3643 ([T-REX][trex]) and a large fraction of audited RWA
  codebases still ship on. Tests use the first-party
  `@nomicfoundation/hardhat-ethers` + `hardhat-chai-matchers` stack:
  plain `describe()` / `it()` blocks, `ethers.getContractFactory()`,
  `expect(tx).to.emit(c, 'E').withArgs(...)`.
- **Solidity 0.8.30** with `optimizer.runs = 1`, `viaIR` and the
  `london` EVM target. The category contracts hug the EIP-170
  24,576-byte ceiling, so we bias the optimizer towards smaller
  bytecode and pin to London so the deployed code runs on every L1 +
  L2 we plan to support (no Shanghai `PUSH0`, no Cancun transient
  storage).
- **[TypeChain][typechain]** with the `ethers-v6` target generates
  fully-typed contract factories and instances at compile time
  (`npx hardhat compile` runs it via `@typechain/hardhat`). The
  generated bindings live in `typechain-types/` (gitignored) and are
  what makes `tsconfig.json`'s `strict: true` pass — no ambient
  `any`s, no hand-maintained `hardhat-env.d.ts`.

Run `npm run typecheck` to lint the entire TS surface (test files
included) under full strict mode without emitting JavaScript.

[trex]: https://github.com/TokenySolutions/T-REX
[typechain]: https://github.com/dethcrypto/TypeChain

## License

`@enclaves/rwa` is released under [GPL-3.0](LICENSE), which matches the
T-REX upstream and the `SPDX-License-Identifier` of every Solidity file.
