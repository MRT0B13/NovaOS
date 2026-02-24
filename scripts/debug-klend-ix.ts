#!/usr/bin/env bun
import 'dotenv/config';
import { createSolanaRpc } from '@solana/kit';
const { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID } = await import('@kamino-finance/klend-sdk');
const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL);
const market = await KaminoMarket.load(rpc, '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF', 400);
const reserve = market.getReserveByAddress('EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW');
console.log('Reserve found:', !!reserve);
console.log('Liquidity mint:', reserve.getLiquidityMint());

const owner = { address: 'J41NRJ1F7mSQRUqVnEv9MRJCNUjVKHTQYwtyLJtRPvJp' };
const action = await KaminoAction.buildDepositTxns(market, '100000000', reserve.getLiquidityMint(), owner, new VanillaObligation(PROGRAM_ID));

console.log('setup IXs:', action.setupIxs.length, 'lending IXs:', action.lendingIxs.length, 'cleanup IXs:', action.cleanupIxs.length);

const ix = action.setupIxs[0] || action.lendingIxs[0];
if (ix) {
  console.log('IX type:', ix.constructor?.name);
  console.log('IX keys:', Object.keys(ix));
  console.log('programId:', ix.programId);
  console.log('programAddress:', ix.programAddress);
  if (ix.accounts) console.log('accounts[0]:', JSON.stringify(ix.accounts[0]));
  if (ix.keys) console.log('keys[0]:', JSON.stringify(ix.keys[0]));
  console.log('data type:', typeof ix.data, ix.data?.constructor?.name);
} else {
  console.log('No instructions found');
}
