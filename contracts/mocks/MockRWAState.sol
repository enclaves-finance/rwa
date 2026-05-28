// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {IEnclavesRWA} from "../interfaces/IEnclavesRWA.sol";

/**
 * @title MockRWAState
 * @notice Test helper that exposes the minimal {IEnclavesRWA.assetState()}
 *         getter so {StakingBond.unbond} can be exercised in isolation
 *         without standing up the full ERC-3643 stack.
 */
contract MockRWAState {
    IEnclavesRWA.AssetState public assetState = IEnclavesRWA.AssetState.Registered;

    function setState(IEnclavesRWA.AssetState s) external {
        assetState = s;
    }
}
