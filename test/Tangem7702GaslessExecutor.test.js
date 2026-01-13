import { expect } from "chai";
import hre from "hardhat";
import { makeGaslessTx, signGaslessTx } from "./helpers/eip712Gasless.js";

const conn = await hre.network.connect();
const { ethers, networkHelpers } = conn;

async function installExecutorCodeAtEoa({ executorEoaAddress, implementationAddress }) {
  // Read the deployed implementation runtime bytecode from the chain.
  const implCode = await ethers.provider.getCode(implementationAddress);

  // Force-install the implementation runtime bytecode at the EOA address (test harness for EIP-7702 context).
  await networkHelpers.setCode(executorEoaAddress, implCode);

  // Sanity-check the EOA now has exactly the implementation bytecode.
  expect(await ethers.provider.getCode(executorEoaAddress)).to.equal(implCode);
}

async function deployExecutorFixture() {
  // Get deterministic test signers: deployer (deploys contracts), executorEOA (acts as delegated account),
  // relayer (external caller), feeReceiver (receives ERC-20 fee).
  const [deployer, executorEOA, relayer, feeReceiver] = await ethers.getSigners();

  // Deploy the executor implementation contract (we will copy its runtime code to executorEOA).
  const ExecutorImpl = await ethers.getContractFactory("Tangem7702GaslessExecutor", deployer);
  const impl = await ExecutorImpl.deploy();

  // Wait until the deployment transaction is mined and the contract is available.
  await impl.waitForDeployment();

  // Deploy the ERC-20 mock used as fee token in the fee-transfer paths.
  const Token = await ethers.getContractFactory("ERC20Mock", deployer);
  const token = await Token.deploy("MockFeeToken", "MFT");

  // Wait until the token contract is deployed.
  await token.waitForDeployment();

  // Deploy a target contract that has both success and revert code paths for executor call testing.
  const Target = await ethers.getContractFactory("ExecutorTargetMock", deployer);
  const target = await Target.deploy();

  // Wait until the target contract is deployed.
  await target.waitForDeployment();

  // Copy the executor implementation bytecode into executorEOA so address(this) == executorEOA during execution.
  await installExecutorCodeAtEoa({
    executorEoaAddress: executorEOA.address,
    implementationAddress: await impl.getAddress(),
  });

  // Create a contract instance bound to the EOA address where the executor bytecode is installed.
  const executor = await ethers.getContractAt("Tangem7702GaslessExecutor", executorEOA.address);

  // Return everything tests need from this fixture.
  return {
    deployer,
    executorEOA,
    relayer,
    feeReceiver,
    impl,
    executor,
    token,
    target,
  };
}

