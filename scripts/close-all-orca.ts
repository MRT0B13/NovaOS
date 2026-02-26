/**
 * Close Orca positions using simplified approach:
 * - Skip separate getPosition() call
 * - Call whirlpool.closePosition() directly (it fetches with IGNORE_CACHE)
 * - Close ALL open positions found.
 */
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

const WHIRLPOOL = 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ';
const WHIRLPOOL_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

async function buildSendAndConfirm(txBuilder: any): Promise<string> {
  const { transaction, signers } = await txBuilder.build();
  const allSigners = [wallet, ...signers.filter((s: any) => s.publicKey && !s.publicKey.equals(wallet.publicKey))];
  if ('version' in transaction) {
    transaction.sign(allSigners);
  } else {
    const bh = await conn.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = bh.blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(...allSigners);
  }
  const sig = await conn.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
  console.log(`    TX: ${sig}`);
  for (let i = 0; i < 60; i++) {
    const status = await conn.getSignatureStatuses([sig]);
    const val = status.value[0];
    if (val?.err) throw new Error(`TX failed: ${JSON.stringify(val.err)}`);
    if (val?.confirmationStatus === 'confirmed' || val?.confirmationStatus === 'finalized') {
      return sig;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return sig;
}

async function main() {
  const sdk = await import('@orca-so/whirlpools-sdk');
  const { AnchorProvider, Wallet } = await import('@coral-xyz/anchor');
  const { Percentage } = await import('@orca-so/common-sdk');
  const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

  const provider = new AnchorProvider(conn, new Wallet(wallet), {});
  const ctx = sdk.WhirlpoolContext.withProvider(provider);
  const client = sdk.buildWhirlpoolClient(ctx);

  // Step 1: Find all whirlpool position NFTs in wallet
  console.log('\n--- Finding Orca position NFTs ---');
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });

  const positionMints: string[] = [];
  for (const { account } of tokenAccounts.value) {
    const parsed = account.data.parsed?.info;
    if (!parsed || parsed.tokenAmount?.uiAmount !== 1) continue;

    const mintPk = new PublicKey(parsed.mint);
    const pda = sdk.PDAUtil.getPosition(sdk.ORCA_WHIRLPOOL_PROGRAM_ID, mintPk);

    // Check if this PDA has data on-chain
    const pdaInfo = await conn.getAccountInfo(pda.publicKey);
    if (pdaInfo && pdaInfo.owner.equals(sdk.ORCA_WHIRLPOOL_PROGRAM_ID)) {
      console.log(`  Found position: mint=${parsed.mint.slice(0, 12)}… PDA=${pda.publicKey.toBase58().slice(0, 12)}… data=${pdaInfo.data.length}b`);
      positionMints.push(parsed.mint);
    }
  }

  console.log(`\nFound ${positionMints.length} Orca position(s)`);
  if (positionMints.length === 0) {
    console.log('No positions to close.');

    // Also check PDAs directly for our known mints
    const knownMints = [
      '5LecAJucNutfLMczuDeXmVXTDo1ti94NgbJeAWZLvo1L',
      'BFr4Ax3DBFHEKgcD6g98UqnPiE8JEULoh4EgGoBxpn4u',
      '4NdY5qhBLF8HrRRNzBxg6x6c1eoq2W5kH7iLFXgYJ7t8',
    ];
    console.log('\n--- Direct PDA checks for known mints ---');
    for (const m of knownMints) {
      const mk = new PublicKey(m);
      const pda = sdk.PDAUtil.getPosition(sdk.ORCA_WHIRLPOOL_PROGRAM_ID, mk);
      const info = await conn.getAccountInfo(pda.publicKey);
      const mintInfo = await conn.getAccountInfo(mk);
      console.log(`  ${m.slice(0, 12)}…: PDA exists=${!!info}, Mint exists=${!!mintInfo}`);
    }

    // Check SDK's ORCA_WHIRLPOOL_PROGRAM_ID
    console.log('\nORCA_WHIRLPOOL_PROGRAM_ID:', sdk.ORCA_WHIRLPOOL_PROGRAM_ID.toBase58());
    return;
  }

  // Step 2: Get pool and close each position
  const whirlpool = await client.getPool(new PublicKey(WHIRLPOOL));

  for (const mint of positionMints) {
    const mintPk = new PublicKey(mint);
    const pda = sdk.PDAUtil.getPosition(sdk.ORCA_WHIRLPOOL_PROGRAM_ID, mintPk);
    console.log(`\nClosing position: ${mint.slice(0, 16)}…`);

    try {
      const closeTxs = await whirlpool.closePosition(
        pda.publicKey,
        Percentage.fromFraction(10, 1000),
        wallet.publicKey,
        wallet.publicKey,
        wallet.publicKey,
      );

      console.log(`  ${closeTxs.length} TX(s) to execute`);
      for (let i = 0; i < closeTxs.length; i++) {
        console.log(`  Executing TX ${i + 1}/${closeTxs.length}...`);
        const sig = await buildSendAndConfirm(closeTxs[i]);
        console.log(`  ✅ Done: ${sig}`);
      }
    } catch (e) {
      console.error(`  ❌ Close failed:`, (e as Error).message);
    }
  }

  console.log('\n✅ All positions closed');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
