/**
 * EIP-712 typed data definitions for Tangem7702GaslessExecutor gasless transactions.
 *
 * @notice These type definitions must match the Solidity canonical type strings exactly:
 *         - `Transaction(address to,uint256 value,bytes data)`
 *         - `Fee(address feeToken,uint256 maxTokenFee,uint256 coinPriceInToken,uint256 feeTransferGasLimit,uint256 baseGas)`
 *         - `GaslessTransaction(Transaction transaction,Fee fee,uint256 nonce)`
 * @dev Used with `ethers` TypedDataEncoder + `signTypedData`.
 *      Any mismatch (field name, type, or order) will change the digest and break signature verification.
 */
export const GASLESS_TYPES = {
  Transaction: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Fee: [
    { name: "feeToken", type: "address" },
    { name: "maxTokenFee", type: "uint256" },
    { name: "coinPriceInToken", type: "uint256" },
    { name: "feeTransferGasLimit", type: "uint256" },
    { name: "baseGas", type: "uint256" },
  ],
  GaslessTransaction: [
    { name: "transaction", type: "Transaction" },
    { name: "fee", type: "Fee" },
    { name: "nonce", type: "uint256" },
  ],
};

/**
 * Builds a `GaslessTransaction` object in the exact shape expected by `GASLESS_TYPES`.
 *
 * @notice Convenience helper for tests and offchain signing.
 * @dev Keep numeric fields as BigInt to align with ethers v6 behavior and avoid accidental
 *      number overflows or type coercion.
 *
 * @param {object} params Input parameters.
 * @param {string} params.to Target contract address.
 * @param {bigint} params.value Native coin amount (wei) sent with the call.
 * @param {string} params.data ABI-encoded calldata for the target call.
 * @param {string} params.feeToken ERC-20 token address used to pay the fee.
 * @param {bigint} params.maxTokenFee Maximum fee amount (in `feeToken` smallest units).
 * @param {bigint} params.coinPriceInToken Price of 1 ether expressed in `feeToken` smallest units.
 * @param {bigint} params.feeTransferGasLimit Gas limit budget allocated for the fee token transfer.
 * @param {bigint} params.baseGas Fixed gas overhead added to the measured gas for fee calculation.
 * @param {bigint} params.nonce Sequential nonce used for replay protection.
 * @return {object} gaslessTx Gasless transaction payload compatible with `ethers` typed data signing.
 */
export function makeGaslessTx({
  to,
  value,
  data,
  feeToken,
  maxTokenFee,
  coinPriceInToken,
  feeTransferGasLimit,
  baseGas,
  nonce,
}) {
  return {
    transaction: { to, value, data },
    fee: { feeToken, maxTokenFee, coinPriceInToken, feeTransferGasLimit, baseGas },
    nonce,
  };
}

/**
 * Signs a `GaslessTransaction` using EIP-712 and returns both the signature and digest.
 *
 * @notice The domain must match the executor contract exactly:
 *         - name: "Tangem7702GaslessExecutor"
 *         - version: "1"
 *         - chainId: current network chain id
 *         - verifyingContract: address where the executor code is running
 * @dev In this system, the contract verifies `ECDSA.recover(digest, signature) == address(this)`.
 *      When testing EIP-7702 delegated execution, `verifyingContract` should be the delegated EOA address
 *      (i.e., the address that will execute the code and be equal to `address(this)` on-chain).
 *
 * @param {object} params Input parameters.
 * @param {object} params.conn Hardhat v3 network connection from `await hre.network.connect()`.
 * @param {import("ethers").Signer} params.executorSigner Signer used to produce the EIP-712 signature.
 * @param {string} params.executorAddress Verifying contract address for the domain (usually the executor EOA address in tests).
 * @param {object} params.gaslessTx The typed data message to sign (must match `GASLESS_TYPES`).
 * @return {Promise<{signature: string, digest: string}>} result
 * @return {string} result.signature EIP-712 signature over the typed data digest.
 * @return {string} result.digest The EIP-712 digest computed offchain (useful for asserting emitted values).
 */
export async function signGaslessTx({ conn, executorSigner, executorAddress, gaslessTx }) {
  const { ethers } = conn;
  const { chainId } = await ethers.provider.getNetwork();

  const domain = {
    name: "Tangem7702GaslessExecutor",
    version: "1",
    chainId,
    verifyingContract: executorAddress,
  };

  const signature = await executorSigner.signTypedData(domain, GASLESS_TYPES, gaslessTx);
  const digest = ethers.TypedDataEncoder.hash(domain, GASLESS_TYPES, gaslessTx);

  return { signature, digest };
}