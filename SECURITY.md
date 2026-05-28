# Security Policy

The contracts in this repository custody real-world-asset value once deployed.
We take vulnerability reports seriously and will respond promptly.

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Email **security@enclaves.io** with:

1. A description of the issue and its impact
2. Reproduction steps or a minimal proof of concept
3. Suggested remediation, if you have one
4. Your contact for follow-up (optional)

Encrypt sensitive details with our PGP key (available on request).

### What to expect

- Acknowledgement within **48 hours**
- Initial triage assessment within **5 business days**
- For confirmed issues, a private patch and a coordinated disclosure timeline
- Public credit (if you wish) in the release notes once a fix ships

## Scope

### In scope

- Every contract under `contracts/` (RWA base, category extensions, compliance,
  factory, staking bond, yield distributor, redemption escrow)
- Deploy / verify scripts under `scripts/`
- The mint-authorisation gate, snapshot mechanism, frozen-address path,
  pause / seize controls, and lifecycle state machine
- Build-pipeline issues that affect what bytecode ends up on chain

### Out of scope (for this repo)

- ERC-3643 / T-REX standard concerns — please report upstream
- The off-chain Enclaves platform (KYC, Trust Score, Document Vault, indexer,
  signing-service) — separate disclosure channel via the same email address
- `MockIdentityRegistry` (testing-only)
- Issues in third-party dependencies (please report upstream, then ping us)
- Best-practice nits without an exploit path — file these as regular issues

## Severity reference

We follow the [Immunefi severity classification](https://immunefi.com/severity-updated/)
as a reference:

| Severity | Examples |
|----------|----------|
| Critical | Direct theft of locked funds, permanent freeze of >50 % of TVL, bypass of mint or compliance authorisation, infinite mint |
| High     | Bypass of any single mint-authorisation condition, escape from snapshot accounting, double-claim in yield distribution |
| Medium   | Denial of service against retire / unbond, race conditions that block legitimate flows |
| Low / Informational | Gas griefing, event-only inconsistencies, documentation drift |

## Bounty

Bounty terms are handled case by case; high-impact reports affecting deployed
contracts are eligible for a reward proportional to severity.

## Audit history

These contracts have not yet undergone a third-party audit. Until they do, treat
production usage at your own risk and consider commissioning an audit before
non-trivial value is custodied behind any token deployed from this codebase.

## Known limitations

- The on-chain code is the enforcement layer; the platform is the policy layer.
  Many invariants ("only verified investors can hold", "country caps", etc.)
  depend on the Identity Registry and Compliance module being configured by a
  trusted operator. A misconfigured Enclave can still produce a compliant
  deployment that does not match a particular jurisdiction's rules — that is a
  platform-operator responsibility, not a contract bug.
- `EnclavesRWA.seize(...)` is intentionally a privileged operation for the
  platform agent. Compromise of the platform-agent key would let an attacker
  move tokens between any two verified addresses. Key custody is part of the
  platform's threat model, not this repository's.
