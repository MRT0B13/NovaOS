/**
 * Orca Full LP Lifecycle Test — swap SOL→USDC, open, verify, close.
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

  // SOL = tokenA, USDC = tokenB. aToB = sell SOL for USDC
  const inputAmount = new BN(Math.floor(solAmount * 1e9));
  const swapQuote = await sdk.swapQuoteByInputToken(
    pool,
    data.tokenMintA, // SOL (input)
    inputAmount,
    Percentage.fromFraction(10, 1000), // 1% slippage
    sdk.ORCA_WHIRLPOOL_PROGRAM_ID,
    ctx.fetcher,
    sdk.IGNORE_CACHE,
  );

  console.log(`  Quote: ${solAmount} SOL → ~${swapQuote.estimatedAmountOut.toNumber() / 1e6} USDC`);

  const txBuilder = await pool.swap(swapQuote);
  // Build and send manually (Alchemy doesn't support signatureSubscribe websocket)
  const { transaction, signers } = await txBuilder.build();
  // VersionedTransaction.sign expects Signer[]; Legacy uses .sign(...keypairs)
  const allSigners = [wallet, ...signers.filter((s: any) => s.publicKey && !s.publicKey.equals(wallet.publicKey))];
  if ('version' in transaction) {
    // VersionedTransaction
    transaction.sign(allSigners);
  } else {
    // Legacy Transaction
    const latestBlockhash = await conn.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = latestBlockhash.blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(...allSigners);
  }
  const sig = await conn.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  console.log(`  Swap TX: ${sig}`);

  // Poll for confirmation
  for (let i = 0; i < 30; i++) {
    const status = await conn.getSignatureStatuses([sig]);
    if (status.value[0]?.confirmationStatus === 'confirmed' || status.value[0]?.confirmationStatus === 'finalized') {
      console.log(`  Swap confirmed!`);
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return sig;
}

async function main() {
  console.log('\n========================================');
  console.log('  Orca Full LP Lifecycle Test');
  console.log('========================================\n');

  // Step 0: Balances
  console.log('STEP 0: Initial balances');
  const bal0 = await getBalances();
  console.log(`  SOL: ${bal0.sol.toFixed(6)}, USDC: ${bal0.usdc.toFixed(6)}`);

  // Step 1: Swap SOL → USDC if needed (~$2 both sides, swap 0.03 SOL ≈ $2.3)
  if (bal0.usdc < 1.5) {
    console.log('\n========================================');
    console.log('STEP 1: Swap SOL → USDC for LP');
    console.log('========================================');
    await swapSolToUsdc(0.03);
    await new Promise(r => setTimeout(r, 2000));
  }

  const bal1 = await getBalances();
  console.log(`\n  After swap: SOL: ${bal1.sol.toFixed(6)}, USDC: ${bal1.usdc.toFixed(6)}`);

  // Step 2: Open LP position
  console.log('\n========================================');
  console.log('STEP 2: Open LP position');
  console.log('========================================\n');

  const { openPosition, getPositions, closePosition } = await import('../src/launchkit/cfo/orcaService.ts');

  const usdcToUse = Math.min(bal1.usdc, 2);
  const solToUse = 0.025;

  console.log(`  Opening: ${usdcToUse.toFixed(2)} USDC + ${solToUse} SOL, ±10% range`);
  const openResult = await openPosition(usdcToUse, solToUse, 20);
  console.log('  Result:', JSON.stringify(openResult, null, 2));

  if (!openResult.success) {
    console.log(`\n❌ openPosition failed: ${openResult.error}`);
    return;
  }

  console.log(`\n✅ Position opened: ${openResult.positionMint}`);
  console.log(`   Range: $${openResult.lowerPrice?.toFixed(2)} - $${openResult.upperPrice?.toFixed(2)}`);
  console.log(`   TX: ${openResult.txSignature}`);

  // Verify the position PDA exists on-chain before proceeding
  const sdk = await import('@orca-so/whirlpools-sdk');
  const mintPk = new PublicKey(openResult.positionMint!);
  const posPda = sdk.PDAUtil.getPosition(sdk.ORCA_WHIRLPOOL_PROGRAM_ID, mintPk);
  console.log(`   Position PDA: ${posPda.publicKey.toBase58()}`);
  
  await new Promise(r => setTimeout(r, 5000)); // longer wait for chain confirmation
  
  const pdaInfo = await conn.getAccountInfo(posPda.publicKey);
  console.log(`   PDA exists on-chain: ${!!pdaInfo}`);
  if (pdaInfo) {
    console.log(`   PDA owner: ${pdaInfo.owner.toBase58()}`);
  } else {
    console.log('   ⚠️ PDA not found! Checking TX status...');
    const txStatus = await conn.getSignatureStatuses([openResult.txSignature!]);
    console.log(`   TX status:`, txStatus.value[0]);
  }
  await new Promise(r => setTimeout(r, 3000));

  // Step 3: Verify position
  console.log('\n========================================');
  console.log('STEP 3: Verify via getPositions()');
  console.log('========================================\n');

  const positions = await getPositions();
  console.log(`  Found ${positions.length} position(s)`);
  for (const pos of positions) {
    console.log(`  - Mint: ${pos.positionMint}`);
    console.log(`    Range: $${pos.lowerPrice.toFixed(2)} - $${pos.upperPrice.toFixed(2)}`);
    console.log(`    In range: ${pos.inRange}, utilisation: ${pos.rangeUtilisationPct.toFixed(1)}%`);
  }

  // Step 4: Close position
  console.log('\n========================================');
  console.log('STEP 4: Close position');
  console.log('========================================\n');

  const closeResult = await closePosition(openResult.positionMint!);
  console.log('  Result:', JSON.stringify(closeResult, null, 2));

  if (!closeResult.success) {
    console.log(`\n❌ closePosition failed: ${closeResult.error}`);
    console.log('  Position mint:', openResult.positionMint);
    return;
  }

  console.log(`\n✅ Position closed! TX: ${closeResult.txSignature}`);

  // Step 5: Final balance comparison
  await new Promise(r => setTimeout(r, 3000));
  const balFinal = await getBalances();
  console.log('\n========================================');
  console.log('STEP 5: Final balances');
  console.log('========================================');
  console.log(`  SOL: ${balFinal.sol.toFixed(6)} (started: ${bal0.sol.toFixed(6)}, cost: ${(bal0.sol - balFinal.sol).toFixed(6)})`);
  console.log(`  USDC: ${balFinal.usdc.toFixed(6)} (started: ${bal0.usdc.toFixed(6)})`);

  console.log('\n========================================');
  console.log('  ✅ Full Orca LP lifecycle complete!');
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
