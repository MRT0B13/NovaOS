import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

const sdk = await import('@orca-so/whirlpools-sdk');
const anchor = await import('@coral-xyz/anchor');

const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), {});
const ctx = sdk.WhirlpoolContext.withProvider(provider);
const client = sdk.buildWhirlpoolClient(ctx);

const pool = await client.getPool(new PublicKey('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'));
const data = pool.getData();

console.log('tokenMintA:', data.tokenMintA.toBase58());
console.log('tokenMintB:', data.tokenMintB.toBase58());
console.log('SOL  mint: So11111111111111111111111111111111111111112');
console.log('USDC mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
