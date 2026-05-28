# Security Policy

The contracts in this repository custody real-world-asset value once deployed.
We take vulnerability reports seriously and will respond promptly.

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Two equivalent private channels — pick whichever you prefer:

1. **GitHub Private Vulnerability Reporting** (preferred when you have a
   GitHub account). On this repository, open `Security → Report a
   vulnerability` to file a private advisory that only the maintainers
   can see. See [GitHub's docs][gh-pvr] for the contributor side.
2. **Email** `security@enclaves.io`. Encrypt sensitive details with
   our PGP key (available on request).

Either way, include:

1. A description of the issue and its impact
2. Reproduction steps or a minimal proof of concept
3. Suggested remediation, if you have one
4. Your contact for follow-up (optional)

[gh-pvr]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

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
Public auditability is additional, not a replacement, for paid review.

## Operational security expectations

These are how *we* operate the repository, documented so contributors know what
to expect — and so that any deviation is visible.

- **Deploy keys live elsewhere.** Deployment scripts in this repo never embed
  mnemonics, private keys, or authenticated RPC URLs. The real deployer keys
  are held by a multisig under separate, locked-down infrastructure. Any
  on-chain admin action (`registerImplementation`, `setRequiredBondBps`,
  `seize`, role rotation) goes through that multisig. If you see a commit
  landing a `.env`, `mnemonic`, or `PRIVATE_KEY` value, treat it as a
  confirmed leak: rotate immediately and assume git history is forever
  (force-push history rewrites do not help once forks exist).
- **Every PR is read in full by two people**, regardless of how long the
  contributor has been around. Long-game contributors building reputation
  over months before slipping in a backdoor is a real threat against
  high-value token repos; the only reliable countermeasure is treating
  every diff as if it were from a stranger.
- **Branch protection on `main` requires** PR review by a code owner,
  passing required status checks (test / lint / typecheck / coverage /
  Slither), signed commits, linear history, up-to-date branches, and no
  admin bypass. The point of "include administrators" is to defend
  against a compromised maintainer account, not to make rules optional
  for the trusted few.
- **GitHub Actions are pinned to commit SHAs**, never to movable tags
  like `@v4`. Dependabot proposes bumps; humans read each diff before
  merging. This is direct mitigation for the tag-rewrite supply-chain
  attacks that have hit the wider ecosystem.
- **Maintainer accounts require hardware-key 2FA** (FIDO/U2F, e.g.
  YubiKey). SMS-based 2FA is not permitted for any account with write
  access. Personal Access Tokens are scoped minimally and expire within
  90 days.

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
