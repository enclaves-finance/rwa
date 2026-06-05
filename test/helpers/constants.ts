import { k } from './utils';

export const ENCLAVE_ID: string = k('ENCLAVE_TEST');

/**
 * On-chain dispatch keys hashed into the bytes32 keys registered on
 * `EnclavesTokenFactory.implementations`. The same hashing convention is
 * used wherever a contract kind needs to be passed across the
 * off-chain ↔ on-chain boundary.
 */
export const CONTRACT_KIND = {
  BIOMASS: k('BIOMASS'),
  REAL_ESTATE: k('REAL_ESTATE'),
  PRECIOUS_METALS: k('PRECIOUS_METALS'),
  SECURITIES: k('SECURITIES'),
  COLLECTIBLES: k('COLLECTIBLES'),
} as const;

// ISO 3166-1 numeric country codes — the values the platform pushes into
// the IdentityRegistry's `investorCountry` field.
export const COUNTRY = {
  NA: 516, // Namibia
  US: 840,
  GB: 826,
  DE: 276,
  CH: 756,
  JP: 392,
  SG: 702,
} as const;

export const TRUST_CLASS = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 } as const;

// Mirrors `enum AssetState` in EnclavesRWA.sol.
export const STATE = {
  REGISTERED: 0,
  MINT_READY: 1,
  ACTIVE: 2,
  SUSPENDED: 3,
  REDEEMING: 4,
  RETIRED: 5,
} as const;

// Reason codes returned by EnclavesRWA.preTransferCheck.
export const REASON = {
  OK: 0,
  PAUSED: 1,
  SENDER_NOT_VERIFIED: 2,
  RECIPIENT_NOT_VERIFIED: 3,
  COMPLIANCE_REJECTED: 4,
  INSUFFICIENT_BALANCE: 5,
  LOCKUP_ACTIVE: 6,
  SENDER_FROZEN: 7,
  RECIPIENT_FROZEN: 8,
} as const;

// Reason codes returned by EnclavesCompliance.preTransferCheck (start at 10).
export const COMPLIANCE_REASON = {
  SENDER_NOT_APPROVED: 10,
  RECIPIENT_NOT_APPROVED: 11,
  COUNTRY_NOT_ALLOWED: 12,
  BELOW_MIN: 13,
  EXCEEDS_MAX_BALANCE: 14,
  COUNTRY_HOLDER_CAP: 15,
} as const;

export const ENCL_PRICE_USD = '250000000000000000'; // $0.25 × 1e18

export const ENCL_TOTAL_SUPPLY = '1000000000'; // 1B ENCL (× 1e18 wei)

export const ZERO = '0x0000000000000000000000000000000000000000';
