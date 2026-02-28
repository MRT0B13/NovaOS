import 'dotenv/config';
import { ethers } from 'ethers';

const pk = process.env.CFO_EVM_PRIVATE_KEY!;
const rpc = process.env.CFO_POLYGON_RPC_URL!;
const provider = new ethers.JsonRpcProvider(rpc);
const wallet = new ethers.Wallet(pk, provider);

console.log('Wallet:', wallet.address);

// Check NFPM balance (how many NFTs we own)
const NFPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const nfpm = new ethers.Contract(NFPM, [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
], provider);

const balance = await nfpm.balanceOf(wallet.address);
console.log('LP NFTs owned:', balance.toString());

for (let i = 0; i < Number(balance); i++) {
  const tokenId = await nfpm.tokenOfOwnerByIndex(wallet.address, i);
  console.log(`  tokenId: ${tokenId.toString()}`);
  
  // Get position details
  const pos = await nfpm.positions(tokenId);
  console.log(`    token0: ${pos[2]}`);
  console.log(`    token1: ${pos[3]}`);
  console.log(`    fee: ${pos[4]}`);
  console.log(`    tickLower: ${pos[5]}`);
  console.log(`    tickUpper: ${pos[6]}`);
  console.log(`    liquidity: ${pos[7].toString()}`);
}

// Check token balances
const WPOL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
const USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const wpolC = new ethers.Contract(WPOL, ['function balanceOf(address) view returns (uint256)'], provider);
const usdcC = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
const nativeBal = await provider.getBalance(wallet.address);

console.log('\nBalances:');
console.log('  MATIC:', ethers.formatEther(nativeBal));
console.log('  WPOL:', ethers.formatEther(await wpolC.balanceOf(wallet.address)));
console.log('  USDC:', ethers.formatUnits(await usdcC.balanceOf(wallet.address), 6));
