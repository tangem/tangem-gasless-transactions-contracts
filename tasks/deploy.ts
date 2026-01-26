import { HardhatRuntimeEnvironment } from "hardhat/types/hre";

interface DeployTaskArguments {
  type: string
}

export default async function (
  taskArguments: DeployTaskArguments,
  hre: HardhatRuntimeEnvironment,
) {
  const { ethers } = await hre.network.connect();

  let Tangem7702GaslessExecutor;
  if (taskArguments.type == "L1") {
    Tangem7702GaslessExecutor = await ethers.getContractFactory("Tangem7702GaslessExecutorL1");
  } else if (taskArguments.type == "OP") {
    Tangem7702GaslessExecutor = await ethers.getContractFactory("Tangem7702GaslessExecutorOP");
  } else if (taskArguments.type == "OP") {
    Tangem7702GaslessExecutor = await ethers.getContractFactory("Tangem7702GaslessExecutorArbitrum");
  } else {
    throw "Unknown type"
  }
  
  const executor = await Tangem7702GaslessExecutor.deploy();
  await executor.waitForDeployment();

  console.log("Tangem7702GaslessExecutor deployed to:", await executor.getAddress());

  const Tangem7702GaslessEntryPoint = await ethers.getContractFactory("Tangem7702GaslessEntryPoint");
  const entryPoint = await Tangem7702GaslessEntryPoint.deploy(executor);
  await entryPoint.waitForDeployment();

  console.log("Tangem7702GaslessEntryPoint deployed to:", await entryPoint.getAddress());
}