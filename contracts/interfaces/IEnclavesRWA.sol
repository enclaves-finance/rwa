// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

/**
 * @title IEnclavesRWA
 * @notice The portable, indexer-friendly view surface of an EnclavesRWA token.
 *         Aggregators (DeFi Llama, RWA.xyz) and the platform indexer compute
 *         TVL by enumerating tokens via the factory and querying these getters.
 */
interface IEnclavesRWA {
    enum AssetState {
        Registered,
        MintReady,
        Active,
        Suspended,
        Redeeming,
        Retired
    }

    // ---------------------------------------------------------------------
    // Asset identity & profile
    // ---------------------------------------------------------------------

    function enclaveId() external view returns (bytes32);
    function jurisdiction() external view returns (bytes32);
    function issuer() external view returns (address);
    function trustClass() external view returns (uint8);
    /// @notice On-chain dispatch key — see EnclavesTokenFactory.implementations.
    ///         Renamed from `assetCategory` when the platform split UX
    ///         classification from on-chain dispatch.
    function contractKind() external view returns (bytes32);
    function metadataURI() external view returns (string memory);

    // ---------------------------------------------------------------------
    // SPV identification
    // ---------------------------------------------------------------------

    function spvOperator() external view returns (address);
    function spvEntityId() external view returns (bytes32);
    function spvJurisdiction() external view returns (bytes32);
    function spvLegalStructure() external view returns (bytes32);
    function spvRegistryId() external view returns (bytes32);

    // ---------------------------------------------------------------------
    // Supply lifecycle
    // ---------------------------------------------------------------------

    function maxSupply() external view returns (uint256);
    function totalIssued() external view returns (uint256);
    function mintFinalized() external view returns (bool);
    function assetState() external view returns (AssetState);
    function isMintReady() external view returns (bool);
    function remainingSupply() external view returns (uint256);

    // ---------------------------------------------------------------------
    // Valuation (drives TVL crawlers)
    // ---------------------------------------------------------------------

    function assetValuation() external view returns (uint256);
    function denominationCurrency() external view returns (bytes32);
    function valuationTimestamp() external view returns (uint64);
    function valuationMethodology() external view returns (bytes32);

    // ---------------------------------------------------------------------
    // Holders / investors
    // ---------------------------------------------------------------------

    function holderCount() external view returns (uint256);
    function holderAt(uint256 index) external view returns (address);
    function isHolder(address account) external view returns (bool);
    function balanceOfInvestor(address identityContract) external view returns (uint256);
    function investorCount() external view returns (uint256);

    // ---------------------------------------------------------------------
    // ERC-3643-style transfer pre-check (Securitize DS-Protocol compatible)
    // ---------------------------------------------------------------------

    function canTransfer(address from, address to, uint256 amount) external view returns (bool);

    function preTransferCheck(address from, address to, uint256 amount)
        external
        view
        returns (uint256 code, string memory reason);
}
