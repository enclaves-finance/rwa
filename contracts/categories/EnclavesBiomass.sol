// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

import {EnclavesRWA} from "../EnclavesRWA.sol";

/**
 * @title EnclavesBiomass
 * @notice Category extension for biomass / agricultural / carbon-rights
 *         tokens. Generalisable to any time-bounded, royalty-bearing
 *         biomass right (encroacher-bush biochar, forestry carbon credits,
 *         agroforestry yields, etc.).
 *
 *         On-chain we record:
 *           - immutable land facts (registry ref, total hectares, biomass
 *             type, certification standard, country / region)
 *           - the farm allocations that make up the total hectarage
 *           - the revenue rights window (start / end)
 *           - product revenue rates (biochar, wood-vinegar) — updatable via
 *             governed platform calls
 *           - production reports — submitted quarterly, feed yield distribution
 *           - rolling impact metrics
 *           - the minimum raise gate that prevents revenue distribution
 *             from starting until the raise threshold is met
 */
contract EnclavesBiomass is EnclavesRWA {
    // =====================================================================
    // Immutable biomass facts (set once during initialization)
    // =====================================================================

    bytes32 public landRegistryRef;
    uint256 public totalHectares;
    uint256 public hectaresPerToken;
    bytes32 public biomassType;
    bytes32 public certificationStandard;
    bytes32 public countryCode;
    bytes32 public regionCode;

    struct FarmAllocation {
        bytes32 farmId;
        string farmName;
        uint256 hectares;
        int64 latitude; // scaled by 1e6
        int64 longitude; // scaled by 1e6
        bytes32 region;
    }

    FarmAllocation[] internal _farms;

    // =====================================================================
    // Revenue parameters
    // =====================================================================

    uint64 public revenueStartDate;
    uint64 public revenueEndDate;

    // USD cents per unit. Updatable through governed platform call.
    uint256 public biocharRatePerTon;
    uint256 public woodVinegarRatePerLitre;

    uint64 public distributionFrequency; // seconds (e.g. 7776000 = 90 days)

    // =====================================================================
    // Production reports
    // =====================================================================

    struct ProductionReport {
        uint256 period;
        uint256 biocharTons;
        uint256 woodVinegarLitres;
        uint256 revenueGenerated; // USD (lowest denomination, e.g. cents)
        bytes32 reportHash; // IPFS / Arweave CID hash
        uint64 reportedAt;
        bool verified;
    }

    mapping(uint256 => ProductionReport) public productionReports;
    uint256 public latestProductionPeriod;

    // =====================================================================
    // Impact metrics
    // =====================================================================

    struct ImpactMetrics {
        uint256 totalBushClearedTons;
        uint256 totalCarbonRemovedTons;
        uint256 totalHectaresRestored;
        bytes32 latestImpactReportHash;
        uint64 lastUpdated;
    }

    ImpactMetrics public impact;

    // =====================================================================
    // Minimum-raise gate
    // =====================================================================

    uint256 public minimumRaiseAmount;
    bool public minimumRaiseMet;

    // =====================================================================
    // Events
    // =====================================================================

    event FarmAllocated(bytes32 indexed farmId, string name, uint256 hectares);
    event RevenueRatesUpdated(uint256 biocharRatePerTon, uint256 woodVinegarRatePerLitre);
    event ProductionReportSubmitted(
        uint256 indexed period, uint256 biocharTons, uint256 woodVinegarLitres, uint256 revenue
    );
    event ProductionReportVerified(uint256 indexed period);
    event ImpactMetricsUpdated(
        uint256 bushClearedTons, uint256 carbonRemovedTons, uint256 hectaresRestored
    );
    event MinimumRaiseMet(uint256 amount);

    // =====================================================================
    // Initialization
    // =====================================================================

    struct BiomassInit {
        bytes32 landRegistryRef;
        uint256 totalHectares;
        uint256 hectaresPerToken;
        bytes32 biomassType;
        bytes32 certificationStandard;
        bytes32 countryCode;
        bytes32 regionCode;
        FarmAllocation[] farms;
        uint64 revenueStartDate;
        uint64 revenueEndDate;
        uint256 biocharRatePerTon;
        uint256 woodVinegarRatePerLitre;
        uint64 distributionFrequency;
        uint256 minimumRaiseAmount;
    }

    /// @notice One-shot initializer used by the factory after cloning.
    function initialize(InitParams calldata base, BiomassInit calldata b) external initializer {
        __EnclavesRWA_init(base);

        landRegistryRef = b.landRegistryRef;
        totalHectares = b.totalHectares;
        hectaresPerToken = b.hectaresPerToken;
        biomassType = b.biomassType;
        certificationStandard = b.certificationStandard;
        countryCode = b.countryCode;
        regionCode = b.regionCode;

        uint256 hectareSum;
        for (uint256 i = 0; i < b.farms.length; ++i) {
            _farms.push(b.farms[i]);
            hectareSum += b.farms[i].hectares;
            emit FarmAllocated(b.farms[i].farmId, b.farms[i].farmName, b.farms[i].hectares);
        }
        require(hectareSum == b.totalHectares, "farm hectares mismatch totalHectares");

        revenueStartDate = b.revenueStartDate;
        revenueEndDate = b.revenueEndDate;
        biocharRatePerTon = b.biocharRatePerTon;
        woodVinegarRatePerLitre = b.woodVinegarRatePerLitre;
        distributionFrequency = b.distributionFrequency;
        minimumRaiseAmount = b.minimumRaiseAmount;
    }

    // =====================================================================
    // Views
    // =====================================================================

    function farmCount() external view returns (uint256) {
        return _farms.length;
    }

    function farmAt(uint256 index) external view returns (FarmAllocation memory) {
        return _farms[index];
    }

    function getFarms() external view returns (FarmAllocation[] memory) {
        return _farms;
    }

    // =====================================================================
    // Platform actions
    // =====================================================================

    function setRevenueRates(uint256 newBiocharRatePerTon, uint256 newVinegarRatePerLitre)
        external
        onlyPlatform
    {
        biocharRatePerTon = newBiocharRatePerTon;
        woodVinegarRatePerLitre = newVinegarRatePerLitre;
        emit RevenueRatesUpdated(newBiocharRatePerTon, newVinegarRatePerLitre);
    }

    function submitProductionReport(
        uint256 period,
        uint256 biocharTons,
        uint256 vinegarLitres,
        uint256 revenue,
        bytes32 reportHash
    ) external onlyPlatform {
        require(period > latestProductionPeriod || latestProductionPeriod == 0, "period regress");
        productionReports[period] = ProductionReport({
            period: period,
            biocharTons: biocharTons,
            woodVinegarLitres: vinegarLitres,
            revenueGenerated: revenue,
            reportHash: reportHash,
            reportedAt: uint64(block.timestamp),
            verified: false
        });
        if (period > latestProductionPeriod) latestProductionPeriod = period;
        emit ProductionReportSubmitted(period, biocharTons, vinegarLitres, revenue);
    }

    function verifyProductionReport(uint256 period) external onlyPlatform {
        require(productionReports[period].reportedAt != 0, "no report");
        productionReports[period].verified = true;
        emit ProductionReportVerified(period);
    }

    function updateImpactMetrics(
        uint256 bushClearedTons,
        uint256 carbonRemovedTons,
        uint256 hectaresRestored,
        bytes32 reportHash
    ) external onlyPlatform {
        impact.totalBushClearedTons = bushClearedTons;
        impact.totalCarbonRemovedTons = carbonRemovedTons;
        impact.totalHectaresRestored = hectaresRestored;
        impact.latestImpactReportHash = reportHash;
        impact.lastUpdated = uint64(block.timestamp);
        emit ImpactMetricsUpdated(bushClearedTons, carbonRemovedTons, hectaresRestored);
    }

    function setMinimumRaiseMet() external onlyPlatform {
        minimumRaiseMet = true;
        emit MinimumRaiseMet(minimumRaiseAmount);
    }

    // Future biomass-specific transfer overrides (e.g. maturity gating)
    // belong on subclasses; the base contract already enforces every
    // ERC-3643 invariant.
}
