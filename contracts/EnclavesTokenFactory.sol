// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IEnclavesRWA} from "./interfaces/IEnclavesRWA.sol";

/**
 * @title EnclavesTokenFactory
 * @notice Per-Enclave factory + on-chain registry. Cheap deployments via
 *         EIP-1167 minimal proxy clones over registered implementations.
 *
 *         Per the spec, the indexer enumerates `allTokens` and queries each
 *         token's view functions to compute TVL. This contract is the
 *         canonical source-of-truth for the set of tokens issued under an
 *         Enclave.
 */
contract EnclavesTokenFactory is AccessControl {
    using Clones for address;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

    // =====================================================================
    // Enclave-level wiring (shared across every token deployed here)
    // =====================================================================

    bytes32 public immutable enclaveId;
    address public identityRegistry;
    address public compliance;
    address public stakingBond;
    address public platformAgent;

    // =====================================================================
    // Implementation registry — one per contract kind (on-chain dispatch)
    // =====================================================================

    /// @notice Lookup map from a `contractKind` hash (e.g. keccak256 of
    ///         "REAL_ESTATE", "BIOMASS") to its registered implementation.
    ///         The `contractKind` hash is the canonical on-chain dispatch key
    ///         for all RWA category extensions.
    mapping(bytes32 => address) public implementations;

    // =====================================================================
    // Token registry
    // =====================================================================

    struct TokenRecord {
        address tokenAddress;
        bytes32 enclaveId;
        address issuer;
        address spvOperator;
        bytes32 spvEntityId;
        uint8 trustClass;
        /// On-chain dispatch key — `keccak256(toUtf8Bytes(KIND_STRING))`.
        bytes32 contractKind;
        bytes32 denominationCurrency;
        uint64 deployedAt;
    }

    mapping(address => TokenRecord) public tokenRegistry;
    address[] public allTokens;

    mapping(bytes32 => address[]) public tokensByEnclave;
    mapping(address => address[]) public tokensByIssuer;
    mapping(address => address[]) public tokensBySPV;
    /// @notice Lookup map from a `contractKind` hash to the tokens deployed
    ///         under that kind.
    mapping(bytes32 => address[]) public tokensByContractKind;

    // =====================================================================
    // Events
    // =====================================================================

    event ImplementationRegistered(bytes32 indexed contractKind, address indexed impl);
    event ImplementationUnregistered(bytes32 indexed contractKind);
    event TokenDeployed(
        address indexed token,
        bytes32 indexed enclaveId,
        bytes32 indexed contractKind,
        address issuer,
        address spvOperator
    );
    event IdentityRegistryChanged(address indexed prev, address indexed next);
    event ComplianceChanged(address indexed prev, address indexed next);
    event StakingBondChanged(address indexed prev, address indexed next);
    event PlatformAgentChanged(address indexed prev, address indexed next);

    // =====================================================================
    // Init
    // =====================================================================

    constructor(
        bytes32 enclaveId_,
        address identityRegistry_,
        address compliance_,
        address stakingBond_,
        address platformAgent_,
        address admin_
    ) {
        require(identityRegistry_ != address(0), "bad ir");
        require(compliance_ != address(0), "bad compliance");
        require(stakingBond_ != address(0), "bad staking");
        require(platformAgent_ != address(0), "bad agent");

        enclaveId = enclaveId_;
        identityRegistry = identityRegistry_;
        compliance = compliance_;
        stakingBond = stakingBond_;
        platformAgent = platformAgent_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(DEPLOYER_ROLE, admin_);
    }

    // =====================================================================
    // Admin wiring
    // =====================================================================

    function setIdentityRegistry(address ir) external onlyRole(ADMIN_ROLE) {
        emit IdentityRegistryChanged(identityRegistry, ir);
        identityRegistry = ir;
    }

    function setCompliance(address c) external onlyRole(ADMIN_ROLE) {
        emit ComplianceChanged(compliance, c);
        compliance = c;
    }

    function setStakingBond(address s) external onlyRole(ADMIN_ROLE) {
        emit StakingBondChanged(stakingBond, s);
        stakingBond = s;
    }

    function setPlatformAgent(address a) external onlyRole(ADMIN_ROLE) {
        emit PlatformAgentChanged(platformAgent, a);
        platformAgent = a;
    }

    // =====================================================================
    // Implementation management
    // =====================================================================

    function registerImplementation(bytes32 contractKind, address impl)
        external
        onlyRole(ADMIN_ROLE)
    {
        require(impl != address(0), "bad impl");
        implementations[contractKind] = impl;
        emit ImplementationRegistered(contractKind, impl);
    }

    function unregisterImplementation(bytes32 contractKind) external onlyRole(ADMIN_ROLE) {
        delete implementations[contractKind];
        emit ImplementationUnregistered(contractKind);
    }

    // =====================================================================
    // Deployment
    // =====================================================================

    struct DeployRequest {
        /// On-chain implementation dispatch key (formerly `assetCategory`).
        bytes32 contractKind;
        address issuer;
        address spvOperator;
        bytes32 spvEntityId;
        uint8 trustClass;
        bytes32 denominationCurrency;
        bytes32 salt;
        bytes initData; // ABI-encoded call to the implementation's initialize(...)
    }

    /**
     * @notice Clone the implementation for `req.contractKind` and call
     *         `req.initData` on it. The init payload MUST already encode the
     *         identity-registry / compliance / staking-bond / platform-agent
     *         addresses (typically built from this factory's storage).
     */
    function deploy(DeployRequest calldata req) external onlyRole(DEPLOYER_ROLE) returns (address) {
        address impl = implementations[req.contractKind];
        require(impl != address(0), "no implementation");

        address token = impl.cloneDeterministic(req.salt);

        // solhint-disable-next-line avoid-low-level-calls
        (bool ok, bytes memory ret) = token.call(req.initData);
        if (!ok) {
            // Bubble up the revert reason from the implementation.
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }

        TokenRecord memory rec = TokenRecord({
            tokenAddress: token,
            enclaveId: enclaveId,
            issuer: req.issuer,
            spvOperator: req.spvOperator,
            spvEntityId: req.spvEntityId,
            trustClass: req.trustClass,
            contractKind: req.contractKind,
            denominationCurrency: req.denominationCurrency,
            deployedAt: uint64(block.timestamp)
        });
        tokenRegistry[token] = rec;
        allTokens.push(token);
        tokensByEnclave[enclaveId].push(token);
        tokensByIssuer[req.issuer].push(token);
        tokensBySPV[req.spvOperator].push(token);
        tokensByContractKind[req.contractKind].push(token);

        emit TokenDeployed(token, enclaveId, req.contractKind, req.issuer, req.spvOperator);

        return token;
    }

    function predictDeployment(bytes32 contractKind, bytes32 salt) external view returns (address) {
        address impl = implementations[contractKind];
        if (impl == address(0)) return address(0);
        return Clones.predictDeterministicAddress(impl, salt, address(this));
    }

    // =====================================================================
    // Registry views
    // =====================================================================

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    function tokensByEnclaveLength(bytes32 e) external view returns (uint256) {
        return tokensByEnclave[e].length;
    }

    function getTokensByIssuer(address issuer_) external view returns (address[] memory) {
        return tokensByIssuer[issuer_];
    }

    function getTokensBySPV(address spv) external view returns (address[] memory) {
        return tokensBySPV[spv];
    }

    function getTokensByContractKind(bytes32 contractKind) external view returns (address[] memory) {
        return tokensByContractKind[contractKind];
    }
}
