/**
 * Quick test for Nova's research engine
 * Usage: bun run scripts/test-research.ts
 */

import 'dotenv/config';

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

if (!TAVILY_API_KEY) {
  console.error('❌ TAVILY_API_KEY not set in .env');
  process.exit(1);
}

console.log('✅ TAVILY_API_KEY found:', TAVILY_API_KEY.slice(0, 10) + '...');

// ── Test 1: Raw Tavily API call ──────────────────────────────────────────
async function testTavilyRaw() {
  console.log('\n🔍 Test 1: Raw Tavily API search...');
  
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query: 'pump.fun statistics tokens launched graduation rate 2025 2026',
      search_depth: 'basic',
      include_answer: true,
      max_results: 3,
    }),
  });

  if (!res.ok) {
    console.error('❌ Tavily API error:', res.status, await res.text());
    return false;
  }

  const data = await res.json() as any;
  
  console.log('✅ Tavily response received');
  console.log('  Answer length:', data.answer?.length || 0, 'chars');
  console.log('  Results count:', data.results?.length || 0);
  
  if (data.answer) {
    console.log('\n📝 Synthesized answer (first 500 chars):');
    console.log(data.answer.slice(0, 500));
  }
  
  if (data.results?.[0]) {
    console.log('\n🔗 Top result:');
    console.log('  Title:', data.results[0].title);
    console.log('  URL:', data.results[0].url);
    console.log('  Content (first 200 chars):', data.results[0].content?.slice(0, 200));
  }
  
  return true;
}

// ── Test 2: GPT fact extraction (if OpenAI key available) ────────────────
async function testFactExtraction(searchAnswer: string) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    console.log('\n⚠️  OPENAI_API_KEY not set — skipping fact extraction test');
    return;
  }

  console.log('\n🧠 Test 2: GPT-4o-mini fact extraction...');

  const extractPrompt = 'Extract specific numbers: total tokens launched on pump.fun, graduation rate percentage, daily/total volume processed. Only include numbers attributable to a source.';

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a fact extraction engine. Extract specific, verifiable facts from web search results.
Return JSON: { "summary": "2-3 sentence summary", "facts": ["fact1", "fact2", ...], "confidence": 0.0-1.0 }
Only include facts with specific numbers or verifiable claims. Set confidence based on source quality.`,
        },
        {
          role: 'user',
          content: `Search query: pump.fun statistics tokens launched graduation rate
Extract prompt: ${extractPrompt}

Search results:
${searchAnswer}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    console.error('❌ OpenAI API error:', res.status, await res.text());
    return;
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content || '';

  console.log('✅ GPT extraction result:');
  
  try {
    const cleaned = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log('  Summary:', parsed.summary);
    console.log('  Facts:', parsed.facts?.length || 0, 'extracted');
    parsed.facts?.forEach((f: string, i: number) => console.log(`    ${i + 1}. ${f}`));
    console.log('  Confidence:', parsed.confidence);
  } catch {
    console.log('  Raw output:', content.slice(0, 500));
  }
}

// ── Test 3: Database connection ──────────────────────────────────────────
async function testDatabase() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.log('\n⚠️  DATABASE_URL not set — skipping DB test');
    return;
  }

  console.log('\n💾 Test 3: Database nova_knowledge table...');
  
  try {
    // Using pg directly since we're outside ElizaOS runtime
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: DATABASE_URL });
    
    // Check table exists
    const tableCheck = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'nova_knowledge')`
    );
    
    if (tableCheck.rows[0].exists) {
      console.log('✅ nova_knowledge table exists');
      
      // Check row count
      const countResult = await pool.query('SELECT COUNT(*) as count FROM nova_knowledge');
      console.log('  Current rows:', countResult.rows[0].count);
      
      // Show categories if any data
      if (parseInt(countResult.rows[0].count) > 0) {
        const categories = await pool.query(
          'SELECT category, COUNT(*) as count FROM nova_knowledge GROUP BY category ORDER BY count DESC'
        );
        console.log('  Categories:', categories.rows.map((r: any) => `${r.category}(${r.count})`).join(', '));
      }
    } else {
      console.log('⚠️  nova_knowledge table does not exist yet (will be created on first startup)');
    }
    
    await pool.end();
  } catch (err: any) {
    console.error('❌ DB error:', err.message);
  }
}

// ── Run all tests ────────────────────────────────────────────────────────
async function main() {
  console.log('🧪 Nova Research Engine — Integration Test');
  console.log('==========================================\n');

  // Test 1: Tavily raw search
  const tavilyOk = await testTavilyRaw();
  
  if (tavilyOk) {
    // Run a second search to get answer text for extraction test
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: 'pump.fun statistics tokens launched graduation rate 2025 2026',
        search_depth: 'basic',
        include_answer: true,
        max_results: 3,
      }),
    });
    const data = await res.json() as any;
    const searchText = [
      data.answer || '',
      ...(data.results || []).map((r: any) => r.content || ''),
    ].join('\n\n');
    
    // Test 2: Fact extraction
    await testFactExtraction(searchText);
  }

  // Test 3: Database
  await testDatabase();

  console.log('\n==========================================');
  console.log('🏁 Tests complete!');
}

main().catch(console.error);
