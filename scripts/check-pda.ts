import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const pda = new PublicKey('B41hPFm4x1r4uvDiLqNe6kfBaH2qEjfzQwqfDdhoKit7');
const info = await conn.getAccountInfo(pda);
console.log('Position PDA exists:', !!info);
if (info) { console.log('Owner:', info.owner.toBase58(), 'Data len:', info.data.length); }
const mint = new PublicKey('5LecAJucNutfLMczuDeXmVXTDo1ti94NgbJeAWZLvo1L');
const mintInfo = await conn.getAccountInfo(mint);
console.log('Mint exists:', !!mintInfo);
if (mintInfo) { console.log('Mint owner:', mintInfo.owner.toBase58()); }
// Also check an older position from prior tests
const mint2 = new PublicKey('BFr4Ax3DBFHEKgcD6g98UqnPiE8JEULoh4EgGoBxpn4u');
const mint2Info = await conn.getAccountInfo(mint2);
console.log('Prior mint exists:', !!mint2Info);
