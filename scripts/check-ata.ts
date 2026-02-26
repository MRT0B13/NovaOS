import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';

const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ata = await getAssociatedTokenAddress(USDC, wallet.publicKey);
const info = await conn.getAccountInfo(ata);
console.log('USDC ATA:', ata.toBase58());
console.log('USDC ATA exists:', !!info);
if (info) {
  const balance = Number(info.data.readBigUInt64LE(64));
  console.log('USDC balance (micros):', balance);
}

const sol = await conn.getBalance(wallet.publicKey);
console.log('SOL balance (lamports):', sol);
console.log('SOL balance:', sol / 1e9);
