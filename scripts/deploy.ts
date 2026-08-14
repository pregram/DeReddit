import { network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";

// Helper function to replace specific env keys without touching comments or other variables
function updateEnvFile(filePath: string, updates: Record<string, string | number>) {
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️ Warning: Environment file not found at ${filePath}`);
    return;
  }

  let envContent = fs.readFileSync(filePath, "utf8");

  for (const [key, value] of Object.entries(updates)) {
    // [ \t]*, not \s*: \s matches newlines too, so on an empty-value line
    // (KEY=<nothing>) a \s* after "=" would greedily eat through the line
    // break into the next line, corrupting whatever key/value follows.
    const regex = new RegExp(`^(${key}[ \\t]*=[ \\t]*).*$`, "gm");
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `$1${value}`);
    } else {
      // Append if the key was missing
      envContent += `\n${key}=${value}`;
    }
  }

  fs.writeFileSync(filePath, envContent, "utf8");
  console.log(` Updated ${path.relative(process.cwd(), filePath)}`);
}

async function main() {
  const { ethers } = await network.create();

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const oracleAddress = deployer.address;

  console.log("================================================================");
  console.log(`Starting Deployment via Account: ${deployer.address}`);
  console.log("================================================================");

  console.log("\n[1/2] Deploying DeRedditCore...");
  const DeRedditCoreFactory = await ethers.getContractFactory("DeRedditCore");
  const coreContract = await DeRedditCoreFactory.deploy(oracleAddress);

  const coreReceipt = await coreContract.deploymentTransaction()?.wait();
  const coreAddress = await coreContract.getAddress();
  const coreBlock = coreReceipt?.blockNumber ?? await ethers.provider.getBlockNumber();
  console.log(`✔ DeRedditCore deployed to: ${coreAddress} (Block: ${coreBlock})`);

  console.log("\n[2/2] Deploying DeRedditEscrow...");
  const DeRedditEscrowFactory = await ethers.getContractFactory("DeRedditEscrow");
  const escrowContract = await DeRedditEscrowFactory.deploy(coreAddress);

  const escrowReceipt = await escrowContract.deploymentTransaction()?.wait();
  const escrowAddress = await escrowContract.getAddress();
  const escrowBlock = escrowReceipt?.blockNumber ?? await ethers.provider.getBlockNumber();
  console.log(`✔ DeRedditEscrow deployed to: ${escrowAddress} (Block: ${escrowBlock})`);

  // Use the earlier of the two deployment blocks so the indexer's catch-up
  // sync never skips over the other contract's own deployment event.
  const finalStartBlock = coreBlock < escrowBlock ? coreBlock : escrowBlock;

  console.log("\n[3/3] Updating .env files...");

  const rootDir = process.cwd();
  const backendEnvPath = path.join(rootDir, "backend", ".env");
  const frontendEnvPath = path.join(rootDir, "frontend", ".env");

  updateEnvFile(backendEnvPath, {
    CORE_CONTRACT_ADDRESS: coreAddress,
    ESCROW_CONTRACT_ADDRESS: escrowAddress,
    DEPLOYMENT_BLOCK: finalStartBlock,
  });

  updateEnvFile(frontendEnvPath, {
    VITE_CORE_CONTRACT_ADDRESS: coreAddress,
    VITE_ESCROW_CONTRACT_ADDRESS: escrowAddress,
  });

  console.log("\n=================== DEPLOYMENT SUMMARY ===================");
  console.log(`DEPLOYMENT_BLOCK=${finalStartBlock}`);
  console.log(`CORE_CONTRACT_ADDRESS=${coreAddress}`);
  console.log(`ESCROW_CONTRACT_ADDRESS=${escrowAddress}`);
  console.log("==========================================================\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed with error:", error);
    process.exit(1);
  });