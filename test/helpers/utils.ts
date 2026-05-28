/**
 * Test utilities — bytes / time / EVM helpers shared by every test file.
 */

import { ethers, network } from 'hardhat';

/**
 * keccak256 of the UTF-8 encoding of a string. Mirrors `ethers.utils.id`
 * from ethers v5 and `solidityKeccak256(['string'], [s])` — used wherever
 * the contracts use `keccak256(abi.encodePacked("..."))` to derive an
 * enclave id, kind, currency code, etc.
 */
export const k = (s: string): string => ethers.id(s);

/**
 * Pad a short ASCII / UTF-8 string into a 32-byte right-aligned hex
 * string. Production code always uses fixed bytes32 identifiers; tests
 * call this to mint disposable ones. Strings must fit in 31 bytes
 * (ethers enforces the limit).
 */
export const toBytes32 = (s: string): string => ethers.encodeBytes32String(s);

/** Convert a whole-token amount to its 18-decimal wei representation. */
export const toEth = (n: number | string | bigint): bigint =>
  ethers.parseEther(n.toString());

/** Convert a whole-USDC amount to its 6-decimal representation. */
export const toUSDC = (n: number | string | bigint): bigint =>
  ethers.parseUnits(n.toString(), 6);

/** Latest block timestamp on the test chain. */
export async function latestTime(): Promise<number> {
  const block = await ethers.provider.getBlock('latest');
  if (!block) throw new Error('no latest block');
  return Number(block.timestamp);
}

/** Advance the Hardhat Network clock by `seconds` and mine one block. */
export async function advanceTime(seconds: number): Promise<void> {
  await network.provider.send('evm_increaseTime', [seconds]);
  await network.provider.send('evm_mine', []);
}

export async function advanceTo(timestamp: number): Promise<void> {
  const now = await latestTime();
  if (timestamp > now) await advanceTime(timestamp - now);
}

export async function snapshot(): Promise<string> {
  return (await network.provider.send('evm_snapshot', [])) as string;
}

export async function revert(id: string): Promise<unknown> {
  return network.provider.send('evm_revert', [id]);
}

/**
 * Best-effort EVM revert-reason extractor for ethers-v6 errors. Tests
 * generally use `expect(...).to.be.revertedWith(...)` from
 * @nomicfoundation/hardhat-chai-matchers, but this remains useful for
 * the rare case where the assertion library can't decode the reason and
 * we want to inspect it directly in a test.
 */
export function revertReason(err: unknown): string {
  if (!err) return '';
  const e = err as {
    reason?: string;
    shortMessage?: string;
    message?: string;
    data?: string;
  };
  if (e.reason) return e.reason;
  if (e.shortMessage) {
    const m = e.shortMessage.match(/reverted with reason string '(.+)'/);
    if (m) return m[1];
    return e.shortMessage;
  }
  const m = String(e.message || err).match(
    /revert(?:\s+with\s+reason\s+'(.*)')?(?::\s+([^\n]+))?/
  );
  if (m) return m[1] || m[2] || '';
  return String(e.message || err);
}
