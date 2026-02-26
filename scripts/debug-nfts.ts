import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));
const WHIRLPOOL_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

// Check standard token accounts
console.log('--- Standard SPL Token accounts (amount=1) ---');
const accts = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_PROGRAM_ID });
for (const { pubkey, account } of accts.value) {
  const parsed = account.data.parsed?.info;
  if (!parsed || parsed.tokenAmount?.uiAmount !== 1) continue;
  console.log(`  Mint: ${parsed.mint} | Amount: ${parsed.tokenAmount.amount} | ATA: ${pubkey.toBase58()}`);

  // Derive PDA
  const mintPk = new PublicKey(parsed.mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('position'), mintPk.toBuffer()],
    WHIRLPOOL_PROGRAM,
  );
  const pdaInfo = await conn.getAccountInfo(pda);
  console.log(`    PDA: ${pda.toBase58()} exists=${!!pdaInfo}`);
}

// Check Token-2022 accounts
console.log('\n--- Token-2022 accounts (amount=1) ---');
const accts2 = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: TOKEN_2022_PROGRAM_ID });
for (const { pubkey, account } of accts2.value) {
  const parsed = account.data.parsed?.info;
  if (!parsed || parsed.tokenAmount?.uiAmount !== 1) continue;
  console.log(`  Mint: ${parsed.mint} | ATA: ${pubkey.toBase58()}`);
}

// Direct check for the new position mint
const newMint = new PublicKey('5KPHUwJwUUVo3oMsAV2iGqQqQAAh5YcMtDD1dEU3Utuw');
const newMintInfo = await conn.getAccountInfo(newMint);
console.log('\n--- Direct check for new position ---');
console.log(`Mint ${newMint.toBase58()} exists: ${!!newMintInfo}`);
if (newMintInfo) console.log(`  Owner: ${newMintInfo.owner.toBase58()}`);

const [newPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('position'), newMint.toBuffer()],
  WHIRLPOOL_PROGRAM,
);
const newPdaInfo = await conn.getAccountInfo(newPda);
console.log(`PDA ${newPda.toBase58()} exists: ${!!newPdaInfo}`);
if (newPdaInfo) console.log(`  Owner: ${newPdaInfo.owner.toBase58()}, Data: ${newPdaInfo.data.length}b`);
