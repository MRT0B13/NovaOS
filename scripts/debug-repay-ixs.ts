import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createSolanaRpc } from '@solana/kit';

async function main() {
  const klend = await import('@kamino-finance/klend-sdk');
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://solana-mainnet.g.alchemy.com/v2/jkhV9JrR8nf9OmoDwpesjAMdgRgaR0F1';
  const rpc = createSolanaRpc(rpcUrl);
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

  const market = await klend.KaminoMarket.load(rpc, '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF' as any, 400);
  const usdcReserve = market!.getReserveByAddress('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59' as any);
  const jitoReserve = market!.getReserveByAddress('EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW' as any);
  
  const walletAddr = { address: wallet.publicKey.toBase58() } as any;
  const currentSlot = BigInt(await connection.getSlot('confirmed'));

  const action = await klend.KaminoAction.buildRepayAndWithdrawTxns(
    market!,
    '5000000',
    usdcReserve!.getLiquidityMint(),
    '99999999',
    jitoReserve!.getLiquidityMint(),
    walletAddr,
    currentSlot as any,
    new klend.VanillaObligation(klend.PROGRAM_ID),
  );

  const keys = Object.keys(action).filter(k => Array.isArray((action as any)[k]));
  console.log('Array properties:', keys);
  
  for (const key of keys) {
    const arr = (action as any)[key];
    console.log(`\n${key} (${arr.length}):`);
    for (let i = 0; i < arr.length; i++) {
      const ix = arr[i];
      const progId = String(ix.programAddress || ix.programId?.toBase58?.() || '?');
      console.log(`  [${i}] prog=${progId.slice(0,12)}... accts=${ix.accounts?.length ?? ix.keys?.length ?? 0}`);
    }
  }
  
  console.log('\nAll props:', Object.keys(action).join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
