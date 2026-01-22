import { Connection, PublicKey } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// DUMP token mint
const DUMP_MINT = 'FcPrcJP3Mp9dNDoBJVquhQc1tvwSMq1c9D2rCw5apump';
const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

async function parseBondingCurve() {
  const mint = new PublicKey(DUMP_MINT);
  
  // Derive the bonding curve PDA
  const [bondingCurvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  console.log('Derived bonding curve PDA:', bondingCurvePda.toString());
  
  const accountInfo = await connection.getAccountInfo(bondingCurvePda);
  if (!accountInfo) {
    console.log('Account not found');
    return;
  }
  
  const data = accountInfo.data;
  console.log('Data length:', data.length);
  
  // Parse the bonding curve data
  // Skip 8-byte discriminator
  const offset = 8;
  
  // Virtual token reserves (u64)
  const virtualTokenReserves = data.readBigUInt64LE(offset);
  
  // Virtual SOL reserves (u64)
  const virtualSolReserves = data.readBigUInt64LE(offset + 8);
  
  // Real token reserves (u64)
  const realTokenReserves = data.readBigUInt64LE(offset + 16);
  
  // Real SOL reserves (u64)
  const realSolReserves = data.readBigUInt64LE(offset + 24);
  
  // Token total supply (u64)
  const tokenTotalSupply = data.readBigUInt64LE(offset + 32);
  
  // Complete flag (bool)
  const complete = data[offset + 40] === 1;
  
  // Convert to numbers (SOL values in lamports)
  const vTokens = Number(virtualTokenReserves) / 1e6; // tokens have 6 decimals
  const vSol = Number(virtualSolReserves) / 1e9; // SOL has 9 decimals
  
  // Price = vSol / vTokens
  const priceInSol = vSol / vTokens;
  
  // Market cap = price * total supply
  const mcInSol = priceInSol * (Number(tokenTotalSupply) / 1e6);
  
  console.log('Virtual Token Reserves:', vTokens.toLocaleString());
  console.log('Virtual SOL Reserves:', vSol.toFixed(4), 'SOL');
  console.log('Real Token Reserves:', (Number(realTokenReserves) / 1e6).toLocaleString());
  console.log('Real SOL Reserves:', (Number(realSolReserves) / 1e9).toFixed(4), 'SOL');
  console.log('Total Supply:', (Number(tokenTotalSupply) / 1e6).toLocaleString());
  console.log('Complete:', complete);
  console.log('');
  console.log('Price:', priceInSol.toFixed(10), 'SOL');
  console.log('Market Cap:', mcInSol.toFixed(2), 'SOL');
}

parseBondingCurve().catch(console.error);
