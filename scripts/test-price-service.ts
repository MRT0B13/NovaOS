/**
 * Test script for the price service
 * Tests both DexScreener (graduated tokens) and bonding curve (pump.fun tokens)
 */
import { getTokenPrice, formatPrice, formatMarketCap, getPriceSummary } from '../src/launchkit/services/priceService.ts';

async function main() {
  // DUMP token - still on bonding curve
  const DUMP_MINT = 'FcPrcJP3Mp9dNDoBJVquhQc1tvwSMq1c9D2rCw5apump';
  
  console.log('='.repeat(60));
  console.log('Testing DUMP token (bonding curve)...');
  console.log('='.repeat(60));
  
  const dumpPrice = await getTokenPrice(DUMP_MINT);
  
  if (dumpPrice) {
    console.log('\nPrice Data:');
    console.log(`  Price USD: $${dumpPrice.priceUsd?.toFixed(10)}`);
    console.log(`  Price SOL: ${dumpPrice.priceNative?.toFixed(10)} SOL`);
    console.log(`  Market Cap: $${dumpPrice.marketCap?.toFixed(2)}`);
    console.log(`  Liquidity: $${dumpPrice.liquidity?.toFixed(2)}`);
    console.log(`  Dex: ${dumpPrice.dexId}`);
    console.log(`  Updated: ${dumpPrice.lastUpdated}`);
    
    console.log('\nFormatted:');
    console.log(`  Price: ${formatPrice(dumpPrice.priceUsd)}`);
    console.log(`  Market Cap: ${formatMarketCap(dumpPrice.marketCap)}`);
    console.log(`  Summary: ${getPriceSummary(dumpPrice)}`);
  } else {
    console.log('No price data found for DUMP');
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Testing SOL (graduated token via DexScreener)...');
  console.log('='.repeat(60));
  
  // SOL for comparison
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const solPrice = await getTokenPrice(SOL_MINT);
  
  if (solPrice) {
    console.log('\nPrice Data:');
    console.log(`  Price USD: $${solPrice.priceUsd?.toFixed(2)}`);
    console.log(`  Market Cap: ${formatMarketCap(solPrice.marketCap)}`);
    console.log(`  Volume 24h: $${solPrice.volume24h?.toLocaleString()}`);
    console.log(`  24h Change: ${solPrice.priceChange24h?.toFixed(2)}%`);
    console.log(`  Dex: ${solPrice.dexId}`);
  } else {
    console.log('No price data found for SOL');
  }
}

main().catch(console.error);
