import { expect } from "chai";
import hre from "hardhat";
import { set7702Delegate } from "./helpers/eip7702.js";

// Establish exactly one Hardhat v3 network connection for this test file.
// Using multiple `network.connect()` calls across helpers can accidentally create separate
// simulated networks, and state changes (like setCode) won't be visible in the test.
const conn = await hre.network.connect();

const DEFAULT_CALL_GAS_LIMIT = 200_000n;

// Build a minimal GaslessTransaction object that matches the EntryPoint ABI.
// IMPORTANT: Transaction struct includes `gasLimit` in the onchain ABI.
function makeGaslessTx({
  to,
  value,
  gasLimit = DEFAULT_CALL_GAS_LIMIT,
  data,
  feeToken,
  maxTokenFee,
  feeReceiver,
  nonce,
}) {
  // Encode the nested struct exactly as Solidity expects: { transaction: {...}, fee: {...}, nonce }
  return {
    // Target call parameters that the executor will perform.
    transaction: { to, value, gasLimit, data },

    // Fee parameters — EntryPoint doesn’t validate these, it only forwards them.
    fee: {
      feeToken,
      maxTokenFee,

      // Not used by EntryPoint tests, but present in struct.
      coinPriceInToken: 0n,
      feeTransferGasLimit: 0n,
      baseGas: 0n,
      feeReceiver: feeReceiver,
    },

    // Nonce is part of the signed payload; EntryPoint doesn’t validate it, executor does.
    nonce,
  };
}

// Fixture: deploys contracts once, then Hardhat snapshots and resets to this state for each test.
// IMPORTANT: This must be a named function (not an inline arrow) so loadFixture can cache it.
async function deployEntryPointFixture(c) {
  // Use ethers from the provided connection (not from another connect()) to stay in the same EDR world.
  const { ethers } = c;

  // Pull test signers from the connected network.
  // deployer: deploys contracts
  // executorEOA: address that will receive EIP-7702 delegation code
  // feeReceiverEOA: just a dummy address used inside gaslessTx
  // randomCaller: calls EntryPoint so we can assert msg.sender seen by executor is the EntryPoint
  const [deployer, executorEOA, feeReceiverEOA, randomCaller] =
    await ethers.getSigners();

  // Deploy the mock executor implementation (this is the "delegate" contract code).
  const Mock = await ethers.getContractFactory(
    "Tangem7702GaslessExecutorMock",
    deployer
  );

  // Deploy the delegate that EntryPoint expects executors to be delegated to.
  const requiredDelegate = await Mock.deploy();
  await requiredDelegate.waitForDeployment();

  // Deploy a second delegate to simulate "wrong delegation".
  const otherDelegate = await Mock.deploy();
  await otherDelegate.waitForDeployment();

  // Deploy the EntryPoint configured to require `requiredDelegate`.
  const EntryPoint = await ethers.getContractFactory(
    "Tangem7702GaslessEntryPoint",
    deployer
  );

  // Pass required delegate address to constructor.
  const entryPoint = await EntryPoint.deploy(await requiredDelegate.getAddress());
  await entryPoint.waitForDeployment();

  // Return everything tests may need; also return the connection `c` so helpers can use it safely.
  return {
    c,
    deployer,
    executorEOA,
    feeReceiverEOA,
    randomCaller,
    entryPoint,
    requiredDelegate,
    otherDelegate,
  };
}

