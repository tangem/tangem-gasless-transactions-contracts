import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import { log } from "./log.js";

/** Custom tasks are not built automatically. Production is the profile hardhat-verify submits. */
export async function compile(hre) {
  await hre.tasks.getTask("build").run({ defaultBuildProfile: "production" });
}

export async function getSigner({ ethers }) {
  const [signer] = await ethers.getSigners();

  if (!signer) {
    throw new Error("No signer available. Set PRIVATE_KEY or MNEMONIC in .env");
  }

  return signer;
}

export async function deployContract(hre, { ethers, networkName }, contractName, args = []) {
  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  log(`deployed to ${address}`, contractName, networkName);

  if (process.env.EXPLORER_VERIFY === "true") {
    // Explorers index a new contract with a delay.
    await contract.deploymentTransaction().wait(5);
    await verifyContract({ address, constructorArgs: args, provider: "etherscan" }, hre);
  }

  return contract;
}
