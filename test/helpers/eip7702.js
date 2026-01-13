/**
 * Builds EIP-7702 delegation designator bytecode for a delegated EOA.
 *
 * @notice This is the special "delegation designator" format used by EIP-7702:
 *         `0xef0100 || <20-byte delegate address>`.
 * @dev The returned value is a hex string that can be installed as account code in a local
 *      test environment to make `EIP7702Utils.fetchDelegate()` resolve the delegate address.
 *      This helper is meant for tests only.
 *
 * @param {object} ethers The `ethers` instance from the Hardhat v3 network connection.
 * @param {string} delegate The delegate (implementation) contract address.
 * @return {string} code Hex string representing the delegation designator code.
 */
export function delegationDesignatorCode(ethers, delegate) {
  // Normalize and checksum the address, then strip the 0x prefix to append as raw bytes.
  const normalized = ethers.getAddress(delegate).slice(2);

  // EIP-7702 delegation designator: 0xef0100 || address.
  // Prefix 0xef0100 is fixed; the remaining 20 bytes are the delegate address.
  return `0xef0100${normalized}`;
}

/**
 * Installs an EIP-7702 delegate on an EOA in the local Hardhat network.
 *
 * @notice Simulates EIP-7702 delegation for tests by overwriting the account's code with
 *         the EIP-7702 delegation designator (`0xef0100 || delegate`).
 * @dev This does NOT send an actual EIP-7702 authorization transaction. Instead, it uses
 *      Hardhat Network Helpers `setCode` to directly modify the local chain state.
 *      Use only in tests. Make sure `conn` is the same connection used by your fixtures/tests,
 *      otherwise the code may be set in a different simulated network instance.
 *
 * @param {object} conn Hardhat v3 network connection from `await hre.network.connect()`.
 * @param {string} executorAddress The EOA address that should behave as a delegated executor.
 * @param {string} delegateAddress The implementation contract address to delegate to.
 * @return {Promise<void>}
 */
export async function set7702Delegate(conn, executorAddress, delegateAddress) {
  // Pull ethers + helpers from the same connection used by the tests.
  const { ethers, networkHelpers } = conn;

  // Overwrite executor's code with the EIP-7702 delegation designator.
  await networkHelpers.setCode(
    executorAddress,
    delegationDesignatorCode(ethers, delegateAddress)
  );
}