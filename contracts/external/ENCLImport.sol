// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.17;

// solhint-disable-next-line no-unused-import
import {ENCL} from "@enclaves/encl/contracts/ENCL.sol";

/**
 * @dev Compile-time hook only — the ENCL token lives in its own repository
 *      (`@enclaves/encl`). This shim exists so that Hardhat's compiler
 *      walks into the dependency package, compiles `ENCL.sol`, and emits
 *      an `artifacts/@enclaves/encl/contracts/ENCL.sol/ENCL.json` artifact
 *      that this project's tests and deploy scripts (via
 *      `ethers.getContractFactory('ENCL')`) can resolve.
 *
 *      Do NOT add functionality here. Edit the canonical source at
 *      `@enclaves/encl/contracts/ENCL.sol`.
 */
