const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";

export function log(message, functionName, networkName) {
  const network = networkName ? `${MAGENTA}[${networkName}]${RESET}` : "";

  console.log(`${network}${GREEN}[${functionName}]${RESET}`, message);
}
