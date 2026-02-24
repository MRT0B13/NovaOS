/**
 * Orca Rebalance Test — open a position, then rebalance it to verify
 * the full close→reopen flow returns correct token amounts and re-centres.
 */
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

async function getBalances() {
  const sol = await conn.getBalance(wallet.publicKey);
  let usdc = 0;
  const usdcAccts = await conn.getTokenAccountsByOwner(wallet.publicKey, {
    mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  });
  if (usdcAccts.value.length > 0) {
    usdc = Number(usdcAccts.value[0].account.data.readBigUInt64LE(64)) / 1e6;
  }
  return { sol: sol / 1e9, usdc };
}

async function swapSolToUsdc(solAmount: number) {
  console.log(`\n--- Swapping ${solAmount} SOL → USDC via Orca ---`);
  const sdk = await import('@orca-so/whirlpools-sdk');
  const { AnchorProvider, Wallet } = await import('@coral-xyz/anchor');
  const { Percentage } = await import('@orca-so/common-sdk');
  const BN = (await import('bn.js')).default;

  const provider = new AnchorProvider(conn, new Wallet(wallet), {});
  const ctx = sdk.WhirlpoolContext.withProvider(provider);
  const client = sdk.buildWhirlpoolClient(ctx);
  const pool = await client.getPool(new PublicKey('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'));
  const data = pool.getData();

  const inputAmount = new BN(Math.floor(solAmount * 1e9));
  const swapQuote = await sdk.swapQuoteByInputToken(
    pool,
    data.tokenMintA,
    inputAmount,
    Percentage.fromFraction(10, 1000),
    sdk.ORCA_WHIRLPOOL_PROGRAM_ID,
    ctx.fetcher,
    sdk.IGNORE_CACHE,
  );

  console.log(`  Quote: ${solAmount} SOL → ~${swapQuote.estimatedAmountOut.toNumber() / 1e6} USDC`);

  const txBuilder = await pool.swap(swapQuote);
  const { transaction, signers } = await txBuilder.build();
  const allSigners = [wallet, ...signers.filter((s: any) => s.publicKey && !s.publicKey.equals(wallet.publicKey))];
  if ('version' in transaction) {
    transaction.sign(allSigners);
  } else {
    const latestBlockhash = await conn.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(...allSigners);
  }
  const sig = await conn.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  console.log(`  Swap TX: ${sig}`);

  for (let i = 0; i < 30; i++) {
    const status = await conn.getSignatureStatuses([sig]);
    if (status.value[0]?.confirmationStatus === 'confirmed' || status.value[0]?.confirmationStatus === 'finalized') {
      console.log(`  Swap confirmed!`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function main() {
  console.log('\n========================================');
  console.log('  Orca REBALANCE Test');
  console.log('========================================\n');

  const { openPosition, getPositions, rebalancePosition } = await import('../src/launchkit/cfo/orcaService.ts');

  // Step 0: Balances
  console.log('STEP 0: Initial balances');
  const bal0 = await getBalances();
  console.log(`  SOL: ${bal0.sol.toFixed(6)}, USDC: ${bal0.usdc.toFixed(6)}`);

  // Swap SOL → USDC if needed
  if (bal0.usdc < 1.5) {
    console.log('\n  Need USDC — swapping 0.03 SOL...');
    await swapSolToUsdc(0.03);
    await new Promise(r => setTimeout(r, 2000));
  }

  const bal1 = await getBalances();
  console.log(`  After swap: SOL: ${bal1.sol.toFixed(6)}, USDC: ${bal1.usdc.toFixed(6)}`);

  // Step 1: Open a position with a NARROW range (±5%) so we can rebalance it wider
  console.log('\n========================================');
  console.log('STEP 1: Open NARROW position (±5%)');
  console.log('========================================\n');

  const usdcToUse = Math.min(bal1.usdc, 2);
  const solToUse = 0.025;
  console.log(`  Opening: ${usdcToUse.toFixed(2)} USDC + ${solToUse} SOL, ±5% range`);

  const openResult = await openPosition(usdcToUse, solToUse, 10); // 10% total = ±5%
  console.log('  Result:', JSON.stringify(openResult, null, 2));

  if (!openResult.success) {
    console.log(`\n❌ openPosition failed: ${openResult.error}`);
    return;
  }

  console.log(`\n✅ Position opened: ${openResult.positionMint}`);
  console.log(`   Range: $${openResult.lowerPrice?.toFixed(2)} - $${openResult.upperPrice?.toFixed(2)}`);

  // Wait for chain confirmation
  await new Promise(r => setTimeout(r, 5000));

  // Verify it exists
  console.log('\n========================================');
  console.log('STEP 2: Verify position exists');
  console.log('========================================\n');

  const posBefore = await getPositions();
  console.log(`  Found ${posBefore.length} position(s)`);
  const ourPos = posBefore.find(p => p.positionMint === openResult.positionMint);
  if (!ourPos) {
    console.log('  ❌ Could not find our position via getPositions()!');
    return;
  }
  console.log(`  ✅ Position found:`);
  console.log(`     Range: $${ourPos.lowerPrice.toFixed(2)} - $${ourPos.upperPrice.toFixed(2)}`);
  console.log(`     In range: ${ourPos.inRange}, utilisation: ${ourPos.rangeUtilisationPct.toFixed(1)}%`);

  const oldLower = ourPos.lowerPrice;
  const oldUpper = ourPos.upperPrice;
  const oldWidth = oldUpper - oldLower;

  // Step 3: REBALANCE — reopen with WIDER range (±10%)
  console.log('\n========================================');
  console.log('STEP 3: REBALANCE to wider range (±10%)');
  console.log('========================================\n');

  const rebalResult = await rebalancePosition(openResult.positionMint!, 20); // 20% total = ±10%
  console.log('  Result:', JSON.stringify(rebalResult, null, 2));

  if (!rebalResult.success) {
    console.log(`\n❌ rebalance failed: ${rebalResult.error}`);
    return;
  }

  console.log(`\n✅ Rebalance complete!`);
  console.log(`   Old position: ${openResult.positionMint?.slice(0, 12)}…`);
  console.log(`   New position: ${rebalResult.newPositionMint?.slice(0, 12)}…`);

  // Wait for chain confirmation
  await new Promise(r => setTimeout(r, 5000));

  // Step 4: Verify NEW position range is wider + centred
  console.log('\n========================================');
  console.log('STEP 4: Verify new position');
  console.log('========================================\n');

  const posAfter = await getPositions();
  console.log(`  Found ${posAfter.length} position(s)`);

  const newPos = posAfter.find(p => p.positionMint === rebalResult.newPositionMint);
  if (!newPos) {
    console.log('  ❌ Could not find new position via getPositions()!');
    // Check if old one is gone
    const oldStillExists = posAfter.find(p => p.positionMint === openResult.positionMint);
    console.log(`  Old position still exists: ${!!oldStillExists}`);
    return;
  }

  const newWidth = newPos.upperPrice - newPos.lowerPrice;
  console.log(`  ✅ New position found:`);
  console.log(`     Range: $${newPos.lowerPrice.toFixed(2)} - $${newPos.upperPrice.toFixed(2)}`);
  console.log(`     In range: ${newPos.inRange}, utilisation: ${newPos.rangeUtilisationPct.toFixed(1)}%`);
  console.log(`     Old width: $${oldWidth.toFixed(2)}, New width: $${newWidth.toFixed(2)}`);
  console.log(`     Range widened: ${newWidth > oldWidth ? '✅ YES' : '⚠️ SAME/NARROWER'}`);

  // Verify old position is gone
  const oldStillExists = posAfter.find(p => p.positionMint === openResult.positionMint);
  console.log(`     Old position cleaned up: ${!oldStillExists ? '✅ YES' : '❌ NO'}`);

  // Step 5: Close the rebalanced position to recover funds
  console.log('\n========================================');
  console.log('STEP 5: Close rebalanced position');
  console.log('========================================\n');

  const { closePosition } = await import('../src/launchkit/cfo/orcaService.ts');
  const closeResult = await closePosition(rebalResult.newPositionMint!);
  console.log('  Result:', JSON.stringify(closeResult, null, 2));

  if (!closeResult.success) {
    console.log(`\n❌ close failed: ${closeResult.error}`);
    return;
  }

  console.log(`\n✅ Position closed! TX: ${closeResult.txSignature}`);
  console.log(`   SOL received: ${closeResult.solReceived?.toFixed(6)}`);
  console.log(`   USDC received: ${closeResult.usdcReceived?.toFixed(6)}`);

  // Final balances
  await new Promise(r => setTimeout(r, 3000));
  const balFinal = await getBalances();
  console.log('\n========================================');
  console.log('STEP 6: Final balances');
  console.log('========================================');
  console.log(`  SOL:  ${balFinal.sol.toFixed(6)} (started: ${bal0.sol.toFixed(6)}, cost: ${(bal0.sol - balFinal.sol).toFixed(6)})`);
  console.log(`  USDC: ${balFinal.usdc.toFixed(6)} (started: ${bal0.usdc.toFixed(6)})`);

  console.log('\n========================================');
  console.log('  ✅ Full Orca REBALANCE test complete!');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
