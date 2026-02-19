// src/health/integration-example.ts
// HOW TO WIRE THE HEALTH AGENT INTO NOVA'S EXISTING CODE
//
// This file shows the integration patterns — not meant to be run directly.
// Copy the relevant pieces into your existing Nova files.

import { Pool } from 'pg';

// ============================================================
// 1. ADD HEARTBEAT CLIENT TO NOVA'S MAIN AGENT
// ============================================================
// In your main agent startup file (e.g., src/index.ts or agent.ts):

/*
import { HeartbeatClient } from './health/heartbeat-client';

// After your pool/DB connection is established:
const heartbeat = new HeartbeatClient(pool, 'nova-main', '1.0.0');
heartbeat.start();

// Handle commands from Health Agent (degradation rules)
heartbeat.onCommand(async (action, params) => {
  switch (action) {
    case 'reduce_frequency':
      // Twitter rate limited — reduce reply frequency
      console.log(`[Nova] Reducing reply frequency to ${params.newMaxRepliesPerHour}/hr`);
      // Update your reply config
      replyConfig.maxRepliesPerHour = params.newMaxRepliesPerHour;
      // Auto-restore after cooldown
      setTimeout(() => {
        replyConfig.maxRepliesPerHour = 8;
        console.log('[Nova] Reply frequency restored');
      }, params.resumeAfterMs || 900_000);
      break;

    case 'rotate_rpc':
      // Solana RPC failed — switch to backup
      const backups = params.backupRPCs || [];
      if (backups.length > 0) {
        const newRpc = backups[0];
        console.log(`[Nova] Rotating RPC to ${newRpc}`);
        // Update your Solana connection
        // solanaConnection = new Connection(newRpc);
      }
      break;

    case 'switch_model':
      // OpenAI down — switch to fallback
      console.log(`[Nova] Switching LLM to ${params.fallback}`);
      // Update your model config
      break;

    default:
      console.log(`[Nova] Unknown command: ${action}`);
  }
});
*/

// ============================================================
// 2. WRAP EXISTING FUNCTIONS WITH ERROR REPORTING
// ============================================================
// In your existing task functions:

/*
// BEFORE (no error reporting):
async function scanKOLs() {
  const tweets = await searchTwitter(queries);
  const analysis = await analyzeWithGPT(tweets);
  return analysis;
}

// AFTER (with heartbeat + error reporting):
async function scanKOLs() {
  return heartbeat.withErrorReporting('scanning KOLs', async () => {
    const tweets = await searchTwitter(queries);
    const analysis = await analyzeWithGPT(tweets);
    return analysis;
  });
}

// Or manually for more control:
async function launchToken(concept: TokenConcept) {
  heartbeat.setTask(`launching token: ${concept.name}`);
  try {
    const result = await deployToPumpFun(concept);
    heartbeat.setTask(null);
    return result;
  } catch (err: any) {
    await heartbeat.reportError({
      errorType: 'TOKEN_LAUNCH_FAILURE',
      errorMessage: err.message,
      stackTrace: err.stack,
      severity: 'critical',
      context: { tokenName: concept.name, ticker: concept.ticker },
    });
    heartbeat.setTask(null);
    throw err;
  }
}
*/

// ============================================================
// 3. EXISTING TRY/CATCH BLOCKS — add reporting
// ============================================================
// Find your existing error handling and add one line:

/*
// In your intelligence engine:
try {
  const data = await fetchDeFiLlamaData();
  // ... process
} catch (error: any) {
  console.error('DeFiLlama fetch failed:', error.message);
  // ADD THIS LINE:
  await heartbeat.reportError({
    errorType: 'DEFI_LLAMA_FAILURE',
    errorMessage: error.message,
    stackTrace: error.stack,
    severity: 'warning',  // warning because we can survive without it
  });
}

// In your Twitter reply engine:
try {
  await postReply(tweetId, replyText);
} catch (error: any) {
  console.error('Reply failed:', error.message);
  // ADD THIS LINE:
  await heartbeat.reportError({
    errorType: error.message.includes('429') ? 'TWITTER_RATE_LIMIT' : 'TWITTER_API_ERROR',
    errorMessage: error.message,
    severity: error.message.includes('429') ? 'warning' : 'error',
    context: { tweetId },
  });
}
*/

