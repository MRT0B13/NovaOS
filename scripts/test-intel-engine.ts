/**
 * Test Nova Intelligence Engine — DeFiLlama + KOL scan + narrative synthesis.
 * 
 * Usage: bun run scripts/test-intel-engine.ts
 * 
 * Tests Phase 2 (DeFi data + social scan) and Phase 3 (narrative synthesis)
 * by calling the functions directly and checking nova_knowledge for results.
 */

// We need to import the functions directly from the module
// Since they're not all exported, we'll test what we can from the outside
// and call the DeFiLlama API + X API directly to verify connectivity.

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  NOVA INTELLIGENCE ENGINE TEST');
  console.log('═══════════════════════════════════════════════\n');

  // ── Test 1: DeFiLlama API connectivity ──
  console.log('── Test 1: DeFiLlama API ──');
  
  const fmt = (n: number | undefined): string => {
    if (!n) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    return n.toLocaleString();
  };

  try {
    const chainsRes = await fetch('https://api.llama.fi/v2/chains');
    if (chainsRes.ok) {
      const chains = await chainsRes.json();
      const solana = chains.find((c: any) => c.name === 'Solana');
      const ethereum = chains.find((c: any) => c.name === 'Ethereum');
      const base = chains.find((c: any) => c.name === 'Base');
      const totalTvl = chains.reduce((sum: number, c: any) => sum + (c.tvl || 0), 0);
      console.log(`  ✅ Chain TVL: Solana $${fmt(solana?.tvl)} | Ethereum $${fmt(ethereum?.tvl)} | Base $${fmt(base?.tvl)} | Total $${fmt(totalTvl)}`);
    } else {
      console.log(`  ❌ Chain TVL failed: ${chainsRes.status}`);
    }
  } catch (err: any) {
    console.log(`  ❌ Chain TVL error: ${err.message}`);
  }

  try {
    const protocolsRes = await fetch('https://api.llama.fi/protocols');
    if (protocolsRes.ok) {
      const allProtocols = await protocolsRes.json();
      const solanaProtos = allProtocols
        .filter((p: any) => (p.chains || []).includes('Solana') && p.tvl > 1_000_000)
        .sort((a: any, b: any) => (b.tvl || 0) - (a.tvl || 0))
        .slice(0, 10);
      console.log(`  ✅ Top 10 Solana DeFi protocols:`);
      for (const p of solanaProtos) {
        console.log(`     ${p.name} (${p.category || 'N/A'}): $${fmt(p.tvl)}, 7d ${(p.change_7d || 0) > 0 ? '+' : ''}${(p.change_7d || 0).toFixed(1)}%`);
      }
    } else {
      console.log(`  ❌ Protocols failed: ${protocolsRes.status}`);
    }
  } catch (err: any) {
    console.log(`  ❌ Protocols error: ${err.message}`);
  }

  try {
    const stablesRes = await fetch('https://stablecoins.llama.fi/stablecoins?includePrices=true');
    if (stablesRes.ok) {
      const data = await stablesRes.json();
      const stables = data.peggedAssets || [];
      const totalSupply = stables.reduce((sum: number, s: any) => sum + (s.circulating?.peggedUSD || 0), 0);
      const usdt = stables.find((s: any) => s.symbol === 'USDT');
      const usdc = stables.find((s: any) => s.symbol === 'USDC');
      console.log(`  ✅ Stablecoins: Total $${fmt(totalSupply)} | USDT $${fmt(usdt?.circulating?.peggedUSD)} | USDC $${fmt(usdc?.circulating?.peggedUSD)}`);
    } else {
      console.log(`  ❌ Stablecoins failed: ${stablesRes.status}`);
    }
  } catch (err: any) {
    console.log(`  ❌ Stablecoins error: ${err.message}`);
  }

  console.log();

  // ── Test 2: X API social search queries ──
  console.log('── Test 2: KOL Social Search (X API) ──');
  
  const { TwitterApi } = await import('twitter-api-v2');
  const client = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY!,
    appSecret: process.env.TWITTER_API_SECRET_KEY!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET!,
  });

  const testQueries = [
    { query: 'pump.fun OR pumpswap OR "bonding curve" graduation -is:retweet lang:en', tag: 'ecosystem' },
    { query: '"AI agent" crypto OR blockchain OR Solana -is:retweet lang:en',           tag: 'ai_agents' },
    { query: 'Solana TVL DeFi Jupiter OR Raydium -is:retweet lang:en',                 tag: 'defi_social' },
  ];

  let totalTweets = 0;
  for (const { query, tag } of testQueries) {
    try {
      const results = await client.v2.search(query, {
        max_results: 10,
        'tweet.fields': ['created_at', 'author_id'],
      });
      const count = results.data?.data?.length || 0;
      totalTweets += count;
      console.log(`  ✅ "${tag}": ${count} tweets`);
      if (count > 0 && results.data.data) {
        // Show first 2 as samples
        for (const t of results.data.data.slice(0, 2)) {
          const preview = t.text.slice(0, 80).replace(/\n/g, ' ');
          console.log(`     → "${preview}${t.text.length > 80 ? '...' : ''}"`);
        }
      }
    } catch (err: any) {
      console.log(`  ❌ "${tag}": ${err.code || err.message}`);
    }
  }
  console.log(`  Total tweets from 3 queries: ${totalTweets}`);
  console.log();

  // ── Test 3: DB connectivity + nova_knowledge check ──
  console.log('── Test 3: Database (nova_knowledge) ──');
  
  try {
    const { PostgresScheduleRepository } = await import('../src/launchkit/db/postgresScheduleRepository.ts');
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.log('  ❌ No DATABASE_URL');
    } else {
      const repo = await PostgresScheduleRepository.create(dbUrl);
      
      // Check existing knowledge entries
      const countResult = await repo.query('SELECT COUNT(*) as cnt FROM nova_knowledge');
      console.log(`  Total entries: ${countResult.rows[0].cnt}`);
      
      // Check by category
      const catResult = await repo.query(
        `SELECT category, COUNT(*) as cnt FROM nova_knowledge 
         WHERE expires_at > NOW() 
         GROUP BY category ORDER BY cnt DESC`
      );
      if (catResult.rows.length > 0) {
        console.log('  Active entries by category:');
        for (const r of catResult.rows) {
          console.log(`    ${r.category}: ${r.cnt}`);
        }
      } else {
        console.log('  No active (non-expired) entries');
      }

      // Check if new categories exist yet
      const newCats = await repo.query(
        `SELECT category, COUNT(*) as cnt FROM nova_knowledge 
         WHERE category IN ('social_intel', 'defi_live', 'narratives') AND expires_at > NOW()
         GROUP BY category`
      );
      if (newCats.rows.length > 0) {
        console.log('\n  ✅ New intelligence categories found:');
        for (const r of newCats.rows) {
          console.log(`    ${r.category}: ${r.cnt} entries`);
        }
      } else {
        console.log('\n  ⏳ No new intel categories yet (will populate after first research cycle)');
      }
    }
  } catch (err: any) {
    console.log(`  ❌ DB error: ${err.message}`);
  }
  console.log();

  // ── Test 4: Run fetchDeFiData + scanKOLs directly ──
  console.log('── Test 4: Live Integration Test ──');
  console.log('  Running fetchDeFiData() + scanKOLs()...\n');
  
  try {
    // Dynamic import to get the internal functions via runResearchCycle or direct exports
    // Since scanKOLs and fetchDeFiData are not exported, we test via runResearchCycle
    // But first let's see if we can import them... they're module-private.
    // We'll test the full cycle instead.
    
    const { runResearchCycle } = await import('../src/launchkit/services/novaResearch.ts');
    
    console.log('  Starting research cycle (Phase 1: Tavily, Phase 2: Social+DeFi, Phase 3: Narratives)...');
    await runResearchCycle();
    console.log('  ✅ Research cycle complete!');
    
    // Now check if new data landed
    const { PostgresScheduleRepository } = await import('../src/launchkit/db/postgresScheduleRepository.ts');
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      const repo = await PostgresScheduleRepository.create(dbUrl);
      const newData = await repo.query(
        `SELECT category, topic, summary, confidence 
         FROM nova_knowledge 
         WHERE category IN ('social_intel', 'defi_live', 'narratives') AND expires_at > NOW()
         ORDER BY fetched_at DESC LIMIT 15`
      );
      
      if (newData.rows.length > 0) {
        console.log(`\n  ✅ ${newData.rows.length} new intelligence entries stored:\n`);
        for (const r of newData.rows) {
          console.log(`  [${r.category}] ${r.topic}`);
          console.log(`    ${r.summary.slice(0, 120)}${r.summary.length > 120 ? '...' : ''}`);
          console.log(`    Confidence: ${r.confidence}\n`);
        }
      } else {
        console.log('\n  ⚠️  No new intel entries — check logs above for errors');
      }
    }
  } catch (err: any) {
    console.log(`  ❌ Integration test failed: ${err.message}`);
    console.log(`     ${err.stack?.split('\n')[1] || ''}`);
  }

  // ── Test 5: getReplyIntel ──
  console.log('── Test 5: getReplyIntel() ──');
  try {
    const { getReplyIntel } = await import('../src/launchkit/services/novaResearch.ts');
    
    const testTweets = [
      'Jupiter just hit $1B in daily volume on Solana, this is wild',
      'Another rug pull on pump.fun, when will people learn',
      'AI agents are going to change crypto forever',
      'Just aped into a new memecoin, wish me luck',
    ];
    
    for (const tweet of testTweets) {
      const intel = await getReplyIntel(tweet);
      console.log(`  Tweet: "${tweet.slice(0, 60)}..."`);
      console.log(`  Intel: ${intel ? intel.slice(0, 120) + '...' : '(none cached yet)'}\n`);
    }
  } catch (err: any) {
    console.log(`  ❌ getReplyIntel failed: ${err.message}`);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  DONE');
  console.log('═══════════════════════════════════════════════');
}

main().catch(console.error);
