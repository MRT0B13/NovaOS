#!/usr/bin/env bun
/**
 * Test Autonomous Launch Flow
 * 
 * This script tests the autonomous launch flow without actually launching a token.
 * It simulates what happens when autonomous mode triggers:
 * 1. Generates an idea via AI
 * 2. Creates a LaunchPack with Nova's TG channel and X handle attached
 * 3. Shows what would be launched
 * 
 * Usage:
 *   bun run scripts/test-autonomous.ts [--create-pack]
 * 
 * Options:
 *   --create-pack  Actually create the LaunchPack (but don't launch it)
 */

import 'dotenv/config';
import { generateBestIdea, validateIdea, type TokenIdea } from '../src/launchkit/services/ideaGenerator.ts';
import { generateMemeLogo } from '../src/launchkit/services/logoGenerator.ts';

const createPack = process.argv.includes('--create-pack');

console.log('═══════════════════════════════════════════════════════════════');
console.log('🧪 TEST AUTONOMOUS LAUNCH FLOW');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log('This simulates what happens when autonomous mode triggers a launch.');
console.log('AUTONOMOUS_DRY_RUN:', process.env.AUTONOMOUS_DRY_RUN || 'not set');
console.log('');

// Check required env vars
const novaChannelInvite = process.env.NOVA_CHANNEL_INVITE;
const novaXHandle = process.env.NOVA_X_HANDLE;
const novaChannelId = process.env.NOVA_CHANNEL_ID;

console.log('📋 SOCIAL LINKS CONFIGURATION:');
console.log('─────────────────────────────────────────');
console.log(`NOVA_CHANNEL_ID:     ${novaChannelId || '❌ NOT SET'}`);
console.log(`NOVA_CHANNEL_INVITE: ${novaChannelInvite || '❌ NOT SET'}`);
console.log(`NOVA_X_HANDLE:       ${novaXHandle ? `@${novaXHandle}` : '❌ NOT SET'}`);
console.log('');

if (!novaChannelInvite) {
  console.log('⚠️  Warning: NOVA_CHANNEL_INVITE not set - TG link won\'t be attached');
}
if (!novaXHandle) {
  console.log('⚠️  Warning: NOVA_X_HANDLE not set - X link won\'t be attached');
}

console.log('');
console.log('📝 STEP 1: Generating token idea via AI...');
console.log('─────────────────────────────────────────');

let idea: TokenIdea;
try {
  idea = await generateBestIdea({
    agentName: 'Nova',
    agentPersonality: 'Nova is a chaotic, self-aware AI that embraces entropy and finds humor in the absurdity of crypto culture.',
    avoidTickers: [],
  }, 3);
  
  const validation = validateIdea(idea);
  if (!validation.valid) {
    console.log('❌ Invalid idea:', validation.issues.join(', '));
    process.exit(1);
  }
  
  console.log(`✅ Idea generated!`);
  console.log('');
  console.log(`   Name:        ${idea.name}`);
  console.log(`   Ticker:      $${idea.ticker}`);
  console.log(`   Description: ${idea.description}`);
  console.log(`   Mascot:      ${idea.mascot}`);
  console.log(`   Confidence:  ${(idea.confidence * 100).toFixed(0)}%`);
  
} catch (err: any) {
  console.log('❌ Failed to generate idea:', err.message);
  process.exit(1);
}

console.log('');
console.log('🎨 STEP 2: Generating logo via DALL-E...');
console.log('─────────────────────────────────────────');

let logoUrl: string;
try {
  const logoResult = await generateMemeLogo(
    idea.name,
    idea.ticker,
    idea.mascot || idea.description,
    'meme'
  );
  logoUrl = logoResult.url;
  console.log(`✅ Logo generated (${logoResult.source})`);
  console.log(`   URL: ${logoUrl.substring(0, 80)}...`);
} catch (err: any) {
  console.log('❌ Failed to generate logo:', err.message);
  logoUrl = 'https://placeholder.com/logo.png';
  console.log('   Using placeholder URL');
}

console.log('');
console.log('📦 STEP 3: LaunchPack that WOULD be created:');
console.log('─────────────────────────────────────────');

const launchPack = {
  brand: {
    name: idea.name,
    ticker: idea.ticker,
    description: idea.description,
  },
  assets: {
    logo_url: logoUrl,
  },
  links: {
    telegram: novaChannelInvite || undefined,
    x: novaXHandle ? `https://x.com/${novaXHandle}` : undefined,
  },
  ops: {
    checklist: { autonomous: true },
    audit_log: [{
      at: new Date().toISOString(),
      message: `Autonomous launch created: $${idea.ticker} - ${idea.name}`,
      actor: 'autonomous_mode',
    }],
  },
  tg: novaChannelId ? {
    telegram_chat_id: novaChannelId,
    verified: true,
  } : undefined,
};

console.log(JSON.stringify(launchPack, null, 2));

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log('✅ TEST COMPLETE');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log('This is what would happen in autonomous mode:');
console.log(`  1. Token $${idea.ticker} (${idea.name}) would be created`);
console.log(`  2. Logo: ${logoUrl ? 'Generated ✅' : 'Missing ❌'}`);
console.log(`  3. TG Link: ${novaChannelInvite ? `${novaChannelInvite} ✅` : 'Not attached ❌'}`);
console.log(`  4. X Link: ${novaXHandle ? `https://x.com/${novaXHandle} ✅` : 'Not attached ❌'}`);
console.log('');

if (createPack) {
  console.log('📦 --create-pack flag detected. Creating actual LaunchPack...');
  
  // Dynamic import to avoid initialization issues
  const { LaunchPackRepository } = await import('../src/launchkit/db/launchPackRepository.ts');
  const store = await LaunchPackRepository.create();
  
  try {
    const created = await store.create(launchPack);
    console.log(`✅ LaunchPack created with ID: ${created.id}`);
    console.log('');
    console.log('You can now view it in the dashboard or via API:');
    console.log(`  curl http://localhost:8787/v1/launchpacks/${created.id}`);
  } catch (err: any) {
    console.log('❌ Failed to create LaunchPack:', err.message);
  }
} else {
  console.log('💡 Run with --create-pack to actually create the LaunchPack (without launching)');
}

console.log('');
