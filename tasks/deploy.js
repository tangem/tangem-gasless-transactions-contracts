import { task } from "hardhat/config";
import { ArgumentType } from "hardhat/types/arguments";
import { compile, deployContract, getSigner } from "./utils/contracts.js";
import { executorArgs, resolveDeploymentParameters } from "./utils/deployment.js";
import { log } from "./utils/log.js";

async function deploy(hre, args) {
  const connection = await hre.network.connect();
  const parameters = await resolveDeploymentParameters(connection, args);
  const deployer = await getSigner(connection);

  log(`deployer ${deployer.address}, parameters ${JSON.stringify(parameters)}`, "deploy", connection.networkName);

  const executor = await deployContract(hre, connection, "Tangem7702GaslessExecutor", executorArgs(parameters));
  await deployContract(hre, connection, "Tangem7702GaslessEntryPoint", [await executor.getAddress()]);

  log("deployment complete", "deploy", connection.networkName);
}

export const deployTask = task("deploy", "Deploys Tangem7702GaslessExecutor and the Tangem7702GaslessEntryPoint bound to it")
  .addOption({
    name: "baseGasAfterCall",
    description: "Overrides the configured gas reserved after the user call",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
  })
  .addOption({
    name: "l1FeeMode",
    description: "Overrides the configured L1 data fee source: None (0), Arbitrum (1) or OpStack (2)",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
  })
  .addOption({
    name: "coldAccountAccessCost",
    description: "Overrides the configured gas of a CALL to a cold address",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
  })
  .addOption({
    name: "valueTransferCost",
    description: "Overrides the configured extra gas of a CALL with value",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
  })
  .addOption({
    name: "newAccountCost",
    description: "Overrides the configured extra gas of a CALL creating an account",
    type: ArgumentType.STRING_WITHOUT_DEFAULT,
  })
  .setAction(async () => ({
    default: async (args, hre) => {
      await compile(hre);
      await deploy(hre, args);
    },
  }))
  .build();
