// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

/**
 * @title IIdentityRegistry
 * @notice Subset of the T-REX IdentityRegistry that the EnclavesRWA suite
 *         consumes. Kept narrow so we can swap in a mock during unit tests.
 */
interface IIdentityRegistry {
    function isVerified(address userAddress) external view returns (bool);

    function identity(address userAddress) external view returns (address);

    function investorCountry(address userAddress) external view returns (uint16);
}
