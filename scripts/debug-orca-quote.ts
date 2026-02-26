/**
 * Debug: inspect Orca liquidity quote + tick arrays
 * to determine why IncreaseLiquidity fails with 0x17b5
 */
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const SOL_USDC_WHIRLPOOL = 'HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ';
const TICK_SPACING = 64;

async function main() {
  const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

  const {
    WhirlpoolContext, buildWhirlpoolClient, PriceMath, TickUtil,
    increaseLiquidityQuoteByInputTokenWithParams, NO_TOKEN_EXTENSION_CONTEXT,
    TickArrayUtil, ORCA_WHIRLPOOL_PROGRAM_ID,
  } = await import('@orca-so/whirlpools-sdk');
  const { AnchorProvider, Wallet } = await import('@coral-xyz/anchor');
  const { Percentage } = await import('@orca-so/common-sdk');
  const Decimal = (await import('decimal.js')).default;
  const BN = (await import('bn.js')).default;

  const provider = new AnchorProvider(conn, new Wallet(wallet), {});
  const ctx = WhirlpoolContext.withProvider(provider);
  const client = buildWhirlpoolClient(ctx);

  const whirlpool = await client.getPool(new PublicKey(SOL_USDC_WHIRLPOOL));
  const data = whirlpool.getData();

  const currentPrice = PriceMath.sqrtPriceX64ToPrice(data.sqrtPrice, 9, 6);
  console.log('Current price:', currentPrice.toNumber());
  console.log('Current tick:', data.tickCurrentIndex);
  console.log('sqrtPrice:', data.sqrtPrice.toString());
  console.log('tokenMintA:', data.tokenMintA.toBase58());
  console.log('tokenMintB:', data.tokenMintB.toBase58());

  const halfRange = 0.10; // ±10%
  const lowerPriceDec = currentPrice.mul(1 - halfRange);
  const upperPriceDec = currentPrice.mul(1 + halfRange);
  console.log('\nLower price (dec):', lowerPriceDec.toNumber());
  console.log('Upper price (dec):', upperPriceDec.toNumber());

  const rawLowerTick = PriceMath.priceToTickIndex(lowerPriceDec, 9, 6);
  const rawUpperTick = PriceMath.priceToTickIndex(upperPriceDec, 9, 6);
  console.log('Raw lower tick:', rawLowerTick);
  console.log('Raw upper tick:', rawUpperTick);

  const lowerTick = TickUtil.getInitializableTickIndex(rawLowerTick, TICK_SPACING);
  const upperTick = TickUtil.getInitializableTickIndex(rawUpperTick, TICK_SPACING);
  console.log('Initializable lower tick:', lowerTick);
  console.log('Initializable upper tick:', upperTick);

  // Check tick array existence
  const lowerTickArrayPda = PriceMath.tickIndexToSqrtPriceX64 ? undefined : undefined;
  try {
    const lowerTaStartIndex = TickUtil.getStartTickIndex(lowerTick, TICK_SPACING);
    const upperTaStartIndex = TickUtil.getStartTickIndex(upperTick, TICK_SPACING);
    console.log('\nLower tick array start:', lowerTaStartIndex);
    console.log('Upper tick array start:', upperTaStartIndex);

    // Try to derive tick array PDAs
    const [lowerTaPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), new PublicKey(SOL_USDC_WHIRLPOOL).toBuffer(),
       Buffer.from(lowerTaStartIndex.toString())],
      new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
    );
    const [upperTaPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('tick_array'), new PublicKey(SOL_USDC_WHIRLPOOL).toBuffer(),
       Buffer.from(upperTaStartIndex.toString())],
      new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
    );

    console.log('Lower tick array PDA:', lowerTaPda.toBase58());
    console.log('Upper tick array PDA:', upperTaPda.toBase58());

    // Check if these accounts exist
    const lowerInfo = await conn.getAccountInfo(lowerTaPda);
    const upperInfo = await conn.getAccountInfo(upperTaPda);
    console.log('Lower tick array exists:', !!lowerInfo, lowerInfo ? `(${lowerInfo.data.length} bytes)` : '');
    console.log('Upper tick array exists:', !!upperInfo, upperInfo ? `(${upperInfo.data.length} bytes)` : '');
  } catch (e) {
    console.log('Tick array lookup error:', e);
  }

  // Now test the quote with SOL as input
  const solAmount = 0.025;
  const solInputBN = new BN(Math.floor(solAmount * 1e9));
  console.log('\n--- Quote with SOL (tokenA) as input ---');
  console.log('SOL input (lamports):', solInputBN.toString());

  try {
    const quoteA = increaseLiquidityQuoteByInputTokenWithParams({
      tokenMintA: data.tokenMintA,
      tokenMintB: data.tokenMintB,
      sqrtPrice: data.sqrtPrice,
      tickCurrentIndex: data.tickCurrentIndex,
      tickLowerIndex: lowerTick,
      tickUpperIndex: upperTick,
      inputTokenMint: data.tokenMintA, // SOL
      inputTokenAmount: solInputBN,
      slippageTolerance: Percentage.fromFraction(10, 1000),
      tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
    });
    console.log('liquidityAmount:', quoteA.liquidityAmount.toString());
    console.log('tokenMaxA:', quoteA.tokenMaxA.toString());
    console.log('tokenMaxB:', quoteA.tokenMaxB.toString());
    console.log('tokenEstA:', quoteA.tokenEstA.toString());
    console.log('tokenEstB:', quoteA.tokenEstB.toString());
  } catch (e) {
    console.log('Quote error (SOL input):', e);
  }

  // Also test with USDC as input (even though we have 0)
  const usdcInputBN = new BN(Math.floor(2 * 1e6)); // pretend 2 USDC
  console.log('\n--- Quote with USDC (tokenB) as input ---');
  console.log('USDC input (micro):', usdcInputBN.toString());

  try {
    const quoteB = increaseLiquidityQuoteByInputTokenWithParams({
      tokenMintA: data.tokenMintA,
      tokenMintB: data.tokenMintB,
      sqrtPrice: data.sqrtPrice,
      tickCurrentIndex: data.tickCurrentIndex,
      tickLowerIndex: lowerTick,
      tickUpperIndex: upperTick,
      inputTokenMint: data.tokenMintB, // USDC
      inputTokenAmount: usdcInputBN,
      slippageTolerance: Percentage.fromFraction(10, 1000),
      tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
    });
    console.log('liquidityAmount:', quoteB.liquidityAmount.toString());
    console.log('tokenMaxA:', quoteB.tokenMaxA.toString());
    console.log('tokenMaxB:', quoteB.tokenMaxB.toString());
    console.log('tokenEstA:', quoteB.tokenEstA.toString());
    console.log('tokenEstB:', quoteB.tokenEstB.toString());
  } catch (e) {
    console.log('Quote error (USDC input):', e);
  }

  // Check what methods whirlpool.openPosition actually expects
  console.log('\n--- Inspecting whirlpool.openPosition signature ---');
  console.log('typeof whirlpool.openPosition:', typeof whirlpool.openPosition);
  console.log('openPosition.length:', (whirlpool as any).openPosition?.length);

  // Try to find openPositionWithMetadata too
  console.log('typeof openPositionWithMetadata:', typeof (whirlpool as any).openPositionWithMetadata);
}

main().catch(e => { console.error(e); process.exit(1); });
