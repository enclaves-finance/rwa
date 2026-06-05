// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

/**
 * @title IStakingBond
 * @notice Minimal surface that {EnclavesRWA} uses to verify the issuer's
 *         ENCL bond at mint time.
 */
interface IStakingBond {
    /// @notice Returns true iff `token` currently has an active, fully-funded bond.
    function isBonded(address token) external view returns (bool);

    /// @notice ENCL required to bond `assetValueUsd` worth of `trustClass`.
    function getRequiredStake(uint8 trustClass, uint256 assetValueUsd)
        external
        view
        returns (uint256);
}
