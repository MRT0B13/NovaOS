#!/usr/bin/env bun
/**
 * Debug Jito stake pool — reproduce "Invalid public key input" error
 */
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

const RPC = 'https://solana-mainnet.g.alchemy.com/v2/jkhV9JrR8nf9OmoDwpesjAMdgRgaR0F1';
const conn = new Connection(RPC, 'confirmed');
const JITO_POOL = new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Posko');
const JITOSOL_MINT = new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');

async function main() {
  console.log('1) Fetching stake pool account...');
  const acctInfo = await conn.getAccountInfo(JITO_POOL);
  if (!acctInfo) { console.log('Account not found!'); return; }
  console.log(`   owner: ${acctInfo.owner.toBase58()}`);
  console.log(`   data length: ${acctInfo.data.length} bytes`);

  console.log('\n2) Decoding via spl-stake-pool...');
  try {
    const spl = await import('@solana/spl-stake-pool');
    const pool = await spl.getStakePoolAccount(conn, JITO_POOL);
    console.log(`   manager: ${pool.account.data.manager.toBase58()}`);
    console.log(`   staker: ${pool.account.data.staker.toBase58()}`);
    console.log('   ✅ Pool parsed OK');
  } catch (e: any) {
    console.error('   ❌ getStakePoolAccount error:', e.message);
  }

  console.log('\n3) Testing depositSol (dry — just instruction build, no send)...');
  try {
    const spl = await import('@solana/spl-stake-pool');

    // Use a random keypair (we won't actually send)
    const fakeWallet = Keypair.generate();
    const lamports = Math.floor(0.1 * LAMPORTS_PER_SOL);

    // Get/derive ATA for JitoSOL
    const splToken = await import('@solana/spl-token');
    const ata = splToken.getAssociatedTokenAddressSync(JITOSOL_MINT, fakeWallet.publicKey);
    console.log(`   ATA: ${ata.toBase58()}`);

    const { instructions, signers } = await spl.depositSol(
      conn,
      JITO_POOL,
      fakeWallet.publicKey,
      lamports,
      ata,
    );
    console.log(`   ✅ depositSol built ${instructions.length} instructions, ${signers.length} signers`);
  } catch (e: any) {
    console.error('   ❌ depositSol error:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  }
}

main().catch(console.error);
