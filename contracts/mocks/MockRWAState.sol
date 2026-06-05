// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {IEnclavesRWA} from "../interfaces/IEnclavesRWA.sol";

/**
 * @title MockRWAState
 * @notice Test helper exposing the minimal {IEnclavesRWA} surface that
 *         {StakingBond} reads — `assetState`, `issuer`, `trustClass` and
 *         `assetValuation` — so the bond lifecycle can be exercised in
 *         isolation without standing up the full ERC-3643 stack.
 */
contract MockRWAState {
    IEnclavesRWA.AssetState public assetState = IEnclavesRWA.AssetState.Registered;
    address public issuer;
    uint8 public trustClass;
    uint256 public assetValuation;

    function setState(IEnclavesRWA.AssetState s) external {
        assetState = s;
    }

    /// @notice Configure the bond-relevant profile the StakingBond reads.
    function setProfile(address issuer_, uint8 trustClass_, uint256 assetValuation_) external {
        issuer = issuer_;
        trustClass = trustClass_;
        assetValuation = assetValuation_;
    }
}