describe("Tangem7702GaslessExecutor", function () {
  it("Accepts ETH via receive", async function () {
    // Load and snapshot the fixture to keep tests isolated and fast.
    const { relayer, executor } = await networkHelpers.loadFixture(deployExecutorFixture);

    // Send ETH to the executor address to ensure receive() is payable and does not revert.
    await expect(
      relayer.sendTransaction({
        to: await executor.getAddress(),
        value: 1n,
      })
    ).to.not.revert(ethers);
  });

  it("Reverts with InsufficientFundsForFee when fee token balance is below maxTokenFee", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Encode a successful target call so any revert comes from executor pre-checks.
    const data = target.interface.encodeFunctionData("ok", ["0x"]);

    // Build a gasless transaction where maxTokenFee is non-zero but executor has zero token balance.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 100n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      nonce: 0n,
    });

    // Expect an early revert before signature verification or target call due to insufficient fee-token balance.
    await expect(
      executor.connect(relayer).executeTransaction(gaslessTx, "0x1234", feeReceiver.address, false)
    )
      .to.be.revertedWithCustomError(executor, "InsufficientFundsForFee")
      .withArgs(await token.getAddress(), 0n, 100n);
  });

  it("Reverts with InvalidNonce when provided nonce does not match stored nonce", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Mint just enough tokens to pass the initial balance check (maxTokenFee == 1).
    await token.connect(deployer).mint(await executor.getAddress(), 1n);

    // Encode a successful target call so any revert comes from nonce/signature checks.
    const data = target.interface.encodeFunctionData("ok", ["0x"]);

    // Provide nonce == 1 while stored nonce starts at 0 to trigger InvalidNonce.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 1n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      nonce: 1n,
    });

    // Expect the contract to reject the transaction because nonces must match exactly.
    await expect(
      executor.connect(relayer).executeTransaction(gaslessTx, "0x1234", feeReceiver.address, false)
    )
      .to.be.revertedWithCustomError(executor, "InvalidNonce")
      .withArgs(0n, 1n);
  });

  it("Reverts with InvalidSigner when signature does not recover to executor address", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Use a valid target call; we want to fail specifically at signature verification.
    const data = target.interface.encodeFunctionData("ok", ["0x1122"]);

    // maxTokenFee == 0 still triggers balanceOf(feeToken), so feeToken must be a real ERC-20 contract.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      nonce: 0n,
    });

    // Sign typed data with the wrong signer (deployer) while executor expects signer == address(this) == executorEOA.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: deployer,
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Expect InvalidSigner(recoveredSigner, expectedSigner) where expectedSigner is executorEOA.
    await expect(
      executor.connect(relayer).executeTransaction(gaslessTx, signature, feeReceiver.address, false)
    )
      .to.be.revertedWithCustomError(executor, "InvalidSigner")
      .withArgs(deployer.address, executorEOA.address);

    // Confirm nonce did not change because the call reverted.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Reverts with ExecutionFailed and extracts selector when target call fails with 4+ bytes calldata", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Encode a call to a function that always reverts to force the executor's ExecutionFailed path.
    const data = target.interface.encodeFunctionData("fail", []);

    // Pre-compute what the contract should report in the custom error.
    const dataHash = ethers.keccak256(data);
    const selector = target.interface.getFunction("fail").selector;

    // Build a gasless transaction that triggers a reverting target call.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA so execution reaches the target call.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Expect the executor to revert with ExecutionFailed and include selector + dataHash for diagnostics.
    await expect(
      executor.connect(relayer).executeTransaction(gaslessTx, signature, feeReceiver.address, false)
    )
      .to.be.revertedWithCustomError(executor, "ExecutionFailed")
      .withArgs(await target.getAddress(), 0n, selector, dataHash);

    // Confirm nonce increments are rolled back on revert.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Reverts with ExecutionFailed and returns 0x00000000 selector when calldata is shorter than 4 bytes", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Provide 1-byte calldata so the selector extraction code returns 0x00000000 by design.
    const data = "0x11";

    // Pre-compute expected dataHash for the custom error.
    const dataHash = ethers.keccak256(data);

    // Use the target address but with invalid (short) calldata so the call fails and selector becomes zero.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA so execution reaches the target call.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Expect ExecutionFailed and a zero selector because calldata length < 4.
    await expect(
      executor.connect(relayer).executeTransaction(gaslessTx, signature, feeReceiver.address, false)
    )
      .to.be.revertedWithCustomError(executor, "ExecutionFailed")
      .withArgs(await target.getAddress(), 0n, "0x00000000", dataHash);

    // Confirm nonce increments are rolled back on revert.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Executes a valid transaction and emits TransactionExecuted when fee is disabled", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Send ETH value through the executor call to cover the value-forwarding path.
    const value = 123n;

    // Encode a successful target call that records msg.value and increments its own call counter.
    const data = target.interface.encodeFunctionData("ok", ["0xAABBCC"]);

    // Pre-compute expected dataHash used in TransactionExecuted event.
    const dataHash = ethers.keccak256(data);

    // fee disabled => coinPriceInToken == 0 => _processFeeTransfer must not be called.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA for this payload and domain.
    const { signature, digest } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Execute through a relayer so msg.sender != executorEOA, but signer must still be executorEOA.
    const tx = await executor
      .connect(relayer)
      .executeTransaction(gaslessTx, signature, feeReceiver.address, false);

    // Ensure fee-related events are not emitted when fee is disabled.
    await expect(tx).to.not.emit(executor, "FeeTransferProcessed");
    await expect(tx).to.not.emit(executor, "FeeTransferGasLimitExceeded");

    // Ensure TransactionExecuted is emitted with exact executor/to/value/dataHash/digest arguments.
    await expect(tx)
      .to.emit(executor, "TransactionExecuted")
      .withArgs(executorEOA.address, 0n, await target.getAddress(), value, dataHash, digest);

    // Verify nonce increments exactly once on success.
    expect(await executor.nonce()).to.equal(1n);

    // Verify the target observed the forwarded ETH value.
    expect(await target.lastValue()).to.equal(value);

    // Verify the target success path actually executed.
    expect(await target.calls()).to.equal(1n);
  });

  it("Processes fee transfer and emits FeeTransferProcessed when within gas limit", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Set a large maxTokenFee so balance check passes and fee calculation cannot exceed cap easily.
    const maxTokenFee = 1_000_000_000_000_000_000n;

    // Mint fee token to the executor address (EOA address where executor code runs).
    await token.connect(deployer).mint(executorEOA.address, maxTokenFee);

    // Encode a successful target call so we can reach fee processing logic.
    const data = target.interface.encodeFunctionData("ok", ["0x01"]);

    // Pre-compute expected dataHash used in TransactionExecuted event.
    const dataHash = ethers.keccak256(data);

    // Use a high feeTransferGasLimit to guarantee we don't exceed it and therefore don't emit gas-limit-exceeded.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee,
      coinPriceInToken: 1_000_000_000_000_000_000n,
      feeTransferGasLimit: 1_000_000n,
      baseGas: 0n,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA.
    const { signature, digest } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Snapshot balances to assert fee amount was actually transferred.
    const executorBalBefore = await token.balanceOf(executorEOA.address);
    const receiverBalBefore = await token.balanceOf(feeReceiver.address);

    // Execute with non-zero gas price so feeAmount becomes non-zero deterministically.
    const tx = await executor
      .connect(relayer)
      .executeTransaction(gaslessTx, signature, feeReceiver.address, false, { gasPrice: 1_000_000_000n });

    // In the within-limit scenario, the gas-limit-exceeded event must not be emitted.
    await expect(tx).to.not.emit(executor, "FeeTransferGasLimitExceeded");

    // Parse the receipt to extract the exact feeAmount from FeeTransferProcessed.
    const receipt = await tx.wait();
    const feeLog = receipt.logs
      .map((l) => {
        try {
          return executor.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "FeeTransferProcessed");

    // Ensure FeeTransferProcessed was indeed emitted.
    expect(feeLog).to.not.equal(undefined);

    // Read feeAmount from the decoded event args.
    const feeAmount = feeLog.args.feeAmount;

    // Snapshot balances after execution to assert deltas match feeAmount.
    const executorBalAfter = await token.balanceOf(executorEOA.address);
    const receiverBalAfter = await token.balanceOf(feeReceiver.address);

    // Receiver must gain exactly the fee amount.
    expect(receiverBalAfter - receiverBalBefore).to.equal(feeAmount);

    // Executor must lose exactly the fee amount.
    expect(executorBalBefore - executorBalAfter).to.equal(feeAmount);

    // TransactionExecuted must still be emitted after fee processing succeeds.
    await expect(tx)
      .to.emit(executor, "TransactionExecuted")
      .withArgs(executorEOA.address, 0n, await target.getAddress(), 0n, dataHash, digest);

    // Nonce must increment after a successful end-to-end execution.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Emits FeeTransferGasLimitExceeded and completes when forced is true and gas limit is exceeded", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Ensure executor has enough tokens to pass the balance check.
    const maxTokenFee = 1_000_000_000_000_000_000n;
    await token.connect(deployer).mint(executorEOA.address, maxTokenFee);

    // Encode a successful target call; we want to fail only at the fee gas limit check.
    const data = target.interface.encodeFunctionData("ok", ["0x02"]);

    // Set feeTransferGasLimit to 0 so any token transfer gas usage exceeds the limit.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee,
      coinPriceInToken: 1_000_000_000_000_000_000n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA to reach fee processing.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Execute with forced == true so the contract emits the event instead of reverting.
    const tx = await executor
      .connect(relayer)
      .executeTransaction(gaslessTx, signature, feeReceiver.address, true, { gasPrice: 1_000_000_000n });

    // When forced is true, an exceeded gas limit must be reported via event.
    await expect(tx).to.emit(executor, "FeeTransferGasLimitExceeded");

    // FeeTransferProcessed must still be emitted because the transfer happened.
    await expect(tx).to.emit(executor, "FeeTransferProcessed");

    // Nonce must increment because the transaction completes successfully.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Reverts with FeeTransferGasLimitExceededNotForced when forced is false and gas limit is exceeded", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Ensure executor has enough tokens to pass the balance check.
    const maxTokenFee = 1_000_000_000_000_000_000n;
    await token.connect(deployer).mint(executorEOA.address, maxTokenFee);

    // Encode a successful target call; we want the revert to happen at the post-transfer gas check.
    const data = target.interface.encodeFunctionData("ok", ["0x03"]);

    // Set feeTransferGasLimit to 0 so the measured transfer gas usage exceeds the limit.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee,
      coinPriceInToken: 1_000_000_000_000_000_000n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA to reach fee processing.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Snapshot balances so we can prove the revert rolls back fee transfer effects.
    const executorBalBefore = await token.balanceOf(executorEOA.address);
    const receiverBalBefore = await token.balanceOf(feeReceiver.address);

    // With forced == false, exceeded gas limit must revert with the custom error.
    await expect(
      executor
        .connect(relayer)
        .executeTransaction(gaslessTx, signature, feeReceiver.address, false, { gasPrice: 1_000_000_000n })
    ).to.be.revertedWithCustomError(executor, "FeeTransferGasLimitExceededNotForced");

    // Revert must roll back token balance changes.
    const executorBalAfter = await token.balanceOf(executorEOA.address);
    const receiverBalAfter = await token.balanceOf(feeReceiver.address);

    // Executor token balance must be unchanged after the reverted tx.
    expect(executorBalAfter).to.equal(executorBalBefore);

    // Fee receiver token balance must be unchanged after the reverted tx.
    expect(receiverBalAfter).to.equal(receiverBalBefore);

    // Nonce must not increment because the entire transaction reverted.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Reverts with MaxFeeExceeded when computed fee exceeds maxTokenFee", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Balance check requires balance >= maxTokenFee, so mint exactly 1.
    await token.connect(deployer).mint(executorEOA.address, 1n);

    // Encode a successful target call so we can reach fee computation logic.
    const data = target.interface.encodeFunctionData("ok", ["0x04"]);

    // Use a small maxTokenFee and large baseGas + non-zero gasPrice so computed fee exceeds maxTokenFee.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 1n,
      coinPriceInToken: 1_000_000_000_000_000_000n,
      feeTransferGasLimit: 1_000_000n,
      baseGas: 1_000_000n,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA to reach _processFeeTransfer.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Expect the fee computation to exceed maxTokenFee and revert with MaxFeeExceeded.
    await expect(
      executor
        .connect(relayer)
        .executeTransaction(gaslessTx, signature, feeReceiver.address, false, { gasPrice: 1_000_000_000n })
    ).to.be.revertedWithCustomError(executor, "MaxFeeExceeded");

    // Nonce must remain unchanged because the transaction reverted.
    expect(await executor.nonce()).to.equal(0n);
  });
});