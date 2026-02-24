#!/usr/bin/env bun
/**
 * Debug Kamino position parsing — check if getPosition reads obligation correctly
 */
import 'dotenv/config';
import { createSolanaRpc } from '@solana/kit';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));
const { KaminoMarket, VanillaObligation, PROGRAM_ID } = await import('@kamino-finance/klend-sdk');
const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!);
const market = await KaminoMarket.load(rpc, '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF', 400);

const walletAddr = wallet.publicKey.toBase58();
console.log('Wallet:', walletAddr);

// Try getUserVanillaObligation
try {
  const obligation = await market!.getUserVanillaObligation(walletAddr as any);
  console.log('Obligation found:', !!obligation);
  if (obligation) {
    console.log('Obligation type:', obligation.constructor?.name);
    console.log('Obligation keys:', Object.keys(obligation).slice(0, 20));
    
    // Check deposits
    if (obligation.deposits) {
      console.log('deposits type:', typeof obligation.deposits, obligation.deposits.constructor?.name);
      if (obligation.deposits instanceof Map) {
        console.log('deposits Map size:', obligation.deposits.size);
        for (const [key, val] of obligation.deposits) {
          console.log('  deposit key:', key, 'val:', JSON.stringify(val).slice(0, 200));
        }
      } else if (Array.isArray(obligation.deposits)) {
        console.log('deposits Array length:', obligation.deposits.length);
        for (const d of obligation.deposits) {
          console.log('  deposit:', JSON.stringify(d).slice(0, 200));
        }
      } else {
        console.log('deposits raw:', JSON.stringify(obligation.deposits).slice(0, 500));
      }
    } else {
      console.log('No .deposits property');
    }
    
    // Check borrows
    if (obligation.borrows) {
      console.log('borrows type:', typeof obligation.borrows, obligation.borrows.constructor?.name);
      if (obligation.borrows instanceof Map) {
        console.log('borrows Map size:', obligation.borrows.size);
        for (const [key, val] of obligation.borrows) {
          console.log('  borrow key:', key, 'val:', JSON.stringify(val).slice(0, 200));
        }
      } else if (Array.isArray(obligation.borrows)) {
        console.log('borrows Array length:', obligation.borrows.length);
        for (const b of obligation.borrows) {
          console.log('  borrow:', JSON.stringify(b).slice(0, 200));
        }
      }
    } else {
      console.log('No .borrows property');
    }
    
    // Check state
    if (obligation.state) {
      console.log('state keys:', Object.keys(obligation.state).slice(0, 15));
      if (obligation.state.deposits) {
        console.log('state.deposits type:', typeof obligation.state.deposits);
      }
    }
    
    // Try refreshedStats
    if (obligation.refreshedStats) {
      console.log('refreshedStats keys:', Object.keys(obligation.refreshedStats));
    }
  }
} catch (err) {
  console.error('getUserVanillaObligation error:', (err as Error).message);
}