describe("Tangem7702GaslessEntryPoint", function () {
  it("Deploys with required delegate address", async function () {
    // Load fixture snapshot for a clean deterministic environment.
    const { entryPoint, requiredDelegate } =
      await conn.networkHelpers.loadFixture(deployEntryPointFixture);

    // EntryPoint must persist the constructor parameter as immutable requiredDelegateAddress.
    expect(await entryPoint.requiredDelegateAddress()).to.equal(
      await requiredDelegate.getAddress()
    );
  });

  it("Reverts with InvalidDelegate when executor is not delegated", async function () {
    // Pull contracts + actors from a fresh snapshot.
    const { c, entryPoint, requiredDelegate, executorEOA, feeReceiverEOA } =
      await conn.networkHelpers.loadFixture(deployEntryPointFixture);

    // Use ethers from the same connection used by fixture.
    const { ethers } = c;

    // Build a simple gaslessTx; EntryPoint won't inspect internals beyond forwarding.
    const gaslessTx = makeGaslessTx({
      to: feeReceiverEOA.address,
      value: 0n,
      data: "0x",
      feeToken: ethers.ZeroAddress,
      maxTokenFee: 0n,
      feeReceiver: feeReceiverEOA.address,
      nonce: 0n,
    });

    // We do NOT set EIP-7702 delegation code on executorEOA here,
    // so `executor.fetchDelegate()` should resolve to address(0).
    await expect(
      entryPoint.executeTransaction(
        // Forwarded signed payload (not validated by EntryPoint).
        gaslessTx,
        // Signature is not validated by EntryPoint.
        "0x1234",
        // Forced flag forwarded as-is.
        false,
        // Executor EOA is the account whose delegate must match.
        executorEOA.address
      )
    )
      // EntryPoint must revert with its custom error.
      .to.be.revertedWithCustomError(entryPoint, "InvalidDelegate")
      // Args: (executor, expectedDelegate, actualDelegate)
      .withArgs(
        executorEOA.address,
        await requiredDelegate.getAddress(),
        // Because code is empty, delegate is expected to be zero.
        ethers.ZeroAddress
      );
  });

  it("Reverts with InvalidDelegate when executor delegates to a different contract", async function () {
    // Pull clean state from fixture snapshot.
    const {
      c,
      entryPoint,
      requiredDelegate,
      otherDelegate,
      executorEOA,
      feeReceiverEOA,
    } = await conn.networkHelpers.loadFixture(deployEntryPointFixture);

    // Use ethers from the same connection.
    const { ethers } = c;

    // Set EIP-7702 delegation code on executorEOA to point to *otherDelegate*.
    // This makes `executor.fetchDelegate()` return otherDelegate, not requiredDelegate.
    await set7702Delegate(c, executorEOA.address, await otherDelegate.getAddress());

    // Build minimal payload; EntryPoint should revert before calling executor.
    const gaslessTx = makeGaslessTx({
      to: feeReceiverEOA.address,
      value: 0n,
      data: "0x",
      feeToken: ethers.ZeroAddress,
      maxTokenFee: 0n,
      feeReceiver: feeReceiverEOA.address,
      nonce: 0n,
    });

    // Call should revert because actualDelegate != requiredDelegateAddress.
    await expect(
      entryPoint.executeTransaction(
        gaslessTx,
        "0x1234",
        false,
        executorEOA.address
      )
    )
      .to.be.revertedWithCustomError(entryPoint, "InvalidDelegate")
      // Assert exact expected and actual delegate addresses.
      .withArgs(
        executorEOA.address,
        await requiredDelegate.getAddress(),
        await otherDelegate.getAddress()
      );
  });

  it("Forwards executeTransaction to executor when delegation matches required delegate", async function () {
    // Load snapshot for a deterministic baseline.
    const {
      c,
      entryPoint,
      requiredDelegate,
      executorEOA,
      feeReceiverEOA,
      randomCaller,
    } = await conn.networkHelpers.loadFixture(deployEntryPointFixture);

    // Use ethers from the same connection.
    const { ethers } = c;

    // Set delegation so executorEOA.fetchDelegate() equals requiredDelegateAddress.
    // After this, EntryPoint should pass the delegate check and forward the call.
    await set7702Delegate(c, executorEOA.address, await requiredDelegate.getAddress());

    // Non-empty calldata lets us verify dataHash capture in the mock.
    const txData = "0x112233445566";

    // Signature is opaque for EntryPoint; mock stores keccak256(signature) for assertion.
    const signature = "0x" + "11".repeat(65);

    // Build payload with meaningful values so we can assert all forwarded fields.
    const gaslessTx = makeGaslessTx({
      to: feeReceiverEOA.address,
      // value > 0 is allowed and intentionally tested.
      value: 123n,
      // Explicit gasLimit just to be extra deterministic in tests.
      gasLimit: 250_000n,
      data: txData,
      feeToken: ethers.ZeroAddress,
      maxTokenFee: 999n,
      feeReceiver: feeReceiverEOA.address,
      nonce: 777n,
    });

    // Call EntryPoint from a random account.
    // This ensures that inside delegated executor code, msg.sender is the EntryPoint (not the random caller).
    await entryPoint
      .connect(randomCaller)
      .executeTransaction(gaslessTx, signature, true, executorEOA.address);

    // The executor is an EOA address, but it now has EIP-7702 delegation code installed.
    // We can attach the mock ABI to the EOA address and read the storage that the delegate code wrote.
    const executorAsMock = await ethers.getContractAt(
      "Tangem7702GaslessExecutorMock",
      executorEOA.address
    );

    // Verify the delegate code actually ran exactly once.
    expect(await executorAsMock.calls()).to.equal(1n);

    // msg.sender observed by the delegated code must be the EntryPoint that performed the call.
    expect(await executorAsMock.lastMsgSender()).to.equal(await entryPoint.getAddress());

    // Fee receiver and forced flag must be forwarded as provided.
    expect(await executorAsMock.lastFeeReceiver()).to.equal(feeReceiverEOA.address);
    expect(await executorAsMock.lastForced()).to.equal(true);

    // Verify the nested transaction fields were forwarded exactly.
    expect(await executorAsMock.lastTo()).to.equal(feeReceiverEOA.address);
    expect(await executorAsMock.lastValue()).to.equal(123n);

    // Mock stores keccak256(data) to avoid writing dynamic bytes into storage.
    expect(await executorAsMock.lastDataHash()).to.equal(ethers.keccak256(txData));

    // Verify fee sub-struct forwarding (even though EntryPoint doesn't validate it).
    expect(await executorAsMock.lastFeeToken()).to.equal(ethers.ZeroAddress);
    expect(await executorAsMock.lastMaxTokenFee()).to.equal(999n);

    // Verify nonce forwarding.
    expect(await executorAsMock.lastGaslessNonce()).to.equal(777n);

    // Mock stores keccak256(signature) so we can assert it without saving dynamic bytes.
    expect(await executorAsMock.lastSignatureHash()).to.equal(ethers.keccak256(signature));
  });

  it("Reverts with InvalidDelegate when executor is not delegated in batch path", async function () {
    // Pull contracts + actors from a fresh snapshot.
    const { c, entryPoint, requiredDelegate, executorEOA, feeReceiverEOA } =
      await conn.networkHelpers.loadFixture(deployEntryPointFixture);

    // Use ethers from the same connection used by the fixture.
    const { ethers } = c;

    // Build a minimal batch payload; EntryPoint validates only delegation and then forwards.
    const gaslessBatchTx = {
      transactions: [
        {
          to: feeReceiverEOA.address,
          value: 0n,
          gasLimit: DEFAULT_CALL_GAS_LIMIT,
          data: "0x",
        },
        {
          to: feeReceiverEOA.address,
          value: 0n,
          gasLimit: DEFAULT_CALL_GAS_LIMIT,
          data: "0x",
        },
      ],
      fee: {
        feeToken: ethers.ZeroAddress,
        maxTokenFee: 0n,
        coinPriceInToken: 0n,
        feeTransferGasLimit: 0n,
        baseGas: 0n,
        feeReceiver: feeReceiverEOA.address,
      },
      nonce: 0n,
    };

    // Do not install delegation designator on executorEOA, so fetchDelegate() returns zero.
    await expect(
      entryPoint.executeBatchTransaction(
        gaslessBatchTx,
        "0x1234",
        false,
        executorEOA.address
      )
    )
      .to.be.revertedWithCustomError(entryPoint, "InvalidDelegate")
      .withArgs(
        executorEOA.address,
        await requiredDelegate.getAddress(),
        ethers.ZeroAddress
      );
  });

  it("Reverts with InvalidDelegate when executor delegates to a different contract in batch path", async function () {
    // Pull clean state from fixture snapshot.
    const {
      c,
      entryPoint,
      requiredDelegate,
      otherDelegate,
      executorEOA,
      feeReceiverEOA,
    } = await conn.networkHelpers.loadFixture(deployEntryPointFixture);

    // Use ethers from the same connection used by the fixture.
    const { ethers } = c;

    // Install a different delegate than the one required by EntryPoint.
    await set7702Delegate(c, executorEOA.address, await otherDelegate.getAddress());

    // Build a minimal batch payload; EntryPoint should revert before forwarding.
    const gaslessBatchTx = {
      transactions: [
        {
          to: feeReceiverEOA.address,
          value: 0n,
          gasLimit: DEFAULT_CALL_GAS_LIMIT,
          data: "0x",
        },
        {
          to: feeReceiverEOA.address,
          value: 0n,
          gasLimit: DEFAULT_CALL_GAS_LIMIT,
          data: "0x",
        },
      ],
      fee: {
        feeToken: ethers.ZeroAddress,
        maxTokenFee: 0n,
        coinPriceInToken: 0n,
        feeTransferGasLimit: 0n,
        baseGas: 0n,
        feeReceiver: feeReceiverEOA.address,
      },
      nonce: 0n,
    };

    // EntryPoint must reject forwarding because actualDelegate != requiredDelegateAddress.
    await expect(
      entryPoint.executeBatchTransaction(
        gaslessBatchTx,
        "0x1234",
        true,
        executorEOA.address
      )
    )
      .to.be.revertedWithCustomError(entryPoint, "InvalidDelegate")
      .withArgs(
        executorEOA.address,
        await requiredDelegate.getAddress(),
        await otherDelegate.getAddress()
      );
  });

  it("Bubbles executor revert in batch path when delegation matches required delegate", async function () {
    // Load snapshot for a deterministic baseline.
    const {
      c,
      entryPoint,
      requiredDelegate,
      executorEOA,
      feeReceiverEOA,
      randomCaller,
    } = await conn.networkHelpers.loadFixture(deployEntryPointFixture);

    // Use ethers from the same connection used by the fixture.
    const { ethers } = c;

    // Install the required delegate so EntryPoint passes the delegation check and forwards the batch call.
    await set7702Delegate(c, executorEOA.address, await requiredDelegate.getAddress());

    // Build a valid-looking batch payload. EntryPoint only validates delegation and forwards.
    const gaslessBatchTx = {
      transactions: [
        {
          to: feeReceiverEOA.address,
          value: 1n,
          gasLimit: 210_000n,
          data: "0x11223344",
        },
        {
          to: feeReceiverEOA.address,
          value: 2n,
          gasLimit: 220_000n,
          data: "0xaabbccdd",
        },
      ],
      fee: {
        feeToken: ethers.ZeroAddress,
        maxTokenFee: 555n,
        coinPriceInToken: 0n,
        feeTransferGasLimit: 0n,
        baseGas: 0n,
        feeReceiver: feeReceiverEOA.address,
      },
      nonce: 888n,
    };

    // The current mock delegate does not implement the batch path, so the delegated executor reverts.
    // This still covers the EntryPoint "happy path" up to forwarding (i.e. delegate check passed).
    await expect(
      entryPoint.connect(randomCaller).executeBatchTransaction(
        gaslessBatchTx,
        "0x" + "22".repeat(65),
        true,
        executorEOA.address,
        { gasLimit: 5_000_000n }
      )
    ).to.revert(ethers);
  });

  it("Reverts with InvalidDelegate in batch path regardless of external caller", async function () {
    // Pull contracts + actors from a fresh snapshot.
    const { c, entryPoint, requiredDelegate, executorEOA, feeReceiverEOA, randomCaller } =
      await conn.networkHelpers.loadFixture(deployEntryPointFixture);

    // Use ethers from the same connection used by the fixture.
    const { ethers } = c;

    // Build a minimal batch payload; EntryPoint validates delegation before forwarding.
    const gaslessBatchTx = {
      transactions: [
        {
          to: feeReceiverEOA.address,
          value: 0n,
          gasLimit: DEFAULT_CALL_GAS_LIMIT,
          data: "0x",
        },
        {
          to: feeReceiverEOA.address,
          value: 0n,
          gasLimit: DEFAULT_CALL_GAS_LIMIT,
          data: "0x",
        },
      ],
      fee: {
        feeToken: ethers.ZeroAddress,
        maxTokenFee: 0n,
        coinPriceInToken: 0n,
        feeTransferGasLimit: 0n,
        baseGas: 0n,
        feeReceiver: feeReceiverEOA.address,
      },
      nonce: 0n,
    };

    // Do not install delegation designator on executorEOA. The caller should not matter.
    await expect(
      entryPoint
        .connect(randomCaller)
        .executeBatchTransaction(gaslessBatchTx, "0x1234", false, executorEOA.address)
    )
      .to.be.revertedWithCustomError(entryPoint, "InvalidDelegate")
      .withArgs(
        executorEOA.address,
        await requiredDelegate.getAddress(),
        ethers.ZeroAddress
      );
  });
});