import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const conn = new Connection(process.env.SOLANA_RPC_URL!, 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.AGENT_FUNDING_WALLET_SECRET!));

async function go() {
  const sdk = await import('@orca-so/whirlpools-sdk');
  const { AnchorProvider, Wallet } = await import('@coral-xyz/anchor');
  const { Percentage } = await import('@orca-so/common-sdk');
  const BN = (await import('bn.js')).default;

  const provider = new AnchorProvider(conn, new Wallet(wallet), {});
  const ctx = sdk.WhirlpoolContext.withProvider(provider);
  const client = sdk.buildWhirlpoolClient(ctx);
  const pool = await client.getPool(new PublicKey('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ'));
  const d = pool.getData();

  const currentPrice = sdk.PriceMath.sqrtPriceX64ToPrice(d.sqrtPrice, 9, 6);
  const lowerP = currentPrice.mul(0.9);
  const upperP = currentPrice.mul(1.1);
  const lowerTick = sdk.TickUtil.getInitializableTickIndex(sdk.PriceMath.priceToTickIndex(lowerP, 9, 6), 64);
  const upperTick = sdk.TickUtil.getInitializableTickIndex(sdk.PriceMath.priceToTickIndex(upperP, 9, 6), 64);

  const quote = sdk.increaseLiquidityQuoteByInputTokenWithParams({
    tokenMintA: d.tokenMintA, tokenMintB: d.tokenMintB,
    sqrtPrice: d.sqrtPrice, tickCurrentIndex: d.tickCurrentIndex,
    tickLowerIndex: lowerTick, tickUpperIndex: upperTick,
    inputTokenMint: d.tokenMintA, inputTokenAmount: new BN(25000000),
    slippageTolerance: Percentage.fromFraction(10, 1000),
    tokenExtensionCtx: sdk.NO_TOKEN_EXTENSION_CONTEXT,
  });

  console.log('Quote keys:', Object.keys(quote));
  for (const [k, v] of Object.entries(quote)) {
    if (v && typeof v === 'object' && 'toString' in v) {
      console.log(k + ':', (v as any).toString());
    } else {
      console.log(k + ':', JSON.stringify(v));
    }
  }
}
go().catch(e => { console.error(e); process.exit(1); });
