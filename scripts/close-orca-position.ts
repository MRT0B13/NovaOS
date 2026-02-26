/**
 * Standalone close test for an Orca position.
 * Usage: bun run scripts/close-orca-position.ts <positionMint>
 */
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

const POSITION_MINT = process.argv[2] || '5LecAJucNutfLMczuDeXmVXTDo1ti94NgbJeAWZLvo1L';

async function buildSendAndConfirm(txBuilder: any): Promise<string> {
  console.log('  Building transaction...');
  const { transaction, signers } = await txBuilder.build();
  console.log('  Transaction type:', transaction.constructor.name);
  console.log('  Signers count:', signers.length);

  const allSigners = [wallet, ...signers.filter((s: any) => s.publicKey && !s.publicKey.equals(wallet.publicKey))];
  if ('version' in transaction) {
    transaction.sign(allSigners);
  } else {
    const bh = await conn.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = bh.blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(...allSigners);
  }

  console.log('  Sending transaction...');
  const sig = await conn.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  console.log('  TX:', sig);

  // Poll for confirmation
  for (let i = 0; i < 60; i++) {
    const status = await conn.getSignatureStatuses([sig]);
    const val = status.value[0];
    if (val?.err) throw new Error(`TX failed: ${JSON.stringify(val.err)}`);
    if (val?.confirmationStatus === 'confirmed' || val?.confirmationStatus === 'finalized') {
      console.log('  Confirmed!');
      return sig;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('  Confirmation timed out, but TX may still land');
  return sig;
}

async function main() {
  console.log(`\nClosing Orca position: ${POSITION_MINT}`);

  const sdk = await import('@orca-so/whirlpools-sdk');
  const { AnchorProvider, Wallet } = await import('@coral-xyz/anchor');
  const { Percentage } = await import('@orca-so/common-sdk');

  const provider = new AnchorProvider(conn, new Wallet(wallet), {});
  const ctx = sdk.WhirlpoolContext.withProvider(provider);
  const client = sdk.buildWhirlpoolClient(ctx);

  // Derive PDA from mint
  const mintPk = new PublicKey(POSITION_MINT);
  const positionPda = sdk.PDAUtil.getPosition(sdk.ORCA_WHIRLPOOL_PROGRAM_ID, mintPk);
  console.log('Position PDA:', positionPda.publicKey.toBase58());

  // Fetch position
  console.log('Fetching position data...');
  const position = await client.getPosition(positionPda.publicKey);
  const posData = position.getData();
  console.log('  Whirlpool:', posData.whirlpool.toBase58());
  console.log('  Liquidity:', posData.liquidity.toString());
  console.log('  Tick range:', posData.tickLowerIndex, '-', posData.tickUpperIndex);

  // Get whirlpool
  console.log('Fetching whirlpool...');
  const whirlpool = await client.getPool(posData.whirlpool);

  // Build close TXs
  console.log('Building close position transactions...');
  const closeTxs = await whirlpool.closePosition(
    positionPda.publicKey,
    Percentage.fromFraction(10, 1000),
    wallet.publicKey,
    wallet.publicKey,
    wallet.publicKey,
  );

  console.log(`Got ${closeTxs.length} transaction(s) to execute`);

  for (let i = 0; i < closeTxs.length; i++) {
    console.log(`\nExecuting TX ${i + 1}/${closeTxs.length}...`);
    try {
      const sig = await buildSendAndConfirm(closeTxs[i]);
      console.log(`  ✅ TX ${i + 1} complete: ${sig}`);
    } catch (e) {
      console.error(`  ❌ TX ${i + 1} failed:`, (e as Error).message);
      throw e;
    }
  }

  console.log('\n✅ Position closed successfully!');
}

main().catch(e => {
  console.error('\nFatal:', e);
  process.exit(1);
});
