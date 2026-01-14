import { HardhatRuntimeEnvironment } from "hardhat/types/hre";

interface DeployTaskArguments {
  // No argument in this case
}

export default async function (
  taskArguments: DeployTaskArguments,
  hre: HardhatRuntimeEnvironment,
) {
  const { ethers } = await hre.network.connect();

  const Tangem7702GaslessExecutor = await ethers.getContractFactory("Tangem7702GaslessExecutor");
  const executor = await Tangem7702GaslessExecutor.deploy();
  await executor.waitForDeployment();

  console.log("Tangem7702GaslessExecutor deployed to:", await executor.getAddress());

  const Tangem7702GaslessEntryPoint = await ethers.getContractFactory("Tangem7702GaslessEntryPoint");
  const entryPoint = await Tangem7702GaslessEntryPoint.deploy(executor);
  await entryPoint.waitForDeployment();

  console.log("Tangem7702GaslessEntryPoint deployed to:", await entryPoint.getAddress());
}