// ============================================================
// 4. PM2 ECOSYSTEM FILE — run Health Agent alongside Nova
// ============================================================

/*
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'nova-main',
      script: 'src/index.ts',
      interpreter: 'npx',
      interpreter_args: 'ts-node',
      env: {
        NODE_ENV: 'production',
        // ... your existing env vars
      },
    },
    {
      name: 'health-agent',
      script: 'src/health/index.ts',
      interpreter: 'npx',
      interpreter_args: 'ts-node',
      env: {
        NODE_ENV: 'production',
        DATABASE_URL: process.env.DATABASE_URL,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
        ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,
        REPAIR_ENABLED: 'true',
        PROJECT_ROOT: '/app',   // or wherever your code lives
      },
    },
  ],
};
*/

// ============================================================
// 5. RAILWAY DEPLOYMENT — single service with pm2
// ============================================================

/*
// Dockerfile addition (or Railway start command):
// npm install -g pm2
// pm2-runtime ecosystem.config.js

// Or if you want separate Railway services:
// Service 1 (Nova): npm start
// Service 2 (Health Agent): npx ts-node src/health/index.ts
// Both share the same DATABASE_URL
*/

// ============================================================
// 6. TELEGRAM BOT COMMANDS — for approving/rejecting repairs
// ============================================================
// Add these handlers to your existing Telegram bot:

/*
bot.onText(/\/approve (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const repairId = parseInt(match![1]);
  
  await healthDB.approveRepair(repairId, 'owner');
  // The Health Agent will pick this up and apply the fix
  bot.sendMessage(chatId, `✅ Repair #${repairId} approved. Health Agent will apply it.`);
});

bot.onText(/\/reject (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const repairId = parseInt(match![1]);
  
  await healthDB.rejectRepair(repairId, 'owner');
  bot.sendMessage(chatId, `❌ Repair #${repairId} rejected.`);
});

bot.onText(/\/health/, async (msg) => {
  const report = await healthMonitor.generateReport();
  bot.sendMessage(msg.chat.id, report.text);
});

bot.onText(/\/repairs/, async (msg) => {
  const pending = await healthDB.getPendingRepairs();
  if (pending.length === 0) {
    bot.sendMessage(msg.chat.id, 'No pending repairs.');
    return;
  }
  
  let text = `🔧 Pending Repairs:\n\n`;
  for (const r of pending) {
    text += `#${r.id} — ${r.agent_name}\n`;
    text += `File: ${r.file_path}\n`;
    text += `Diagnosis: ${r.diagnosis}\n`;
    text += `/approve ${r.id} or /reject ${r.id}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/\/rollback (\d+)/, async (msg, match) => {
  const repairId = parseInt(match![1]);
  await repairEngine.rollbackRepair(repairId);
  bot.sendMessage(msg.chat.id, `🔄 Repair #${repairId} rolled back.`);
});
*/

// ============================================================
// 7. ENV VARS NEEDED
// ============================================================

/*
# Add to your .env or Railway env vars:

# Required (already have these)
DATABASE_URL=postgresql://...
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=...

# New for Health Agent
ADMIN_CHAT_ID=123456789    # Your personal TG chat ID for alerts
REPAIR_ENABLED=true                  # Set to 'false' to disable auto-repair
REPAIR_MODEL=claude-sonnet-4-20250514       # Claude for code repair (smarter than GPT)
PROJECT_ROOT=/app                    # Root of Nova's source code
REPORT_TO_TELEGRAM=true              # Send 6-hourly health reports to TG
*/

console.log('This file is for reference only. See the comments above for integration instructions.');
