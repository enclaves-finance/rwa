# Contributing

Thanks for taking the time to contribute to `@enclaves/rwa`. These contracts
custody real-world-asset value once deployed, so the bar for merged changes is
deliberately high.

## Ground rules

- Open an issue before sending a non-trivial PR so we can agree on direction.
- **Never** open a public GitHub issue for a security problem — see
  [`SECURITY.md`](SECURITY.md).
- Every contract-level change needs a corresponding test in `test/`. Bytecode
  changes need both unit and integration coverage.

## Development setup

```bash
nvm use                  # node 20
npm install              # resolves file:../encl (which itself runs its own prepare)
cp .env.example .env     # fill in only what you need; defaults work for tests
npm run compile          # compiles contracts + generates typechain-types/
npm test                 # full suite — unit + integration + e2e
```

You'll need Node 20 or 22 (`.nvmrc` pins 20; CI runs both). The full suite
runs against the in-process Hardhat Network — no separate chain or sibling
services required.

The first compile downloads solc 0.8.30, resolves the `file:../encl`
dependency, and generates `typechain-types/` from the compiled artifacts —
this can take a minute. Re-run `npm run compile` whenever you change a
contract; the generated `.d.ts` files are what give the test files their
typed `ethers.getContractFactory('ENCL')` calls and per-contract instance
types.

## Layout

- `contracts/` — the on-chain code (RWA base, category extensions, compliance,
  factory, staking bond, distribution helpers, interfaces, mocks)
- `scripts/` — deploy, verify, export, dev-chain bootstrap, token deploy
- `test/` — unit (`test/unit/`), integration, and e2e tiers; shared helpers
  in `test/helpers/`
- `deployments/` — committed per-network deployment records

See [`README.md`](README.md) for the full architectural overview.

## Style

- Solidity: format with `npm run format`, lint with `npm run lint`. Public
  state and external functions get NatSpec.
- TypeScript: tests use plain Mocha `describe(...)` / `it(...)` with
  `@nomicfoundation/hardhat-ethers` + `hardhat-chai-matchers`. Contracts
  are deployed via `ethers.getContractFactory('Name')` and typed by
  TypeChain's `ethers-v6` target. Helpers live in `test/helpers/`;
  prefer extending them over copy-pasting setup code. The whole TS
  surface compiles under `strict: true`; run `npm run typecheck` before
  sending a PR.
- Keep test names readable in CI output — they're our living spec.

## Tests

Three tiers:

| Tier | What |
|------|------|
| `test/unit/` | Single-contract behaviour, no inter-contract assumptions |
| `test/integration/` | Two or three contracts wired together; full bond / mint / compliance flows |
| `test/e2e/` | Whole-lifecycle scenarios that match the spec narratives |

Run a single tier with `npm run test:unit` / `:integration` / `:e2e`.

When you add a contract or a new lifecycle gate, also extend
`test/e2e/Lifecycle.test.ts` so the canonical lifecycle stays end-to-end.

## Commit hygiene

- One logical change per commit. Rebase before opening the PR.
- Commit messages: short imperative summary on line 1, optional body explaining
  why (not what — the diff already shows that).

## Deployment changes

If your PR changes the deploy topology (new contract, new init param, etc.):

1. Update `scripts/deploy.ts`, `scripts/verify-deployment.ts`,
   `scripts/export-addresses.ts`, and `scripts/verify-etherscan.ts` together.
2. Make sure `test/e2e/DeploymentScriptIntegration.test.ts` still passes — that
   test exercises the real deploy script and is our smoke test for "deploy will
   work on testnet".
3. Add or update the relevant per-network entry in `deployments/` when an
   actual chain is re-deployed.

## Releasing

Releases are cut by maintainers. If you're a maintainer, the flow is:

1. Bump `version` in `package.json` and `@enclaves/encl`'s if it moved.
2. Tag `vX.Y.Z` after the merge.
3. Deploy + verify on the target network (Sepolia first; mainnet only after a
   green Sepolia run-through).
4. Commit the resulting `deployments/<network>.json` in a follow-up PR.
