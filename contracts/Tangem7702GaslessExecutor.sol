// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";


// layout at keccak256(abi.encode(uint256(keccak256(bytes(tangem.storage.Tangem7702GaslessExecutor))) - 1)) & ~bytes32(uint256(0xff))
contract Tangem7702GaslessExecutor is EIP712 layout at 0x63126cb0ee213fd665c396acd692b9c0a13c8cc8bbd732af4f146bb546be9800 {
    using SafeERC20 for IERC20;

    // price is expressed as a price of 1 coin (ether) in smallest unit of token
    uint private constant PRICE_PRECISION = 1 ether;

    bytes32 private constant TRANSACTION_TYPEHASH = keccak256(
        "Transaction(address to,uint256 value,bytes data)"
    );
    bytes32 private constant FEE_TYPEHASH = keccak256(
        "Fee(address feeToken,uint256 maxTokenFee,uint256 coinPriceInToken,uint256 feeTransferGasLimit,uint256 baseGas)"
    );
    bytes32 private constant GASLESS_TRANSACTION_TYPEHASH = keccak256(
        bytes("GaslessTransaction(Transaction transaction,Fee fee,uint256 nonce)Fee(address feeToken,uint256 maxTokenFee,uint256 coinPriceInToken,uint256 feeTransferGasLimit,uint256 baseGas)Transaction(address to,uint256 value,bytes data)")
    );

    uint public nonce;

    event TransactionExecuted(GaslessTransaction gaslessTx); // TODO: what data do we need here? gaslessTx as a whole is mostly useless
    event FeeTransferProcessed(address indexed feeReceiver, address feeToken, uint feeAmount, uint totalGas);
    event FeeTransferGasLimitExceeded(uint gasLimit, uint gasUsed);

    constructor() EIP712("Tangem7702GaslessExecutor", "1") {}

    struct Transaction {
        address to;
        uint value;
        bytes data;
    }

    struct Fee {
        address feeToken;
        uint maxTokenFee;
        uint coinPriceInToken;
        uint feeTransferGasLimit;
        uint baseGas;
    }

    struct GaslessTransaction {
        Transaction transaction;
        Fee fee;
        uint nonce;
    }

    function executeTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature,
        address feeReceiver,
        bool forced
    ) external {
        require(
            IERC20(gaslessTx.fee.feeToken).balanceOf(address(this)) >= gaslessTx.fee.maxTokenFee,
            "GaslessExecutor: insufficent funds for fee"
        );
        _verifyGaslessTransaction(gaslessTx, signature);

        uint startGas = gasleft();

        (bool success, ) = gaslessTx.transaction.to.call{
            value: gaslessTx.transaction.value
        }(gaslessTx.transaction.data);
        
        require(success, "GaslessExecutor: execution failed");

        if (gaslessTx.fee.coinPriceInToken > 0) {
            _processFeeTransfer(gaslessTx.fee, feeReceiver, startGas, forced);
        }

        emit TransactionExecuted(gaslessTx);
    }

    receive() external payable {}

    fallback() external payable {} // TODO do we need it?

    function _processFeeTransfer(
        Fee calldata fee,
        address feeReceiver,
        uint startGas,
        bool forced
    ) private {
        uint gasBeforeFeeTransfer = gasleft();
        uint totalGas = startGas - gasBeforeFeeTransfer + fee.feeTransferGasLimit + fee.baseGas;

        uint weiCost = totalGas * tx.gasprice;
        uint feeAmount = weiCost * fee.coinPriceInToken / PRICE_PRECISION;

        require(feeAmount <= fee.maxTokenFee, "GaslessExecutor: max fee exceeded");

        IERC20(fee.feeToken).safeTransfer(feeReceiver, feeAmount);

        uint feeTransferGasUsed = gasBeforeFeeTransfer - gasleft();
        bool feeTransferGasLimitExceeded = feeTransferGasUsed > fee.feeTransferGasLimit;

        if (forced) {
            if (feeTransferGasLimitExceeded) {
                emit FeeTransferGasLimitExceeded(fee.feeTransferGasLimit, feeTransferGasUsed);
            }
        } else {
            require(!feeTransferGasLimitExceeded, "GaslessExecutor: fee transfer gas limit exceeded");
        }

        emit FeeTransferProcessed(feeReceiver, fee.feeToken, feeAmount, totalGas);
    }

    function _verifyGaslessTransaction(
        GaslessTransaction calldata gaslessTx,
        bytes calldata signature
    ) private {
        require(gaslessTx.nonce == nonce, "GaslessExecutor: invalid nonce");

        bytes32 digest = _hashTypedDataV4(_hashGaslessTransaction(gaslessTx));
        address signer = ECDSA.recover(digest, signature);

        require(signer == address(this), "GaslessExecutor: invalid signer");

        nonce++;
    }

    function _hashTransaction(Transaction calldata transaction) private pure returns (bytes32) {
        return keccak256(abi.encode(
            TRANSACTION_TYPEHASH,
            transaction.to,
            transaction.value,
            keccak256(transaction.data)
        ));
    }
    
    function _hashFee(Fee calldata fee) private pure returns (bytes32) {
        return keccak256(abi.encode(
            FEE_TYPEHASH,
            fee.feeToken,
            fee.maxTokenFee,
            fee.coinPriceInToken,
            fee.feeTransferGasLimit,
            fee.baseGas
        ));
    }

    function _hashGaslessTransaction(GaslessTransaction calldata gaslessTx)
        private
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(
            GASLESS_TRANSACTION_TYPEHASH,
            _hashTransaction(gaslessTx.transaction),
            _hashFee(gaslessTx.fee),
            gaslessTx.nonce
        ));
    }
}