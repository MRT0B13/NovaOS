/**
 * Quick Orca SDK integration test.
 * Since we have 0 USDC right now, we just validate:
 *   1. SDK loads and initializes
 *   2. Whirlpool pool data is readable
 *   3. Current SOL/USDC price is fetched
 *   4. getPositions() returns (empty or with existing positions)
 *   5. Tick calculations work for a hypothetical position
 *
 * A full LP open/close test requires USDC — defer that to when the CFO has trading capital.
 */

import 'dotenv/config';

async function main() {
  console.log('\n========================================');
  console.log('  Orca SDK Integration Test');
  console.log('========================================\n');

  // Step 1: Load SDK
  console.log('1. Loading @orca-so/whirlpools-sdk...');
  const sdk = await import('@orca-so/whirlpools-sdk');
  const anchor = await import('@coral-xyz/anchor');
  console.log('   ✓ SDK loaded');
  console.log('   Exports:', Object.keys(sdk).filter(k => !k.startsWith('_')).slice(0, 15).join(', '), '...');

  // Step 2: Initialize Anchor context
  console.log('\n2. Initializing Anchor provider + WhirlpoolContext...');
  const { Connection, Keypair } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;

  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/jkhV9JrR8nf9OmoDwpesjAMdgRgaR0F1';
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {});
  const ctx = sdk.WhirlpoolContext.withProvider(provider);
  const client = sdk.buildWhirlpoolClient(ctx);
  console.log('   ✓ WhirlpoolContext initialized');

  // Step 3: Load SOL/USDC pool
  console.log('\n3. Loading SOL/USDC Whirlpool (0.3% fee tier)...');
  const poolAddress = 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ';
  const { PublicKey } = await import('@solana/web3.js');
  const whirlpool = await client.getPool(new PublicKey(poolAddress));
  const poolData = whirlpool.getData();

  const currentPrice = sdk.PriceMath.sqrtPriceX64ToPrice(
    poolData.sqrtPrice,
    9,  // SOL decimals
    6,  // USDC decimals
  ).toNumber();

  console.log(`   ✓ Pool loaded`);
  console.log(`   Current SOL price: $${currentPrice.toFixed(4)}`);
  console.log(`   Current tick: ${poolData.tickCurrentIndex}`);
  console.log(`   Tick spacing: ${poolData.tickSpacing}`);
  console.log(`   Liquidity: ${poolData.liquidity.toString()}`);
  console.log(`   Fee rate: ${poolData.feeRate / 10000}%`);

  // Step 4: Test tick math
  console.log('\n4. Testing tick math for hypothetical ±10% range...');
  const Decimal = (await import('decimal.js')).default;
  const halfRange = 0.10;
  const currentPriceDec = sdk.PriceMath.sqrtPriceX64ToPrice(poolData.sqrtPrice, 9, 6);
  const lowerPriceDec = currentPriceDec.mul(1 - halfRange);
  const upperPriceDec = currentPriceDec.mul(1 + halfRange);
  const lowerTick = sdk.TickUtil.getInitializableTickIndex(
    sdk.PriceMath.priceToTickIndex(lowerPriceDec, 9, 6),
    poolData.tickSpacing,
  );
  const upperTick = sdk.TickUtil.getInitializableTickIndex(
    sdk.PriceMath.priceToTickIndex(upperPriceDec, 9, 6),
    poolData.tickSpacing,
  );
  console.log(`   Range: $${lowerPriceDec.toFixed(2)} - $${upperPriceDec.toFixed(2)}`);
  console.log(`   Ticks: ${lowerTick} - ${upperTick}`);

  // Step 5: Check for existing positions
  console.log('\n5. Checking getPositions()...');
  const { getPositions } = await import('../src/launchkit/cfo/orcaService.ts');
  const positions = await getPositions();
  console.log(`   Found ${positions.length} existing position(s)`);
  if (positions.length > 0) {
    for (const pos of positions) {
      console.log(`   - ${pos.positionMint.slice(0, 8)}... range: $${pos.lowerPrice.toFixed(2)}-$${pos.upperPrice.toFixed(2)} inRange=${pos.inRange}`);
    }
  }

  // Step 6: Verify openPosition method exists
  console.log('\n6. Checking available pool methods...');
  const poolMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(whirlpool))
    .filter(m => m !== 'constructor' && !m.startsWith('_'));
  console.log(`   Pool methods: ${poolMethods.join(', ')}`);

  console.log('\n========================================');
  console.log('  ✅ Orca SDK integration validated');
  console.log('  (LP open/close deferred — need USDC)');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
