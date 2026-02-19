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
  const ExecutorImpl = await ethers.getContractFactory("Tangem7702GaslessExecutorL1", deployer);
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

  it("Reverts with InsufficientFundsForFee when fee token balance is below required fee amount", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Encode a successful target call so any revert comes from executor fee processing.
    const data = target.interface.encodeFunctionData("ok", ["0x"]);

    // Build a gasless transaction where fee is enabled but executor has zero token balance.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 1_000_000_000n,
      coinPriceInToken: 500_000n,
      feeTransferGasLimit: 100_000n,
      baseGas: 100n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Ensure feeAmount becomes non-zero so we deterministically hit insufficient-balance.
    await expect(
      executor
        .connect(relayer)
        .executeTransaction(gaslessTx, signature, false, { gasPrice: 1_000_000_000n })
    )
      .to.be.revertedWithCustomError(executor, "InsufficientFundsForFee");
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
      feeReceiver: feeReceiver.address,
      nonce: 1n,
    });

    // Expect the contract to reject the transaction because nonces must match exactly.
    await expect(executor.connect(relayer).executeTransaction(gaslessTx, "0x1234", false))
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
      feeReceiver: feeReceiver.address,
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
    await expect(executor.connect(relayer).executeTransaction(gaslessTx, signature, false))
      .to.be.revertedWithCustomError(executor, "InvalidSigner")
      .withArgs(deployer.address, executorEOA.address);

    // Confirm nonce did not change because the call reverted.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Bubbles revert reason when target reverts with string reason", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Encode a call to a function that always reverts with a reason string to test bubbling.
    const data = target.interface.encodeFunctionData("fail", []);

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
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA so execution reaches the target call.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Expect the executor to bubble the target's revert reason.
    await expect(executor.connect(relayer).executeTransaction(gaslessTx, signature, false)).to.be.revertedWith("FAIL");

    // Confirm nonce increment is rolled back because the whole call reverted.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Bubbles revert reason when fallback reverts with string reason", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Provide short calldata so the call hits the target fallback and reverts with a reason string.
    const data = "0xdeadbeef";

    // Use the target address with calldata that does not match any function so fallback reverts.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA so execution reaches the target call.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Expect the executor to bubble the fallback revert reason.
    await expect(executor.connect(relayer).executeTransaction(gaslessTx, signature, false)).to.be.revertedWith(
      "FALLBACK"
    );

    // Confirm nonce increment is rolled back because the whole call reverted.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Reverts with ExecutionFailed when target reverts with empty data", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Encode a target call that reverts with empty returndata so the executor cannot bubble a reason.
    const data = target.interface.encodeFunctionData("failNoData", []);

    // Pre-compute selector expected to be surfaced via ExecutionFailed.
    const selector = target.interface.getFunction("failNoData").selector;

    // Build a gasless transaction that reaches the target call and triggers the empty-revert-data branch.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA so execution reaches the target call.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Expect ExecutionFailed because the target returned no revert data to bubble.
    await expect(executor.connect(relayer).executeTransaction(gaslessTx, signature, false))
      .to.be.revertedWithCustomError(executor, "ExecutionFailedNotForced")
      .withArgs(await target.getAddress(), 0n, selector);

    // Confirm nonce increment is rolled back because the whole call reverted.
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

    // Pre-compute selector expected in TransactionExecuted event.
    const selector = target.interface.getFunction("ok").selector;

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
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA for this payload and domain.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Execute through a relayer so msg.sender != executorEOA, but signer must still be executorEOA.
    const tx = await executor.connect(relayer).executeTransaction(gaslessTx, signature, false);

    // Ensure fee-related events are not emitted when fee is disabled.
    await expect(tx).to.not.emit(executor, "FeeTransferProcessed");
    await expect(tx).to.not.emit(executor, "FeeTransferGasLimitExceeded");

    // Ensure TransactionExecuted is emitted with exact executor/to/value/selector arguments.
    await expect(tx)
      .to.emit(executor, "TransactionExecuted")
      .withArgs(executorEOA.address, 0n, await target.getAddress(), value, selector);

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

    // Pre-compute selector expected in TransactionExecuted event.
    const selector = target.interface.getFunction("ok").selector;

    // Use a high feeTransferGasLimit to guarantee we don't exceed it and therefore don't emit gas-limit-exceeded.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      data,
      feeToken: await token.getAddress(),
      maxTokenFee,
      coinPriceInToken: 1_000_000_000_000_000_000n,
      feeTransferGasLimit: 100_000n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid signature from executorEOA.
    const { signature } = await signGaslessTx({
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
      .executeTransaction(gaslessTx, signature, false, { gasPrice: 1_000_000_000n });

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
      .withArgs(executorEOA.address, 0n, await target.getAddress(), 0n, selector);

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
      feeReceiver: feeReceiver.address,
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
      .executeTransaction(gaslessTx, signature, true, { gasPrice: 1_000_000_000n });

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
      feeReceiver: feeReceiver.address,
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
      executor.connect(relayer).executeTransaction(gaslessTx, signature, false, { gasPrice: 1_000_000_000n })
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
      feeReceiver: feeReceiver.address,
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
      executor.connect(relayer).executeTransaction(gaslessTx, signature, false, { gasPrice: 1_000_000_000n })
    ).to.be.revertedWithCustomError(executor, "MaxFeeExceeded");

    // Nonce must remain unchanged because the transaction reverted.
    expect(await executor.nonce()).to.equal(0n);
  });
});