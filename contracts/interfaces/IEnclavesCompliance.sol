// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

/**
 * @title IEnclavesCompliance
 * @notice External surface of the per-Enclave compliance module that
 *         {EnclavesRWA} consults on every mint, burn and transfer.
 * @dev    The compliance module is shared across every token deployed under
 *         the same Enclave. The token contract calls the canonical T-REX
 *         hooks (`canTransfer` / `transferred` / `created` / `destroyed`)
 *         while integrators that speak the Securitize DS Protocol can use
 *         the explicit `preTransferCheck` reason-code surface.
 */
interface IEnclavesCompliance {
    // ---------------------------------------------------------------------
    // ERC-3643 / T-REX modular-compliance hooks
    // ---------------------------------------------------------------------

    function canTransfer(address from, address to, uint256 amount, address token)
        external
        view
        returns (bool);

    function transferred(address from, address to, uint256 amount) external;

    function created(address to, uint256 amount) external;

    function destroyed(address from, uint256 amount) external;

    // ---------------------------------------------------------------------
    // Securitize / DS-Protocol compatible pre-transfer check
    // ---------------------------------------------------------------------

    /// @return code   0 = valid; non-zero = rejection reason.
    /// @return reason Human-readable explanation matching `code`.
    function preTransferCheck(address from, address to, uint256 amount, address token)
        external
        view
        returns (uint256 code, string memory reason);

    // ---------------------------------------------------------------------
    // Investor-level counts (ONCHAINID, not wallet)
    // ---------------------------------------------------------------------

    function totalInvestorCount(address token) external view returns (uint256);

    function holderCountByCountry(address token, uint16 country) external view returns (uint256);
}
