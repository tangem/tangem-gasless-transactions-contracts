/**
 * EIP-712 typed data definitions for Tangem7702GaslessExecutor gasless transactions.
 *
 * IMPORTANT:
 * Transaction struct MUST include `gasLimit` and match Solidity order exactly:
 * `Transaction(address to,uint256 value,uint256 gasLimit,bytes data)`
 */

const DEFAULT_CALL_GAS_LIMIT = 200_000n;

export const GASLESS_TYPES = {
  Transaction: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gasLimit", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Fee: [
    { name: "feeToken", type: "address" },
    { name: "maxTokenFee", type: "uint256" },
    { name: "coinPriceInToken", type: "uint256" },
    { name: "feeTransferGasLimit", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "feeReceiver", type: "address" },
  ],
  GaslessTransaction: [
    { name: "transaction", type: "Transaction" },
    { name: "fee", type: "Fee" },
    { name: "nonce", type: "uint256" },
  ],
};

export const GASLESS_BATCH_TYPES = {
  Transaction: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gasLimit", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Fee: [
    { name: "feeToken", type: "address" },
    { name: "maxTokenFee", type: "uint256" },
    { name: "coinPriceInToken", type: "uint256" },
    { name: "feeTransferGasLimit", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "feeReceiver", type: "address" },
  ],
  GaslessBatchTransaction: [
    { name: "transactions", type: "Transaction[]" },
    { name: "fee", type: "Fee" },
    { name: "nonce", type: "uint256" },
  ],
};

/**
 * Builds a GaslessTransaction in the exact shape expected by the onchain ABI and EIP-712 types.
 *
 * `gasLimit` defaults to a sane per-call value so old tests that don't pass it explicitly
 * continue to work after the struct upgrade.
 */
export function makeGaslessTx({
  to,
  value,
  gasLimit = DEFAULT_CALL_GAS_LIMIT,
  data,
  feeToken,
  maxTokenFee,
  coinPriceInToken,
  feeTransferGasLimit,
  baseGas,
  feeReceiver,
  nonce,
}) {
  return {
    transaction: { to, value, gasLimit, data },
    fee: {
      feeToken,
      maxTokenFee,
      coinPriceInToken,
      feeTransferGasLimit,
      baseGas,
      feeReceiver,
    },
    nonce,
  };
}

/**
 * Builds a GaslessBatchTransaction in the exact shape expected by the onchain ABI and EIP-712 types.
 *
 * Each batch item gets a default `gasLimit` when omitted to avoid null/undefined BigNumberish issues
 * in both ABI encoding and EIP-712 signing.
 */
export function makeGaslessBatchTx({
  transactions,
  feeToken,
  maxTokenFee,
  coinPriceInToken,
  feeTransferGasLimit,
  baseGas,
  feeReceiver,
  nonce,
}) {
  return {
    transactions: transactions.map((tx) => ({
      to: tx.to,
      value: tx.value,
      gasLimit: tx.gasLimit ?? DEFAULT_CALL_GAS_LIMIT,
      data: tx.data,
    })),
    fee: {
      feeToken,
      maxTokenFee,
      coinPriceInToken,
      feeTransferGasLimit,
      baseGas,
      feeReceiver,
    },
    nonce,
  };
}

/**
 * Signs a GaslessTransaction using EIP-712 and returns signature + digest.
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

/**
 * Signs a GaslessBatchTransaction using EIP-712 and returns signature + digest.
 */
export async function signGaslessBatchTx({ conn, executorSigner, executorAddress, gaslessBatchTx }) {
  const { ethers } = conn;
  const { chainId } = await ethers.provider.getNetwork();

  const domain = {
    name: "Tangem7702GaslessExecutor",
    version: "1",
    chainId,
    verifyingContract: executorAddress,
  };

  const signature = await executorSigner.signTypedData(domain, GASLESS_BATCH_TYPES, gaslessBatchTx);
  const digest = ethers.TypedDataEncoder.hash(domain, GASLESS_BATCH_TYPES, gaslessBatchTx);

  return { signature, digest };
}