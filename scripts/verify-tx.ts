import 'dotenv/config';
import { Connection } from '@solana/web3.js';
const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');

// Check the open position TX
const txSig = '61gbLswA86z9gF7af6MFNF6QYptu6msR5FtDKrX7ABKbApzjf3YXBncYwXkx3tuDXbUhAitNFwHZKpBBzGJNzFuk';
const txInfo = await conn.getTransaction(txSig, { maxSupportedTransactionVersion: 0 });
if (txInfo) {
  console.log('TX found, slot:', txInfo.slot);
  console.log('Error:', txInfo.meta?.err);
  console.log('Logs:');
  txInfo.meta?.logMessages?.forEach((l, i) => console.log(`  [${i}] ${l}`));
} else {
  console.log('TX not found');
}

// Also check the first position TX
const txSig2 = '5DuJZf23vK6z81EPY8kjpnvNwaywtKC8cAyk1WRUzPnY7LRBwM9D9sxpZGyM8nTZyS1vtkq9bMnN9Eb45LAxgmkm';
const txInfo2 = await conn.getTransaction(txSig2, { maxSupportedTransactionVersion: 0 });
if (txInfo2) {
  console.log('\nFirst open TX found, slot:', txInfo2.slot);
  console.log('Error:', txInfo2.meta?.err);
} else {
  console.log('\nFirst open TX not found');
}
