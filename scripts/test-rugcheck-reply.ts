/**
 * Test the RugCheck reply pipeline end-to-end.
 * Simulates extracting a CA from a tweet, scanning it, and generating a reply.
 *
 * Usage: bun run scripts/test-rugcheck-reply.ts
 */

import { scanToken, formatReportForTweet } from '../src/launchkit/services/rugcheck.ts';

// ── Step 1: Extract mint addresses (inline copy of extractMintAddresses) ──
function extractMintAddresses(text: string): string[] {
  const base58Regex = /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g;
  const matches: string[] = [];
  let match;
  while ((match = base58Regex.exec(text)) !== null) {
    const candidate = match[1];
    if (candidate.length >= 32 && candidate.length <= 44) {
      matches.push(candidate);
    }
  }
  return [...new Set(matches)];
}

// ── The actual tweet from @CRYPTOGEMS02 about $ROR ──
const tweetText = `Just partnered with another strong project - $ROR, recently launched on Solana @RussianOilRes

✅ $ROR is now on pump.fun 🚀

✅ CA
7qDqWRMT2wRCbpv3ner82BRdcd9AU3zEXDTLr5e1pump

🔥 Why $ROR?
✅ Community-powered & fast-growing
✅ Massive upside potential 📈`;

async function main() {
  console.log('=== STEP 1: Extract mint addresses ===');
  const mints = extractMintAddresses(tweetText);
  console.log(`Found ${mints.length} mint address(es):`);
  for (const m of mints) {
    console.log(`  → ${m}`);
  }

  if (mints.length === 0) {
    console.log('\n❌ No mint addresses found — regex might be failing on this text.');
    console.log('Raw text around CA area:', tweetText.substring(tweetText.indexOf('CA'), tweetText.indexOf('CA') + 80));
    return;
  }

  console.log('\n=== STEP 2: Scan token via RugCheck API ===');
  const mint = mints[0];
  console.log(`Scanning: ${mint}`);
  
  const report = await scanToken(mint);
  
  if (!report) {
    console.log('\n❌ scanToken() returned null — API might be down, rate limited, or address invalid.');
    console.log('Trying raw fetch to see what the API returns...');
    
    try {
      const rawRes = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
      console.log(`  Status: ${rawRes.status}`);
      const rawBody = await rawRes.text();
      console.log(`  Body: ${rawBody.slice(0, 500)}`);
    } catch (err) {
      console.log(`  Raw fetch failed: ${(err as Error).message}`);
    }
    return;
  }

  console.log('\n=== STEP 3: RugCheck Report ===');
  console.log(`  Score: ${report.score} (${report.riskLevel})`);
  console.log(`  Mint authority: ${report.mintAuthority ? '⚠️ ACTIVE' : '✅ Revoked'}`);
  console.log(`  Freeze authority: ${report.freezeAuthority ? '⚠️ ACTIVE' : '✅ Revoked'}`);
  console.log(`  Top holder: ${report.topHolderPct.toFixed(1)}%`);
  console.log(`  Top 10 holders: ${report.top10HolderPct.toFixed(1)}%`);
  console.log(`  LP locked: ${report.lpLocked ? `✅ (${report.lpLockedPct}%)` : '❌ No'}`);
  console.log(`  Is rugged: ${report.isRugged}`);
  if (report.risks.length > 0) {
    console.log(`  Risks (${report.risks.length}):`);
    for (const r of report.risks) {
      console.log(`    - [${r.level}] ${r.name}: ${r.description}`);
    }
  }

  console.log('\n=== STEP 4: Formatted for tweet ===');
  const formatted = formatReportForTweet(report, 'ROR');
  console.log(formatted);

  console.log('\n=== STEP 5: Context string (what GPT sees) ===');
  const context = `\n\nRugCheck Data for ${mint.slice(0, 8)}...:\n${formatted}`;
  console.log(context);

  // ── Step 6: Generate reply via GPT ──
  console.log('\n=== STEP 6: Generate reply via GPT ===');
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.log('❌ No OPENAI_API_KEY in env — cannot test GPT generation');
    console.log('But the RugCheck pipeline works! Data above is what GPT would receive.');
    return;
  }

  const systemPrompt = `You are Nova (@nova_agent_), an autonomous AI agent that launches meme tokens on Solana via pump.fun. You are blunt, data-driven, and transparent.

You're replying to a tweet. Rules:
- MAX 280 characters for replies with RugCheck data. Shorter is better.
- Lead with actual findings, not generic advice.
- ONE emoji max. Zero is fine.

NEVER:
- Say "it's vital to check", "make sure to check", "always do your own research"
- Say "Congrats on the partnership" or "Always great to see"
- Give generic safety advice when you HAVE actual RugCheck data`;

  const userPrompt = `Reply to this tweet:\n\n"${tweetText}"\n\n${context}\n\nYou MUST include the actual RugCheck score and key findings (mint/freeze status, risk flags) in your reply. This is your value-add — do NOT give generic safety advice like "check RugCheck scores" when you HAVE the data right here. Lead with the findings. Example: "RugCheck on $TOKEN: score 45, mint authority still active ⚠️. Careful." You can go up to 280 chars for replies that include RugCheck data. NEVER include URLs or markdown links — just the data. Tag @Rugcheckxyz instead of posting a link.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 150,
      }),
    });

    if (!res.ok) {
      console.log(`❌ OpenAI returned ${res.status}`);
      return;
    }

    const data = await res.json();
    let reply = data.choices?.[0]?.message?.content?.trim();

    // Post-processing (same as xReplyEngine)
    if (reply) {
      reply = reply.replace(/^["']|["']$/g, '');
      reply = reply.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      reply = reply.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();
    }

    console.log(`\nGenerated reply (${reply?.length} chars):`);
    console.log(`"${reply}"`);
    
    // Check for generic phrases that should be blocked
    const lower = (reply || '').toLowerCase();
    const banned = [
      'always great to see', 'congrats on the', "it's vital to check",
      "it's important to check", 'crucial to check', 'make sure to check',
      'always do your own', 'great to see',
    ];
    const caught = banned.filter(p => lower.includes(p));
    if (caught.length > 0) {
      console.log(`\n⚠️ STILL CONTAINS BANNED PHRASES: ${caught.join(', ')}`);
      console.log('The generic phrase filter would catch and discard this.');
    } else {
      console.log('\n✅ No banned phrases detected — reply looks good!');
    }
  } catch (err) {
    console.log(`❌ GPT call failed: ${(err as Error).message}`);
  }
}

main().catch(console.error);
