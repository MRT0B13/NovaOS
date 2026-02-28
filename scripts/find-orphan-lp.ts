#!/usr/bin/env bun
/**
 * find-orphan-lp.ts — Find the LP position minted by the first test run
 * and close it. The tx hash was: 0x8d0dc7fb3aa7310034121603ad6197c68b61bc25e37225928c012d3d4b32303a
 *
 * Usage:  bun run scripts/find-orphan-lp.ts
 */

import 'dotenv/config';

async function main() {
  const { getEvmProvider } = await import('../src/launchkit/cfo/krystalService.ts');
  const ethers = await import('ethers' as string);

  const provider = await getEvmProvider(8453); // Base

  // 1. Read the tx receipt to find the tokenId
  const txHash = '0x8d0dc7fb3aa7310034121603ad6197c68b61bc25e37225928c012d3d4b32303a';
  console.log(`Fetching receipt for ${txHash}...`);
  const receipt = await provider.getTransactionReceipt(txHash);

  if (!receipt) {
    console.log('Receipt not found — tx may not have been confirmed');
    return;
  }

  console.log(`Receipt found: ${receipt.logs.length} logs, status=${receipt.status}`);

  // ERC721 Transfer signature
  const transferSig = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  // IncreaseLiquidity signature
  const incLiqSig = ethers.id('IncreaseLiquidity(uint256,uint128,uint256,uint256)');

  let tokenId: string | undefined;

  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i];
    const topics = log.topics;
    console.log(`  Log #${i}: address=${log.address}, topics=${topics.length}`);
    console.log(`    topic[0]=${topics[0]?.slice(0, 18)}...`);

    if (topics.length === 4 && topics[0] === transferSig) {
      const id = BigInt(topics[3]).toString();
      console.log(`    → ERC721 Transfer: tokenId=${id}`);
      tokenId = id;
    }

    if (topics[0] === incLiqSig) {
      const id = BigInt(topics[1]).toString();
      console.log(`    → IncreaseLiquidity: tokenId=${id}`);
      if (!tokenId) tokenId = id;
    }
  }

  if (!tokenId) {
    console.log('\nNo tokenId found in logs — position may not have been minted');
    return;
  }

  console.log(`\nFound tokenId: ${tokenId}`);

  // 2. Check if the position still has liquidity
  const NFPM_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
  const NFPM_ABI = [
    'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  ];
  const nfpm = new ethers.Contract(NFPM_ADDRESS, NFPM_ABI, provider);

  try {
    const posData = await nfpm.positions(tokenId);
    const liquidity = posData.liquidity ?? posData[7];
    console.log(`Position liquidity: ${liquidity.toString()}`);

    if (liquidity === BigInt(0)) {
      console.log('Position has zero liquidity — nothing to close');
      return;
    }

    // 3. Close it
    console.log('\nClosing orphaned position...');
    const { closeEvmLpPosition } = await import('../src/launchkit/cfo/krystalService.ts');
    const result = await closeEvmLpPosition({
      posId: tokenId,
      chainId: 'base@8453',
      chainNumericId: 8453,
      token0: { address: posData.token0, symbol: 'WETH', decimals: 18 },
      token1: { address: posData.token1, symbol: 'USDC', decimals: 6 },
    });

    if (result.success) {
      console.log(`✅ Closed! tx=${result.txHash}`);
      console.log(`   Recovered: $${result.valueRecoveredUsd.toFixed(2)}`);
    } else {
      console.log(`❌ Close failed: ${result.error}`);
    }
  } catch (err: any) {
    console.log(`Position read failed: ${err.message}`);
    console.log('Position may not exist at this NFPM address on Base');
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
