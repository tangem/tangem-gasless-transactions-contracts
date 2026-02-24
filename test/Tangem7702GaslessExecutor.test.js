import { expect } from "chai";
import hre from "hardhat";
import { makeGaslessTx, makeGaslessBatchTx, signGaslessTx, signGaslessBatchTx } from "./helpers/eip712Gasless.js";

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

  it("Reverts with ZeroTarget when single transaction target is zero", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, feeReceiver, relayer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a single payload with a zero target to hit pre-validation before signature verification.
    const gaslessTx = makeGaslessTx({
      to: ethers.ZeroAddress,
      value: 0n,
      gasLimit: 200_000n,
      data: "0x",
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Zero target validation runs before signature verification.
    await expect(executor.connect(relayer).executeTransaction(gaslessTx, "0x", false))
      .to.be.revertedWithCustomError(executor, "ZeroTarget");
  });

  it("Reverts with DataTooShort when single transaction calldata is non-empty and shorter than 4 bytes", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a single payload with short calldata to hit selector-length validation before signature verification.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      gasLimit: 200_000n,
      data: "0x11",
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Calldata shape validation runs before signature verification.
    await expect(executor.connect(relayer).executeTransaction(gaslessTx, "0x", false))
      .to.be.revertedWithCustomError(executor, "DataTooShort");
  });

  it("Reverts with InvalidCallsLength when batch contains fewer than 2 calls", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a batch with exactly one call to trigger the lower bound check.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0x01"]),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Batch length validation runs before signature verification.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, "0x", false))
      .to.be.revertedWithCustomError(executor, "InvalidCallsLength");
  });

  it("Reverts with InvalidCallsLength when batch contains more than max allowed calls", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Prepare six calls to exceed MAX_BATCH_CALLS == 5.
    const callData = target.interface.encodeFunctionData("ok", ["0x02"]);

    // Build an oversized batch to trigger the upper bound check.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Batch length validation runs before signature verification.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, "0x", false))
      .to.be.revertedWithCustomError(executor, "InvalidCallsLength");
  });

  it("Reverts with ZeroTarget when batch contains a zero target", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Prepare one valid call and one invalid call with zero target.
    const callData = target.interface.encodeFunctionData("ok", ["0x03"]);

    // Build a batch that fails during pre-validation before signature verification.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: ethers.ZeroAddress, value: 0n, gasLimit: 200_000n, data: callData },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Zero target validation runs before signature verification.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, "0x", false))
      .to.be.revertedWithCustomError(executor, "ZeroTarget");
  });

  it("Reverts with DataTooShort when batch contains non-empty calldata shorter than 4 bytes", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a batch with short calldata in the second call to trigger selector-length validation.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0x04"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: "0x11",
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Calldata shape validation runs before signature verification.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, "0x", false))
      .to.be.revertedWithCustomError(executor, "DataTooShort");
  });

  it("Reverts with InvalidSigner when batch signature does not recover to executor address", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a valid two-call batch so the failure happens specifically in batch signature verification.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0x05"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0x06"]),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Sign with the wrong signer so recovered address mismatches address(this) in delegated context.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: deployer,
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Batch signature verification must reject the wrong signer.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, signature, false))
      .to.be.revertedWithCustomError(executor, "InvalidSigner")
      .withArgs(deployer.address, executorEOA.address);

    // Nonce must remain unchanged because the transaction reverted.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Bubbles revert reason when a batch call reverts with string reason and forced is false", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a batch where the second call reverts with a string reason.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0xCC"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("fail", []),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid batch signature from executorEOA.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Executor must bubble the target revert reason in non-forced mode.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, signature, false))
      .to.be.revertedWith("FAIL");

    // Revert must roll back the first successful call side effects.
    expect(await target.calls()).to.equal(0n);

    // Revert must roll back the nonce increment as well.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Reverts with BatchExecutionFailedNotForced when a batch call reverts with empty data and forced is false", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Pre-compute selector expected in the batch empty-revert custom error.
    const selector = target.interface.getFunction("failNoData").selector;

    // Build a batch where the second call reverts with empty returndata.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0xDD"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("failNoData", []),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid batch signature from executorEOA.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Executor must use BatchExecutionFailedNotForced because there is no revert data to bubble.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, signature, false))
      .to.be.revertedWithCustomError(executor, "BatchExecutionFailedNotForced")
      .withArgs(1n, await target.getAddress(), 0n, selector);

    // Revert must roll back prior successful call effects.
    expect(await target.calls()).to.equal(0n);

    // Revert must roll back the nonce increment.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Reverts with InsufficientGas when batch total requested gas exceeds available gas reserve", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a batch with absurdly high gas limits so the executor fails its reserve check before calls.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 100_000_000n,
          data: target.interface.encodeFunctionData("ok", ["0x1212"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 100_000_000n,
          data: target.interface.encodeFunctionData("ok", ["0x3434"]),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid signature so the failure happens specifically in gas reserve checks.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Executor must reject the batch before executing any target calls.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, signature, false))
      .to.be.revertedWithCustomError(executor, "InsufficientGas");

    // Nonce must remain unchanged because the transaction reverted.
    expect(await executor.nonce()).to.equal(0n);

    // No target calls must execute when the reserve check fails.
    expect(await target.calls()).to.equal(0n);
  });

  it("Executes a valid batch and emits BatchTransactionExecuted when fee is disabled", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a valid batch with two successful calls.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0xAA"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0xBB"]),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid batch signature from executorEOA.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Execute the batch with fee disabled.
    // Set explicit outer gas limit to avoid Hardhat auto-estimation overshooting provider cap.
    const tx = await executor.connect(relayer).executeBatchTransaction(
      gaslessBatchTx,
      signature,
      false,
      { gasLimit: 5_000_000n }
    );

    // Fee processing must be skipped when coinPriceInToken == 0.
    await expect(tx).to.not.emit(executor, "FeeTransferProcessed");
    await expect(tx).to.not.emit(executor, "FeeTransferGasLimitExceeded");

    // Batch completion event must report total and executed calls.
    await expect(tx)
      .to.emit(executor, "BatchTransactionExecuted")
      .withArgs(executorEOA.address, 0n, 2n, 2n);

    // Target must execute both calls.
    expect(await target.calls()).to.equal(2n);

    // Nonce must increment exactly once for a successful batch.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Emits BatchCallFailed and stops remaining calls when forced is true", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Pre-compute selector expected in BatchCallFailed.
    const failSelector = target.interface.getFunction("fail").selector;

    // Build a batch where the second call fails and the third call should not run.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0xEE"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("fail", []),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0xFF"]),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid batch signature from executorEOA.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Execute in forced mode so the batch stops at first failure instead of reverting.
    // Set explicit outer gas limit to avoid Hardhat auto-estimation overshooting provider cap.
    const tx = await executor.connect(relayer).executeBatchTransaction(
      gaslessBatchTx,
      signature,
      true,
      { gasLimit: 5_000_000n }
    );

    // Executor must report the failed call index and selector.
    await expect(tx)
      .to.emit(executor, "BatchCallFailed")
      .withArgs(1n, await target.getAddress(), 0n, failSelector);

    // Batch completion event must report that only one call succeeded.
    await expect(tx)
      .to.emit(executor, "BatchTransactionExecuted")
      .withArgs(executorEOA.address, 0n, 3n, 1n);

    // Only the first successful call must have executed.
    expect(await target.calls()).to.equal(1n);

    // Nonce must increment because the forced batch completes successfully.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Processes fee transfer after an early forced batch stop", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Mint enough fee token to cover the computed fee.
    const maxTokenFee = 1_000_000_000_000_000_000n;
    await token.connect(deployer).mint(executorEOA.address, maxTokenFee);

    // Pre-compute selector expected in BatchCallFailed.
    const failSelector = target.interface.getFunction("fail").selector;

    // Build a batch where the second call fails, but forced mode should continue to fee processing.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0x1111"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("fail", []),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee,
      coinPriceInToken: 1_000_000_000_000_000_000n,
      feeTransferGasLimit: 100_000n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid batch signature from executorEOA.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Snapshot token balances to verify the fee transfer happens after the early stop.
    const executorBalBefore = await token.balanceOf(executorEOA.address);
    const receiverBalBefore = await token.balanceOf(feeReceiver.address);

    // Execute in forced mode with non-zero gas price so feeAmount becomes non-zero.
    // Set explicit outer gas limit to avoid Hardhat auto-estimation overshooting provider cap.
    const tx = await executor.connect(relayer).executeBatchTransaction(
      gaslessBatchTx,
      signature,
      true,
      { gasPrice: 1_000_000_000n, gasLimit: 5_000_000n }
    );

    // Executor must report the failed batch call.
    await expect(tx)
      .to.emit(executor, "BatchCallFailed")
      .withArgs(1n, await target.getAddress(), 0n, failSelector);

    // Fee processing must still happen after the early stop.
    await expect(tx).to.emit(executor, "FeeTransferProcessed");

    // Batch completion event must report one successful call out of two.
    await expect(tx)
      .to.emit(executor, "BatchTransactionExecuted")
      .withArgs(executorEOA.address, 0n, 2n, 1n);

    // Parse the receipt to extract the actual fee amount.
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

    // FeeTransferProcessed must be present in the receipt.
    expect(feeLog).to.not.equal(undefined);

    // Read the exact transferred fee amount from the event.
    const feeAmount = feeLog.args.feeAmount;

    // Snapshot balances after execution to compare deltas.
    const executorBalAfter = await token.balanceOf(executorEOA.address);
    const receiverBalAfter = await token.balanceOf(feeReceiver.address);

    // Fee receiver must gain exactly the transferred fee amount.
    expect(receiverBalAfter - receiverBalBefore).to.equal(feeAmount);

    // Executor must lose exactly the transferred fee amount.
    expect(executorBalBefore - executorBalAfter).to.equal(feeAmount);

    // Only the first successful call must have executed before the failure stop.
    expect(await target.calls()).to.equal(1n);

    // Nonce must increment because the forced batch completed.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Accepts ETH via payable fallback", async function () {
    // Load fresh fixture state for this test.
    const { relayer, executor } = await networkHelpers.loadFixture(deployExecutorFixture);

    // Send ETH with non-empty calldata so the executor fallback() path is used.
    await expect(
      relayer.sendTransaction({
        to: await executor.getAddress(),
        value: 1n,
        data: "0x1234",
      })
    ).to.not.revert(ethers);
  });

  it("Emits ExecutionFailed and completes when single call reverts and forced is true", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Encode a target call that always reverts with a string reason.
    const data = target.interface.encodeFunctionData("fail", []);

    // Pre-compute selector expected in events.
    const selector = target.interface.getFunction("fail").selector;

    // Build a single gasless transaction with fee disabled so we isolate forced failure handling.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      gasLimit: 250_000n,
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

    // Execute in forced mode so revert is converted into an event and the tx completes.
    // Set explicit outer gas limit to avoid Hardhat auto-estimation overshooting provider cap.
    const tx = await executor
      .connect(relayer)
      .executeTransaction(gaslessTx, signature, true, { gasLimit: 5_000_000n });

    // Executor must report the failed user call.
    await expect(tx)
      .to.emit(executor, "ExecutionFailed")
      .withArgs(await target.getAddress(), 0n, selector);

    // Executor must still emit TransactionExecuted because forced mode completes successfully.
    await expect(tx)
      .to.emit(executor, "TransactionExecuted")
      .withArgs(executorEOA.address, 0n, await target.getAddress(), 0n, selector);

    // No fee events must be emitted when fee is disabled.
    await expect(tx).to.not.emit(executor, "FeeTransferProcessed");
    await expect(tx).to.not.emit(executor, "FeeTransferGasLimitExceeded");

    // Target success path must not execute.
    expect(await target.calls()).to.equal(0n);

    // Nonce must increment because the forced transaction completes.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Emits TransactionExecuted with zero selector when calldata is empty", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, feeReceiver, relayer, executorEOA, deployer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Empty calldata is valid and should produce selector == bytes4(0) in events.
    const gaslessTx = makeGaslessTx({
      to: deployer.address,
      value: 0n,
      gasLimit: 100_000n,
      data: "0x",
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
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

    // Execute a call to an EOA; it should succeed and emit selector == 0x00000000.
    const tx = await executor.connect(relayer).executeTransaction(gaslessTx, signature, false);

    await expect(tx)
      .to.emit(executor, "TransactionExecuted")
      .withArgs(executorEOA.address, 0n, deployer.address, 0n, "0x00000000");

    // Nonce must increment on success.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Reverts with InvalidNonce when batch nonce does not match stored nonce", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a valid-shaped batch with nonce == 1 while stored nonce starts at 0.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0x01"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0x02"]),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 1n,
    });

    // Nonce validation runs before signature recovery/hashing side effects matter.
    await expect(executor.connect(relayer).executeBatchTransaction(gaslessBatchTx, "0x", false))
      .to.be.revertedWithCustomError(executor, "InvalidNonce")
      .withArgs(0n, 1n);

    // Nonce must remain unchanged after the reverted batch.
    expect(await executor.nonce()).to.equal(0n);
  });

  it("Reverts with InsufficientGas when single transaction requested gas exceeds available reserve", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a single call with an absurdly high requested gas limit so reserve checks fail before the call.
    const gaslessTx = makeGaslessTx({
      to: await target.getAddress(),
      value: 0n,
      gasLimit: 100_000_000n,
      data: target.interface.encodeFunctionData("ok", ["0x1234"]),
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid signature so the failure happens specifically in gas reserve checks.
    const { signature } = await signGaslessTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessTx,
    });

    // Use an explicit outer gas limit to avoid Hardhat auto-estimation overshooting provider caps.
    await expect(
      executor.connect(relayer).executeTransaction(gaslessTx, signature, false, { gasLimit: 5_000_000n })
    ).to.be.revertedWithCustomError(executor, "InsufficientGas");

    // Revert must roll back nonce increment from signature verification.
    expect(await executor.nonce()).to.equal(0n);

    // No target calls must execute when reserve checks fail.
    expect(await target.calls()).to.equal(0n);
  });

  it("Executes a valid batch with max allowed calls when fee is disabled", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Build a batch with exactly MAX_BATCH_CALLS == 5 successful calls.
    const callData = target.interface.encodeFunctionData("ok", ["0xAB"]);
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
        { to: await target.getAddress(), value: 0n, gasLimit: 200_000n, data: callData },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee: 0n,
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid batch signature from executorEOA.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Execute with an explicit outer gas limit to avoid Hardhat estimate overshooting provider cap.
    const tx = await executor.connect(relayer).executeBatchTransaction(
      gaslessBatchTx,
      signature,
      false,
      { gasLimit: 7_000_000n }
    );

    // Batch completion event must report all five calls executed.
    await expect(tx)
      .to.emit(executor, "BatchTransactionExecuted")
      .withArgs(executorEOA.address, 0n, 5n, 5n);

    // Fee processing must remain disabled.
    await expect(tx).to.not.emit(executor, "FeeTransferProcessed");
    await expect(tx).to.not.emit(executor, "FeeTransferGasLimitExceeded");

    // Target must execute all five calls.
    expect(await target.calls()).to.equal(5n);

    // Nonce must increment exactly once for a successful batch.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Processes fee transfer when batch succeeds without early stop", async function () {
    // Load fresh fixture state for this test.
    const { executor, token, target, feeReceiver, relayer, deployer, executorEOA } =
      await networkHelpers.loadFixture(deployExecutorFixture);

    // Mint enough fee token to cover the computed fee and keep max-fee checks non-binding.
    const maxTokenFee = 1_000_000_000_000_000_000n;
    await token.connect(deployer).mint(executorEOA.address, maxTokenFee);

    // Build a fully successful two-call batch with fee enabled.
    const gaslessBatchTx = makeGaslessBatchTx({
      transactions: [
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0xAAAA"]),
        },
        {
          to: await target.getAddress(),
          value: 0n,
          gasLimit: 200_000n,
          data: target.interface.encodeFunctionData("ok", ["0xBBBB"]),
        },
      ],
      feeToken: await token.getAddress(),
      maxTokenFee,
      coinPriceInToken: 1_000_000_000_000_000_000n,
      feeTransferGasLimit: 100_000n,
      baseGas: 0n,
      feeReceiver: feeReceiver.address,
      nonce: 0n,
    });

    // Produce a valid batch signature from executorEOA.
    const { signature } = await signGaslessBatchTx({
      conn,
      executorSigner: await ethers.getSigner(executorEOA.address),
      executorAddress: executorEOA.address,
      gaslessBatchTx,
    });

    // Snapshot balances so we can verify the fee transfer delta exactly.
    const executorBalBefore = await token.balanceOf(executorEOA.address);
    const receiverBalBefore = await token.balanceOf(feeReceiver.address);

    // Execute with non-zero gas price so computed feeAmount is non-zero.
    const tx = await executor.connect(relayer).executeBatchTransaction(
      gaslessBatchTx,
      signature,
      false,
      { gasPrice: 1_000_000_000n, gasLimit: 6_000_000n }
    );

    // Successful batch with fee enabled must emit fee processing and batch completion.
    await expect(tx).to.emit(executor, "FeeTransferProcessed");
    await expect(tx).to.not.emit(executor, "FeeTransferGasLimitExceeded");
    await expect(tx)
      .to.emit(executor, "BatchTransactionExecuted")
      .withArgs(executorEOA.address, 0n, 2n, 2n);

    // All target calls must execute.
    expect(await target.calls()).to.equal(2n);

    // Parse FeeTransferProcessed to extract the exact feeAmount.
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

    expect(feeLog).to.not.equal(undefined);

    const feeAmount = feeLog.args.feeAmount;

    // Compare post-state balances against emitted feeAmount.
    const executorBalAfter = await token.balanceOf(executorEOA.address);
    const receiverBalAfter = await token.balanceOf(feeReceiver.address);

    expect(receiverBalAfter - receiverBalBefore).to.equal(feeAmount);
    expect(executorBalBefore - executorBalAfter).to.equal(feeAmount);

    // Nonce must increment because the batch completed successfully.
    expect(await executor.nonce()).to.equal(1n);
  });

  it("Supports ERC165, ERC721Receiver, and ERC1155Receiver interfaces", async function () {
    // Load fresh fixture state for this test.
    const { executor } = await networkHelpers.loadFixture(deployExecutorFixture);

    // IERC165 interface ID.
    expect(await executor.supportsInterface("0x01ffc9a7")).to.equal(true);

    // IERC721Receiver interface ID.
    expect(await executor.supportsInterface("0x150b7a02")).to.equal(true);

    // IERC1155Receiver interface ID (onERC1155Received + onERC1155BatchReceived).
    expect(await executor.supportsInterface("0x4e2312e0")).to.equal(true);

    // Invalid interface ID must not be supported.
    expect(await executor.supportsInterface("0xffffffff")).to.equal(false);
  });
});