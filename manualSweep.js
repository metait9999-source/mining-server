// manualSweepETH.js
require("dotenv").config();
const { ethers } = require("ethers");
const db = require("./config/db.config");
const { deriveAllWallets } = require("./services/walletDerivation");
const { getMasterWallets } = require("./services/masterWallet");

// ── Fallback RPC list ────────────────────────────────────────────────────────
// If Alchemy is down/broken, it tries the next one automatically
const RPC_LIST = [
  process.env.ETH_RPC_URL, // your Alchemy (primary)
  "https://eth.llamarpc.com", // LlamaRPC (free, no key)
  "https://rpc.ankr.com/eth", // Ankr (free tier)
  "https://cloudflare-eth.com", // Cloudflare
  "https://ethereum.publicnode.com", // PublicNode
].filter(Boolean);

const USDT_ERC20_CONTRACT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDT_ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
const ETH_GAS_RESERVE = "0.005";

async function getWorkingProvider() {
  for (const url of RPC_LIST) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      await provider.getBlockNumber(); // simple connectivity check
      console.log(`✅ RPC connected: ${url}`);
      return provider;
    } catch (err) {
      console.warn(`⚠️  RPC failed: ${url} → ${err.message}`);
    }
  }
  throw new Error("All RPC providers failed. Check your network or API keys.");
}

// ── Sweep ETH ────────────────────────────────────────────────────────────────
async function sweepETH(provider, master, wallets) {
  const signer = new ethers.Wallet("0x" + wallets.privateKeys.eth, provider);
  const feeData = await provider.getFeeData();
  const gasLimit = 21000n;
  const gasCost = feeData.gasPrice * gasLimit;
  const balance = await provider.getBalance(signer.address);
  const sweepable = balance - gasCost;

  if (sweepable <= 0n) {
    console.log(
      `   ⚠️  ETH: nothing to sweep (bal=${ethers.formatEther(balance)} ETH)`,
    );
    return null;
  }

  const tx = await signer.sendTransaction({
    to: master.eth,
    value: sweepable,
    gasLimit,
    gasPrice: feeData.gasPrice,
  });
  await tx.wait();
  console.log(
    `   ✅ ETH: ${ethers.formatEther(sweepable)} ETH → ${master.eth} | ${tx.hash}`,
  );
  return tx.hash;
}

// ── Sweep USDT-ERC20 ─────────────────────────────────────────────────────────
async function sweepUSDT(provider, master, wallets) {
  const signer = new ethers.Wallet("0x" + wallets.privateKeys.eth, provider);
  const masterW = new ethers.Wallet(
    "0x" + process.env.SWEEP_PRIVATE_KEY_ETH,
    provider,
  );
  const contract = new ethers.Contract(
    USDT_ERC20_CONTRACT,
    USDT_ERC20_ABI,
    signer,
  );

  const rawBalance = await contract.balanceOf(signer.address);
  const usdtBalance = Number(rawBalance) / 1_000_000;

  if (usdtBalance <= 0) {
    console.log(`   ⚠️  USDT-ERC20: nothing to sweep`);
    return null;
  }

  // Fund gas if needed
  const ethBalance = await provider.getBalance(signer.address);
  const gasReserve = ethers.parseEther(ETH_GAS_RESERVE);
  if (ethBalance < gasReserve) {
    const fundTx = await masterW.sendTransaction({
      to: signer.address,
      value: gasReserve - ethBalance,
    });
    await fundTx.wait();
    console.log(`   ⛽ Gas funded for USDT transfer`);
  }

  const tx = await contract.transfer(master.usdt_erc20, rawBalance);
  await tx.wait();
  console.log(
    `   ✅ USDT-ERC20: ${usdtBalance} USDT → ${master.usdt_erc20} | ${tx.hash}`,
  );
  return tx.hash;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const provider = await getWorkingProvider();
  const master = await getMasterWallets();

  const [users] = await db.query(
    `SELECT id, hd_index, wallet_eth
       FROM meta_ct_user
      WHERE hd_index IS NOT NULL`,
  );

  console.log(`\nFound ${users.length} users — sweeping ETH + USDT-ERC20\n`);
  console.log("─".repeat(60));

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const user of users) {
    console.log(
      `\n👤 User ${user.id} | index ${user.hd_index} | ${user.wallet_eth}`,
    );

    try {
      const wallets = deriveAllWallets(
        process.env.WALLET_MNEMONIC,
        user.hd_index,
      );

      // ETH first (so gas is available for USDT)
      const ethTx = await sweepETH(provider, master, wallets);
      const usdtTx = await sweepUSDT(provider, master, wallets);

      if (ethTx || usdtTx) successCount++;
      else skipCount++;
    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      errorCount++;
    }

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("\n" + "─".repeat(60));
  console.log(
    `✅ Done — swept: ${successCount} | skipped: ${skipCount} | errors: ${errorCount}`,
  );
  process.exit(0);
}

main();
