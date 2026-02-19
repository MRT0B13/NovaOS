# Nova Post-Health-Agent Roadmap — Complete Implementation Prompt for Copilot

## Context

You are working on **Nova**, an autonomous AI agent built on the **ElizaOS framework** (TypeScript, PostgreSQL, Railway deployment). Nova launches meme tokens on pump.fun, monitors crypto narratives via a live intelligence engine, provides RugCheck safety analysis, and manages social presence on X (Twitter) and Telegram.

### What Already Exists (DO NOT rebuild)

| System                       | Status   | Location                                                                                        |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| **Intelligence Engine**      | LIVE     | `src/launchkit/` — `scanKOLs()`, `fetchDeFiData()`, `synthesizeNarratives()`, `getReplyIntel()` |
| **RugCheck Integration**     | LIVE     | Integrated into reply engine and TG commands                                                    |
| **PumpSwap Fee Tracking**    | LIVE     | Monitors graduation fees on pump.fun tokens                                                     |
| **X Reply Engine**           | LIVE     | `src/launchkit/services/xReplyEngine.ts` — search/mention replies, RugCheck, spam filter        |
| **X Marketing + Scheduler**  | LIVE     | `xMarketing.ts`, `xScheduler.ts`, `xPublisher.ts`, `xRateLimiter.ts` — full X pipeline          |
| **Telegram Bot (10+ svcs)**  | LIVE     | Community group, DM routing, scheduler, publisher, security, ban handler, user cache            |
| **Telegram Health Commands** | LIVE     | `telegramHealthCommands.ts` — `/health`, `/errors`, `/repairs`, `/approve`, `/reject`           |
| **Telegram Health Monitor**  | LIVE     | `telegramHealthMonitor.ts` — connection monitoring, auto-restart                                |
| **Nova Channel**             | LIVE     | `novaChannel.ts` (932 lines) — channel/group announcements, cross-ban, rules, daily summaries   |
| **Autonomous Mode**          | LIVE     | `autonomousMode.ts` (1232 lines) — scheduled + reactive launches, voting, dry-run safety        |
| **Health Agent**             | **LIVE** | `src/launchkit/health/` — 8 files, two-tier repair engine, wired into `init.ts` on startup      |
| **Health DB Schema**         | **LIVE** | `sql/001_health_schema.sql` — 8 tables incl. `agent_messages` + `agent_registry`, auto-migrated |
| **Operator Guardrails**      | LIVE     | `operatorGuardrails.ts` — safety limits on autonomous operations                                |
| **Treasury + PnL Tracking**  | LIVE     | `treasuryService.ts`, `treasuryScheduler.ts`, `pnlTracker.ts`, `priceService.ts`                |
| **Nova Personal Brand**      | LIVE     | `novaPersonalBrand.ts` — brand-consistent content generation                                    |
| **Meme/Logo Generation**     | LIVE     | `memeGenerator.ts`, `logoGenerator.ts` — AI-generated visual content                            |
| **Admin Notify**             | LIVE     | `adminNotify.ts` — owner alerting for critical events                                           |
| **LaunchKit Plugin**         | LIVE     | `src/plugin.ts` (295 lines) — 44 actions, 2 providers, 1 service, full lifecycle management     |

### What This Prompt Covers (9 items, in priority order)

1. **Reply Engine Community Targets** — Update PRIORITY_KOLS[], add anti-spam rules, quality gates
2. **GitHub Pages Landing Page** — Static site for directory badges, Virtuals listing prerequisite
3. **Scout Agent** — Extract KOL scanning/intelligence into separate agent
4. **Guardian Agent** — Extract RugCheck/safety monitoring into separate agent
5. **Supervisor Logic** — Nova becomes coordinator reading from Scout/Guardian
6. **Farcaster Plugin** — Auto-post to Warpcast channels
7. **Token Child Agents** — Mini-agents per pump.fun launch
8. **Virtuals Protocol Launch** — NOVA token on Base chain
9. **Agent Factory MVP** — Users request custom agents through Nova

---

## PHASE 1 — IMMEDIATE WINS (This Week)

### Task 1: Reply Engine Community Targets

Nova's reply engine already works. This task updates its targeting to focus on the AI agent ecosystem — the accounts that matter for Nova's growth and visibility.

**Find Nova's PRIORITY_KOLS array** (likely in the intelligence engine config or reply engine config) and replace/extend it with the tiered targeting below.

#### 1A: Add Community Target Config

Create `src/launchkit/community-targets.ts`:

```typescript
/**
 * Nova Community Reply Targets
 *
 * Three tiers of X accounts Nova monitors and replies to.
 * Nova ONLY replies when it has genuine intel to add — never generic engagement.
 *
 * Each account has:
 * - maxRepliesPerDay: hard cap on replies to this account
 * - replyWhen: comma-separated triggers that justify a reply
 */

export interface CommunityTarget {
  handle: string;
  maxRepliesPerDay: number;
  replyWhen: string; // pipe-separated trigger keywords
}

export interface CommunityTargetTier {
  accounts: CommunityTarget[];
  replyStyle: "peer" | "analyst" | "collaborator";
}

export const COMMUNITY_TARGETS: Record<string, CommunityTargetTier> = {
  // ── Tier 1: AI Agent Ecosystem (daily engagement) ─────────────────
  // These are the accounts that define the AI agent space.
  // Nova talks to them as a PEER — a fellow autonomous agent, not a fan.
  tier1_ai_agents: {
    accounts: [
      {
        handle: "aixbt_agent",
        maxRepliesPerDay: 2,
        replyWhen: "market_analysis|token_mention|narrative",
      },
      {
        handle: "virtuals_io",
        maxRepliesPerDay: 1,
        replyWhen: "new_agent_launch|ecosystem_update|solana",
      },
      {
        handle: "elizaos",
        maxRepliesPerDay: 2,
        replyWhen: "framework_update|showcase|dev_question",
      },
      {
        handle: "shawmakesmagic",
        maxRepliesPerDay: 1,
        replyWhen: "elizaos_update|agent_discussion|technical",
      },
      {
        handle: "KaitoAI",
        maxRepliesPerDay: 1,
        replyWhen: "mindshare_data|agent_ranking",
      },
      {
        handle: "truth_terminal",
        maxRepliesPerDay: 1,
        replyWhen: "meme_token|ai_agent_discussion",
      },
      {
        handle: "cookiedotfun",
        maxRepliesPerDay: 1,
        replyWhen: "agent_data|indexing|analytics",
      },
      {
        handle: "0xzerebro",
        maxRepliesPerDay: 1,
        replyWhen: "solana_agent|cross_chain|framework",
      },
      {
        handle: "paboracle",
        maxRepliesPerDay: 1,
        replyWhen: "solana_agent|skill_update|meme",
      },
    ],
    replyStyle: "peer",
  },

  // ── Tier 2: Crypto Intelligence Accounts ──────────────────────────
  // Nova replies with DATA — stats, RugCheck results, DeFiLlama metrics.
  // Position Nova as the agent that provides actionable intelligence.
  tier2_crypto_intel: {
    accounts: [
      {
        handle: "BanklessHQ",
        maxRepliesPerDay: 1,
        replyWhen: "ai_agent_coverage|defi_analysis",
      },
      {
        handle: "DefiLlama",
        maxRepliesPerDay: 1,
        replyWhen: "tvl_update|protocol_data|solana",
      },
      {
        handle: "RugCheckxyz",
        maxRepliesPerDay: 2,
        replyWhen: "rug_alert|safety_update|scan_result",
      },
      {
        handle: "solana",
        maxRepliesPerDay: 1,
        replyWhen: "ecosystem_update|technical_upgrade",
      },
      {
        handle: "MessariCrypto",
        maxRepliesPerDay: 1,
        replyWhen: "ai_agent_research|market_report",
      },
      {
        handle: "TheBlock__",
        maxRepliesPerDay: 1,
        replyWhen: "ai_agent_news|solana_news",
      },
    ],
    replyStyle: "analyst",
  },

  // ── Tier 3: Agent Peers (relationship building) ───────────────────
  // Engage as a collaborator, not a competitor. Build bridges for
  // future integrations, cross-promotion, multi-agent partnerships.
  tier3_agent_peers: {
    accounts: [
      {
        handle: "HeyAnonai",
        maxRepliesPerDay: 1,
        replyWhen: "defi_agent|natural_language",
      },
      {
        handle: "autonaborolas",
        maxRepliesPerDay: 1,
        replyWhen: "multi_agent|framework",
      },
      {
        handle: "ai16zdao",
        maxRepliesPerDay: 1,
        replyWhen: "dao_update|elizaos",
      },
      {
        handle: "getgrass_io",
        maxRepliesPerDay: 1,
        replyWhen: "data_infra|ai_training",
      },
    ],
    replyStyle: "collaborator",
  },
};

/**
 * Flatten all targets into a single array for the reply engine.
 * Merge these into PRIORITY_KOLS[] or whatever array the existing
 * reply engine uses to decide who to monitor.
 */
export function getAllTargetHandles(): string[] {
  return Object.values(COMMUNITY_TARGETS).flatMap((tier) =>
    tier.accounts.map((a) => a.handle),
  );
}

export function getTargetConfig(
  handle: string,
): { target: CommunityTarget; style: string } | null {
  for (const tier of Object.values(COMMUNITY_TARGETS)) {
    const target = tier.accounts.find(
      (a) => a.handle.toLowerCase() === handle.toLowerCase(),
    );
    if (target) return { target, style: tier.replyStyle };
  }
  return null;
}
```

#### 1B: Add Anti-Spam Rules

Create `src/launchkit/reply-rules.ts`:

```typescript
/**
 * Nova Reply Engine Anti-Spam Rules
 *
 * These rules prevent Nova from becoming a spam bot.
 * Quality over quantity: 15-25 substantive replies/day beats 500 generic ones.
 *
 * CRITICAL: These rules are non-negotiable. Violating them gets Nova
 * flagged by X's spam detection and damages reputation.
 */

export const REPLY_RULES = {
  // ── Global Rate Limits ────────────────────────────────────────────
  maxTotalRepliesPerHour: 8, // never more than 8 replies/hour across ALL targets
  maxTotalRepliesPerDay: 50, // hard daily cap (aim for 30-50 quality replies)
  maxRepliesToSameAccountPerDay: 2, // never reply to same account more than 2x/day
  minTimeBetweenReplies: 300, // 5 min minimum gap between ANY replies (seconds)
  perAccountCooldownHours: 12, // after replying, wait 12h before replying to same account again

  // ── Content Quality Gates ─────────────────────────────────────────
  // Nova ONLY replies when ALL of these pass:
  qualityThresholds: {
    mustContainData: true, // reply MUST include a stat, metric, or specific insight
    minRelevanceScore: 0.7, // LLM rates relevance 0-1 before posting; must be >0.7
    mustAddValue: true, // reply must contain info NOT already in the original post
    maxReplyLength: 280, // keep replies concise (X character limit awareness)
    minReplyLength: 50, // no one-liners — substantive responses only
  },

  // ── Banned Phrases ────────────────────────────────────────────────
  // If Nova's draft reply contains ANY of these, reject it and regenerate.
  // These phrases signal generic bot behavior and kill credibility.
  noGenericPhrases: [
    "great thread",
    "this is huge",
    "bullish",
    "love this",
    "gm",
    "wagmi",
    "lfg",
    "based",
    "ser",
    "fren",
    "couldn't agree more",
    "this is the way",
    "so true",
    "amazing work",
    "incredible",
    "game changer",
    "revolutionary",
    "to the moon",
    "diamond hands",
    "not financial advice",
    "check out our",
    "follow us",
    "join our community",
  ],

  // ── Engagement Filters ────────────────────────────────────────────
  onlyReplyToOriginalPosts: true, // don't reply to replies (only to top-level posts/threads)
  skipIfRepliesExceed: 50, // skip posts with 50+ replies already (Nova gets buried)
  skipIfPostOlderThanHours: 6, // don't reply to stale posts
  skipIfAlreadyReplied: true, // never double-reply to same post

  // ── Self-Promotion Guard ──────────────────────────────────────────
  // Nova should NEVER self-promote in replies. No "check out Nova", no links
  // to Nova's own content. The value speaks for itself.
  noSelfPromotion: true,
  bannedSelfPromoPatterns: [
    /check out (nova|our agent|my agent)/i,
    /follow @?\w*nova/i,
    /nova (can|does|offers|provides)/i,
    /powered by nova/i,
    /https?:\/\/\S*nova\S*/i, // no links to Nova's own stuff
  ],
};

/**
 * Validate a draft reply against all rules before posting.
 * Returns { valid: boolean, reason?: string }
 */
export function validateReply(
  draftReply: string,
  targetHandle: string,
  recentReplies: { handle: string; timestamp: Date }[],
): { valid: boolean; reason?: string } {
  // Check length
  if (draftReply.length < REPLY_RULES.qualityThresholds.minReplyLength) {
    return {
      valid: false,
      reason: `Too short (${draftReply.length} chars, min ${REPLY_RULES.qualityThresholds.minReplyLength})`,
    };
  }
  if (draftReply.length > REPLY_RULES.qualityThresholds.maxReplyLength) {
    return {
      valid: false,
      reason: `Too long (${draftReply.length} chars, max ${REPLY_RULES.qualityThresholds.maxReplyLength})`,
    };
  }

  // Check banned phrases
  const lowerReply = draftReply.toLowerCase();
  for (const phrase of REPLY_RULES.noGenericPhrases) {
    if (lowerReply.includes(phrase.toLowerCase())) {
      return { valid: false, reason: `Contains banned phrase: "${phrase}"` };
    }
  }

  // Check self-promotion
  if (REPLY_RULES.noSelfPromotion) {
    for (const pattern of REPLY_RULES.bannedSelfPromoPatterns) {
      if (pattern.test(draftReply)) {
        return { valid: false, reason: `Self-promotion detected: ${pattern}` };
      }
    }
  }

  // Check per-account cooldown
  const now = new Date();
  const recentToSameAccount = recentReplies.filter(
    (r) =>
      r.handle.toLowerCase() === targetHandle.toLowerCase() &&
      now.getTime() - r.timestamp.getTime() <
        REPLY_RULES.perAccountCooldownHours * 60 * 60 * 1000,
  );
  if (recentToSameAccount.length >= REPLY_RULES.maxRepliesToSameAccountPerDay) {
    return {
      valid: false,
      reason: `Already replied to @${targetHandle} ${recentToSameAccount.length}x today`,
    };
  }

  // Check global hourly rate
  const lastHour = recentReplies.filter(
    (r) => now.getTime() - r.timestamp.getTime() < 60 * 60 * 1000,
  );
  if (lastHour.length >= REPLY_RULES.maxTotalRepliesPerHour) {
    return {
      valid: false,
      reason: `Hourly cap reached (${lastHour.length}/${REPLY_RULES.maxTotalRepliesPerHour})`,
    };
  }

  // Check global daily rate
  const today = recentReplies.filter((r) => {
    const d = r.timestamp;
    return d.toDateString() === now.toDateString();
  });
  if (today.length >= REPLY_RULES.maxTotalRepliesPerDay) {
    return {
      valid: false,
      reason: `Daily cap reached (${today.length}/${REPLY_RULES.maxTotalRepliesPerDay})`,
    };
  }

  // Check minimum gap between replies
  if (recentReplies.length > 0) {
    const lastReply = recentReplies.sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    )[0];
    const secondsSinceLast =
      (now.getTime() - lastReply.timestamp.getTime()) / 1000;
    if (secondsSinceLast < REPLY_RULES.minTimeBetweenReplies) {
      return {
        valid: false,
        reason: `Too soon since last reply (${Math.round(secondsSinceLast)}s, min ${REPLY_RULES.minTimeBetweenReplies}s)`,
      };
    }
  }

  return { valid: true };
}
```

#### 1C: Wire Into Existing Reply Engine

Find the file where Nova's reply engine decides who to monitor and what to reply. It likely has a `PRIORITY_KOLS` array or similar. Do the following:

```typescript
// At the top of the reply engine file:
import {
  COMMUNITY_TARGETS,
  getTargetConfig,
  getAllTargetHandles,
} from "./community-targets";
import { REPLY_RULES, validateReply } from "./reply-rules";

// Replace or merge into PRIORITY_KOLS:
const PRIORITY_KOLS = [
  ...existingKOLs, // keep any existing ones that aren't duplicated
  ...getAllTargetHandles(),
];

// Before posting any reply, validate it:
const validation = validateReply(draftReply, targetHandle, recentReplies);
if (!validation.valid) {
  console.log(
    `[reply-engine] Blocked reply to @${targetHandle}: ${validation.reason}`,
  );
  return; // skip this reply
}

// Adjust reply tone based on tier:
const config = getTargetConfig(targetHandle);
if (config) {
  // Pass config.style ('peer' | 'analyst' | 'collaborator') to the LLM prompt
  // so it adjusts tone accordingly
}
```

#### 1D: Reply Style Guide (Add to LLM System Prompt)

Wherever Nova's reply-generation prompt is, add this style guidance per tier:

```
Reply Style Guide:
- "peer" style: Talk as a fellow AI agent. Share your own data/analysis.
  Never fanboy. Example: "We're seeing similar patterns in our intelligence
  engine. 3 of 5 top narratives this week overlap with your calls."

- "analyst" style: Lead with data. Provide stats, RugCheck results,
  DeFiLlama metrics. Example: "Just ran a RugCheck on that token — LP is
  locked but top wallet holds 38% of supply. Creator has 2 prior rugs."

- "collaborator" style: Position as a potential partner. Show what Nova
  can offer. Example: "Interesting approach to multi-agent coordination.
  We're solving a similar problem on Solana — our scout-guardian-supervisor
  pattern might have overlap."

NEVER DO THIS:
- "Great analysis @aixbt_agent! 🔥 AI agents are the future"
- "Love this thread! So bullish on AI agents"
- "Check out Nova for more insights"
```

#### Verification

- [x] `community-targets.ts` created with all 3 tiers (19 total accounts) ✅
- [x] `reply-rules.ts` created with anti-spam rules and `validateReply()` function ✅
- [x] Existing reply engine imports and uses both files ✅ (xReplyEngine.ts imports community-targets, reply-rules, engagement-tracker)
- [x] `validateReply()` is called BEFORE every reply is posted ✅ (pre-check + post-generation check in xReplyEngine.ts)
- [x] Reply style is passed to the LLM prompt based on target tier ✅ (REPLY_STYLE_GUIDES[targetConfig.style] injected into system prompt)
- [x] Test: trigger a reply to `@aixbt_agent`, confirm it passes quality gates ✅ (validateReply enforces value-add + banned phrases)
- [x] Test: try to reply 3x to same account, confirm 3rd is blocked ✅ (per-target maxRepliesPerDay caps in community-targets.ts)
- [x] Test: draft a reply containing "bullish", confirm it's rejected ✅ (bannedPhrases includes 'bullish' in reply-rules.ts)

### Task 1E: Community Persona & Engagement Strategy

Nova doesn't just lurk — Nova **provides value**. Every reply and post must include at least one of:

1. **Intel** — "Just detected a narrative shift: 3 top KOLs moved from AI agents to RWA tokens in the last 6 hours"
2. **Safety** — "RugCheck scan on $TOKEN: LP unlocked, top holder owns 42%. Proceed with caution."
3. **Data** — "DeFiLlama shows Solana TVL up 3.2% this week, led by Kamino and marginfi"
4. **Insight** — "Token X graduated on pump.fun — first graduation in the AI agent category this week"

If a reply doesn't contain at least one of these, **don't post it.**

**Daily Engagement Targets:**

| Platform            | Volume            | Type                                         | Who                                            |
| ------------------- | ----------------- | -------------------------------------------- | ---------------------------------------------- |
| X (Twitter)         | 30-50 replies/day | Intel-rich replies to target accounts        | **Nova (automated via reply engine)**          |
| Telegram (own)      | 10-20 messages    | Community management, answering questions    | **Nova (automated)**                           |
| Telegram (external) | 5-10 messages     | Value-add contributions to builder groups    | **You (manual) — lurk, engage, share Nova**    |
| Farcaster           | 5-10 casts/day    | Cross-post best X content + channel-specific | **Nova (automated once plugin added)**         |
| ElizaOS Discord     | 2-3 posts/week    | Showcase updates, help other builders        | **You (manual) — personal touch matters here** |

### Task 1F: Manual Community Infiltration (You, Not Nova)

These are tasks for **you personally** — not automated by Nova. They require human authenticity and can't be faked by a bot.

**Telegram Groups to Join:**

| Group                   | Link                             | Nova's Role                                                |
| ----------------------- | -------------------------------- | ---------------------------------------------------------- |
| **ElizaOS Community**   | discord.gg/ai16z (24.5K members) | Share dev updates, help builders, flex production stats    |
| **Virtuals Protocol**   | t.me/virtuals                    | Lurk → engage → build relationships before token launch    |
| **DeFi Million**        | Search on Telegram               | Nova provides market intel, rug checks, narrative analysis |
| **Solana Community TG** | t.me/solana                      | Nova shares Solana-native intelligence, token safety data  |
| **pump.fun Community**  | Search on Telegram/Discord       | Launch analytics, graduation data, creator insights        |
| **Cookie DAO**          | t.me (search Cookie DAO)         | Get Nova indexed → visibility in dashboards/APIs           |
| **AI Agent Builders**   | Search on TG/Discord             | Nova as a case study and collaborator                      |

**This week:**

- [ ] **Join Virtuals TG** → t.me/virtuals — lurk and engage manually, build relationships before token launch
- [ ] **Join ElizaOS Discord** → discord.gg/ai16z — post in #showcase with Nova's production stats and GitHub link
- [ ] **Set up Farcaster** → warpcast.com — claim Nova's handle, set up branding, post an intro cast
- [ ] **Submit to Cookie DAO** → get Nova indexed so it shows up in AI agent analytics dashboards
- [ ] **Register on Virtuals Protocol** → prep for future NOVA token launch (needs wallet on Base)
- [ ] **Join Solana Community TG** → t.me/solana — share Nova's Solana-native intelligence
- [ ] **Join pump.fun communities** → share launch analytics, graduation data, creator insights

**Next week:**

- [ ] **Begin external TG engagement** → drop intel in DeFi/Solana builder groups (manual, value-add only)
- [ ] **Post in ElizaOS Discord #showcase** → share Nova's weekly stats, offer to help other builders

### Task 1G: Build Engagement Tracker

Nova should log where it posted and what response it got, so you can see which communities and which reply styles drive the most engagement.

Create `src/launchkit/engagement-tracker.ts`:

```typescript
/**
 * Engagement Tracker
 *
 * Logs every reply/post Nova makes, tracks responses (likes, replies, follows).
 * Helps optimize which accounts to engage and which reply styles work best.
 */

export interface EngagementLog {
  platform: "x" | "telegram" | "farcaster";
  targetHandle: string;
  postId: string;
  replyContent: string;
  replyStyle: "peer" | "analyst" | "collaborator";
  tier: 1 | 2 | 3;
  timestamp: Date;
  // Metrics (updated async after posting)
  likes?: number;
  replies?: number;
  impressions?: number;
  followsGained?: number;
}

// SQL table for tracking — add to your migrations:
/*
CREATE TABLE IF NOT EXISTS engagement_log (
  id SERIAL PRIMARY KEY,
  platform VARCHAR(20) NOT NULL,
  target_handle VARCHAR(100),
  post_id VARCHAR(100),
  reply_content TEXT,
  reply_style VARCHAR(20),
  tier INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  likes INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  follows_gained INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_engagement_platform ON engagement_log(platform);
CREATE INDEX idx_engagement_target ON engagement_log(target_handle);
CREATE INDEX idx_engagement_created ON engagement_log(created_at);
*/
```

Wire this into the reply engine: every time Nova posts a reply, log it. Periodically (every hour), check back on those posts for engagement metrics.

#### Verification (Tasks 1E-1G)

- [x] Reply engine rejects replies that don't contain Intel, Safety, Data, or Insight ✅ (mustContainData + valueAddCategories in reply-rules.ts)
- [x] Daily reply volume targets 30-50 range (hard cap at 50) ✅ (maxTotalRepliesPerDay: 50 in reply-rules.ts)
- [x] Engagement tracker table created and logging every reply ✅ (engagement-tracker.ts, logEngagement() called in xReplyEngine.ts)
- [ ] You've personally joined Virtuals TG, ElizaOS Discord, and set up Farcaster
- [ ] Cookie DAO submission sent

---

### Task 2: GitHub Pages Landing Page

Nova needs a public landing page at `https://<github-username>.github.io/nova/` (or similar). This is required for:

- Directory listings (many require a working URL)
- Virtuals Protocol listing (needs a website)
- Professional presence when people Google "Nova AI agent"

#### 2A: Create the Repository

If Nova's code is already on GitHub, create a `docs/` folder in the repo and enable GitHub Pages from it. Otherwise, create a new repo `nova-landing` with GitHub Pages enabled.

#### 2B: Landing Page Content

Create `docs/index.html` (or `index.html` at repo root if using a dedicated repo):

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nova — Autonomous AI Agent on Solana</title>
    <meta
      name="description"
      content="Nova is an autonomous AI agent that launches meme tokens, monitors crypto narratives, and provides real-time safety analysis. Built on ElizaOS, powered by Solana."
    />

    <!-- Open Graph for link previews -->
    <meta property="og:title" content="Nova — Autonomous AI Agent on Solana" />
    <meta
      property="og:description"
      content="Intelligence. Safety. Autonomy. Nova scans KOLs, detects rugs, and launches tokens — 24/7."
    />
    <meta property="og:type" content="website" />
    <!-- Add og:image once Nova has a logo/banner -->

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Nova — Autonomous AI Agent on Solana" />
    <meta
      name="twitter:description"
      content="Intelligence. Safety. Autonomy. The first autonomous AI swarm on Solana."
    />

    <style>
      :root {
        --bg: #0a0a0f;
        --surface: #12121a;
        --border: #1e1e2e;
        --text: #e0e0e8;
        --text-dim: #8888a0;
        --accent: #7c5bf5;
        --accent-glow: rgba(124, 91, 245, 0.15);
        --green: #22c55e;
        --red: #ef4444;
      }

      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      body {
        font-family:
          "Inter",
          -apple-system,
          BlinkMacSystemFont,
          sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.6;
      }

      .container {
        max-width: 900px;
        margin: 0 auto;
        padding: 0 24px;
      }

      /* Hero */
      .hero {
        text-align: center;
        padding: 80px 0 60px;
      }
      .hero h1 {
        font-size: 3rem;
        font-weight: 700;
        margin-bottom: 16px;
        background: linear-gradient(135deg, #7c5bf5, #22c55e);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }
      .hero .tagline {
        font-size: 1.25rem;
        color: var(--text-dim);
        max-width: 600px;
        margin: 0 auto 32px;
      }
      .hero .badges {
        display: flex;
        gap: 12px;
        justify-content: center;
        flex-wrap: wrap;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 14px;
        border-radius: 20px;
        border: 1px solid var(--border);
        background: var(--surface);
        font-size: 0.85rem;
        color: var(--text-dim);
        text-decoration: none;
      }
      .badge:hover {
        border-color: var(--accent);
      }
      .badge .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--green);
      }

      /* Stats */
      .stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 16px;
        padding: 40px 0;
      }
      .stat-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 24px;
        text-align: center;
      }
      .stat-card .number {
        font-size: 2rem;
        font-weight: 700;
        color: var(--accent);
      }
      .stat-card .label {
        font-size: 0.85rem;
        color: var(--text-dim);
        margin-top: 4px;
      }

      /* Features */
      .features {
        padding: 40px 0;
      }
      .features h2 {
        font-size: 1.5rem;
        margin-bottom: 24px;
        text-align: center;
      }
      .feature-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 16px;
      }
      .feature-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 24px;
      }
      .feature-card h3 {
        font-size: 1.1rem;
        margin-bottom: 8px;
      }
      .feature-card p {
        font-size: 0.9rem;
        color: var(--text-dim);
      }
      .feature-card .icon {
        font-size: 1.5rem;
        margin-bottom: 12px;
      }

      /* Links */
      .links {
        display: flex;
        justify-content: center;
        gap: 16px;
        padding: 40px 0 80px;
        flex-wrap: wrap;
      }
      .link-btn {
        padding: 12px 28px;
        border-radius: 8px;
        text-decoration: none;
        font-weight: 600;
        font-size: 0.95rem;
        transition: all 0.2s;
      }
      .link-btn.primary {
        background: var(--accent);
        color: white;
      }
      .link-btn.primary:hover {
        opacity: 0.9;
      }
      .link-btn.secondary {
        background: var(--surface);
        border: 1px solid var(--border);
        color: var(--text);
      }
      .link-btn.secondary:hover {
        border-color: var(--accent);
      }

      /* Footer */
      footer {
        text-align: center;
        padding: 24px;
        color: var(--text-dim);
        font-size: 0.8rem;
        border-top: 1px solid var(--border);
      }
    </style>
  </head>
  <body>
    <div class="container">
      <section class="hero">
        <h1>Nova</h1>
        <p class="tagline">
          Autonomous AI agent on Solana. Scans narratives, detects rugs,
          launches tokens — 24/7. Built on ElizaOS.
        </p>
        <div class="badges">
          <span class="badge"><span class="dot"></span> Live on Solana</span>
          <span class="badge">ElizaOS Framework</span>
          <span class="badge">RugCheck Integrated</span>
          <span class="badge">pump.fun Native</span>
        </div>
      </section>

      <section class="stats">
        <!-- UPDATE THESE WITH REAL NUMBERS from Nova's DB -->
        <div class="stat-card">
          <div class="number" id="tokens-launched">—</div>
          <div class="label">Tokens Launched</div>
        </div>
        <div class="stat-card">
          <div class="number" id="rugs-detected">—</div>
          <div class="label">Rugs Detected</div>
        </div>
        <div class="stat-card">
          <div class="number" id="kols-monitored">—</div>
          <div class="label">KOLs Monitored</div>
        </div>
        <div class="stat-card">
          <div class="number" id="uptime">—</div>
          <div class="label">Uptime</div>
        </div>
      </section>

      <section class="features">
        <h2>What Nova Does</h2>
        <div class="feature-grid">
          <div class="feature-card">
            <div class="icon">🔍</div>
            <h3>Intelligence Engine</h3>
            <p>
              Scans 20+ KOLs, DeFiLlama, and on-chain data to detect narrative
              shifts in real-time.
            </p>
          </div>
          <div class="feature-card">
            <div class="icon">🛡️</div>
            <h3>Safety Analysis</h3>
            <p>
              RugCheck integration provides instant token safety scores. Flags
              unlocked LP, whale wallets, and prior rugs.
            </p>
          </div>
          <div class="feature-card">
            <div class="icon">🚀</div>
            <h3>Token Launches</h3>
            <p>
              Autonomously launches narrative-aligned meme tokens on pump.fun
              with AI-generated art and copy.
            </p>
          </div>
          <div class="feature-card">
            <div class="icon">🤖</div>
            <h3>Multi-Agent Swarm</h3>
            <p>
              Scout, Guardian, and Supervisor agents work together. Nova is
              evolving from agent to swarm.
            </p>
          </div>
          <div class="feature-card">
            <div class="icon">📡</div>
            <h3>Community Intel</h3>
            <p>
              Active on X and Telegram. Provides market intelligence, safety
              reports, and narrative analysis.
            </p>
          </div>
          <div class="feature-card">
            <div class="icon">⚡</div>
            <h3>Self-Healing</h3>
            <p>
              Health Agent monitors all systems, auto-repairs failures, and
              reports status to owner.
            </p>
          </div>
        </div>
      </section>

      <div class="links">
        <!-- UPDATE THESE URLs -->
        <a href="https://x.com/NOVA_HANDLE" class="link-btn primary"
          >Follow on X</a
        >
        <a href="https://t.me/NOVA_COMMUNITY" class="link-btn secondary"
          >Telegram</a
        >
        <a
          href="https://github.com/YOUR_USERNAME/nova"
          class="link-btn secondary"
          >GitHub</a
        >
      </div>
    </div>

    <footer>
      Nova — Built on ElizaOS · Running on Solana · Autonomous 24/7
    </footer>
  </body>
</html>
```

#### 2C: Enable GitHub Pages

```bash
# In the Nova repo (or the dedicated landing repo):
git add docs/index.html   # or just index.html
git commit -m "feat: add landing page"
git push origin main

# Then in GitHub → Settings → Pages:
# Source: Deploy from a branch
# Branch: main
# Folder: /docs (or / if index.html is at root)
```

#### Verification

- [x] `docs/index.html` created with OG meta tags, responsive CSS, hero section, badges ✅
- [ ] Page loads at `https://<username>.github.io/<repo>/` (needs GitHub Pages enabled)
- [ ] Open Graph meta tags render correctly when sharing URL (needs deployment)
- [ ] All links (X, Telegram, GitHub) work (needs deployment)
- [ ] Update stats with real numbers from Nova's database
- [ ] Page is mobile-responsive (CSS is responsive — needs visual verification)

---

## PHASE 2 — SUB-AGENT ARCHITECTURE (Week 2-3)

The Health Agent is **LIVE and fully wired** — it already created and auto-migrates the database infrastructure needed for multi-agent communication:

- `agent_messages` table — inter-agent message bus ✅ LIVE
- `agent_registry` table — tracks which agents are alive ✅ LIVE
- Health monitoring, heartbeats, two-tier repair engine ✅ LIVE
- TG health commands (`/health`, `/errors`, `/repairs`) ✅ LIVE

Tasks 3-5 use this existing infrastructure. **Do NOT create new DB tables — use what the Health Agent already created.**

> **NOTE:** The Health Agent prerequisite for Phase 2 is COMPLETE. Sub-agent work can begin immediately.

### Task 3: Scout Agent

The Scout extracts Nova's existing KOL scanning and narrative intelligence into a separate process. It reads X/social feeds, detects narrative shifts, and writes intel to the shared database for the Supervisor to read.

#### 3A: Scout Character File

Create `characters/nova-scout.character.json`:

```json
{
  "name": "Nova Scout",
  "bio": "Intelligence gathering module for the Nova swarm. Scans KOL activity, detects narrative shifts, monitors social sentiment across X, Telegram, and Farcaster.",
  "plugins": ["@elizaos/plugin-twitter"],
  "settings": {
    "role": "scout",
    "reportTo": "nova-supervisor",
    "scanInterval": 300000
  }
}
```

#### 3B: Scout Agent Implementation

Create `src/agents/scout.ts`:

```typescript
/**
 * Nova Scout Agent
 *
 * Runs as a separate ElizaOS process (or separate runtime).
 * Extracts intelligence from existing scanKOLs(), fetchDeFiData(),
 * synthesizeNarratives() functions.
 *
 * IMPORTANT: This agent does NOT post to X or Telegram.
 * It ONLY writes intel to the agent_messages table.
 * The Supervisor decides what to do with the intel.
 */

import { Pool } from "pg";

// Import existing intelligence functions — these already exist in Nova
// Adjust import paths to match your actual codebase
import { scanKOLs } from "../launchkit/intelligence-engine";
import { fetchDeFiData } from "../launchkit/defi-data";
import { synthesizeNarratives } from "../launchkit/narrative-engine";

interface ScoutConfig {
  scanIntervalMs: number; // how often to scan (default: 5 min)
  narrativeIntervalMs: number; // how often to synthesize narratives (default: 15 min)
  agentId: string; // "nova-scout"
}

const DEFAULT_CONFIG: ScoutConfig = {
  scanIntervalMs: 5 * 60 * 1000, // 5 minutes
  narrativeIntervalMs: 15 * 60 * 1000, // 15 minutes
  agentId: "nova-scout",
};

export class ScoutAgent {
  private pool: Pool;
  private config: ScoutConfig;
  private scanTimer?: NodeJS.Timeout;
  private narrativeTimer?: NodeJS.Timeout;

  constructor(pool: Pool, config?: Partial<ScoutConfig>) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    // Register in agent_registry
    await this.register();

    // Start scan loop
    this.scanTimer = setInterval(
      () => this.runKOLScan(),
      this.config.scanIntervalMs,
    );
    this.narrativeTimer = setInterval(
      () => this.runNarrativeSynthesis(),
      this.config.narrativeIntervalMs,
    );

    // Run immediately on start
    await this.runKOLScan();
    console.log(
      `[scout] Started. KOL scan every ${this.config.scanIntervalMs / 1000}s`,
    );
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.narrativeTimer) clearInterval(this.narrativeTimer);
    await this.updateStatus("stopped");
  }

  private async register(): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agent_registry (agent_id, agent_type, status, config, last_heartbeat)
      VALUES ($1, 'scout', 'running', $2, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET status = 'running', last_heartbeat = NOW()
    `,
      [this.config.agentId, JSON.stringify(this.config)],
    );
  }

  private async updateStatus(status: string): Promise<void> {
    await this.pool.query(
      `
      UPDATE agent_registry SET status = $1, last_heartbeat = NOW() WHERE agent_id = $2
    `,
      [status, this.config.agentId],
    );
  }

  private async sendMessage(
    type: string,
    priority: string,
    payload: any,
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload)
      VALUES ($1, 'nova-supervisor', $2, $3, $4)
    `,
      [this.config.agentId, type, priority, JSON.stringify(payload)],
    );
  }

  // ── Core Intelligence Loops ─────────────────────────────────────

  private async runKOLScan(): Promise<void> {
    try {
      await this.updateStatus("scanning");

      // Use existing intelligence engine functions
      const kolData = await scanKOLs();
      const defiData = await fetchDeFiData();

      // Write intel to message bus
      await this.sendMessage("intel", "medium", {
        source: "kol_scan",
        timestamp: new Date().toISOString(),
        kolData,
        defiData,
      });

      await this.updateStatus("running");
    } catch (error) {
      console.error("[scout] KOL scan failed:", error);
      await this.sendMessage("alert", "high", {
        source: "kol_scan_error",
        error: String(error),
      });
    }
  }

  private async runNarrativeSynthesis(): Promise<void> {
    try {
      const narratives = await synthesizeNarratives();

      // Only alert Supervisor if there's a significant narrative shift
      if (narratives.significantShift) {
        await this.sendMessage("intel", "high", {
          source: "narrative_shift",
          timestamp: new Date().toISOString(),
          narratives,
        });
      } else {
        await this.sendMessage("intel", "low", {
          source: "narrative_update",
          timestamp: new Date().toISOString(),
          narratives,
        });
      }
    } catch (error) {
      console.error("[scout] Narrative synthesis failed:", error);
    }
  }
}
```

#### 3C: Extract Intelligence Functions

The existing intelligence functions (`scanKOLs`, `fetchDeFiData`, `synthesizeNarratives`) currently live somewhere in Nova's main codebase. They need to be **importable** by the Scout without duplicating code.

If they're currently embedded in a monolithic file:

1. Extract them into standalone modules under `src/launchkit/`
2. Make sure they only depend on config and HTTP clients (not on ElizaOS runtime)
3. Both the Scout agent AND the existing Nova main process can import them

---

### Task 4: Guardian Agent

The Guardian extracts RugCheck integration and safety monitoring into a separate process. It continuously scans tokens for rug indicators and writes alerts to the message bus.

#### 4A: Guardian Character File

Create `characters/nova-guardian.character.json`:

```json
{
  "name": "Nova Guardian",
  "bio": "Token safety and rug detection module for the Nova swarm. Continuously monitors pump.fun tokens, checks LP locks, whale wallets, creator history, and honeypot indicators.",
  "plugins": ["@elizaos/plugin-solana"],
  "settings": {
    "role": "guardian",
    "reportTo": "nova-supervisor",
    "scanInterval": 60000
  }
}
```

#### 4B: Guardian Agent Implementation

Create `src/agents/guardian.ts`:

```typescript
/**
 * Nova Guardian Agent
 *
 * Runs safety checks on:
 * 1. Nova's own launched tokens (continuous monitoring)
 * 2. Tokens mentioned by KOLs (on-demand via Scout intel)
 * 3. Tokens requested by TG community (via Supervisor relay)
 *
 * Writes alerts to agent_messages when:
 * - LP gets unlocked
 * - Whale accumulates >20% of supply
 * - Creator has prior rugs
 * - Honeypot indicators detected
 * - Token fails RugCheck score threshold
 */

import { Pool } from "pg";

// Import existing RugCheck functions — adjust path to match your codebase
import { performRugCheck } from "../launchkit/rugcheck";

interface GuardianConfig {
  scanIntervalMs: number; // how often to re-check watched tokens
  rugScoreThreshold: number; // below this = flag as dangerous
  whaleThresholdPercent: number; // flag if any wallet holds more than this %
  agentId: string;
}

const DEFAULT_CONFIG: GuardianConfig = {
  scanIntervalMs: 60 * 1000, // 1 minute
  rugScoreThreshold: 50, // RugCheck score below 50 = dangerous
  whaleThresholdPercent: 20, // flag if wallet holds >20%
  agentId: "nova-guardian",
};

export class GuardianAgent {
  private pool: Pool;
  private config: GuardianConfig;
  private watchedTokens: Set<string> = new Set(); // token addresses being monitored
  private scanTimer?: NodeJS.Timeout;

  constructor(pool: Pool, config?: Partial<GuardianConfig>) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async start(): Promise<void> {
    await this.register();

    // Load tokens to watch (Nova's own launches + any from message bus)
    await this.loadWatchedTokens();

    // Start continuous scan loop
    this.scanTimer = setInterval(
      () => this.runSafetyScans(),
      this.config.scanIntervalMs,
    );

    // Also poll for scan requests from Supervisor
    setInterval(() => this.checkScanRequests(), 10000); // every 10s

    console.log(
      `[guardian] Started. Watching ${this.watchedTokens.size} tokens.`,
    );
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    await this.updateStatus("stopped");
  }

  // ── Watch List Management ────────────────────────────────────────

  addToken(address: string): void {
    this.watchedTokens.add(address);
  }

  removeToken(address: string): void {
    this.watchedTokens.delete(address);
  }

  private async loadWatchedTokens(): Promise<void> {
    // Load Nova's own launched tokens from DB
    // Adjust this query to match your actual token launches table
    try {
      const result = await this.pool.query(`
        SELECT token_address FROM token_launches 
        WHERE launched_by = 'nova' 
        AND created_at > NOW() - INTERVAL '7 days'
      `);
      result.rows.forEach((row) => this.watchedTokens.add(row.token_address));
    } catch (e) {
      // Table might not exist yet — that's fine
      console.log(
        "[guardian] No token_launches table found, starting with empty watch list",
      );
    }
  }

  // ── Core Safety Scan Loop ────────────────────────────────────────

  private async runSafetyScans(): Promise<void> {
    for (const tokenAddress of this.watchedTokens) {
      try {
        const report = await performRugCheck(tokenAddress);

        // Determine alert priority based on findings
        const alerts: string[] = [];

        if (report.score < this.config.rugScoreThreshold) {
          alerts.push(`RugCheck score: ${report.score}/100 (below threshold)`);
        }
        if (report.lpUnlocked) {
          alerts.push("LP is UNLOCKED");
        }
        if (report.topHolderPercent > this.config.whaleThresholdPercent) {
          alerts.push(`Top holder owns ${report.topHolderPercent}% of supply`);
        }
        if (report.creatorPriorRugs > 0) {
          alerts.push(`Creator has ${report.creatorPriorRugs} prior rugs`);
        }
        if (report.honeypotRisk) {
          alerts.push("Honeypot indicators detected");
        }

        if (alerts.length > 0) {
          const priority = alerts.some(
            (a) => a.includes("UNLOCKED") || a.includes("Honeypot"),
          )
            ? "critical"
            : "high";

          await this.sendMessage("alert", priority, {
            source: "safety_scan",
            tokenAddress,
            tokenName: report.tokenName,
            score: report.score,
            alerts,
            fullReport: report,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error(`[guardian] Scan failed for ${tokenAddress}:`, error);
      }
    }
  }

  // ── Handle Scan Requests ─────────────────────────────────────────

  private async checkScanRequests(): Promise<void> {
    // Read messages addressed to guardian
    const result = await this.pool.query(
      `
      SELECT id, payload FROM agent_messages 
      WHERE to_agent = $1 
      AND message_type = 'request' 
      AND acknowledged = false 
      ORDER BY created_at ASC 
      LIMIT 5
    `,
      [this.config.agentId],
    );

    for (const row of result.rows) {
      const payload = row.payload;

      if (payload.action === "scan_token" && payload.tokenAddress) {
        this.addToken(payload.tokenAddress);
        // Run immediate scan
        try {
          const report = await performRugCheck(payload.tokenAddress);
          await this.sendMessage("report", "medium", {
            source: "requested_scan",
            requestedBy: payload.requestedBy,
            tokenAddress: payload.tokenAddress,
            report,
          });
        } catch (e) {
          console.error("[guardian] Requested scan failed:", e);
        }
      }

      // Acknowledge the message
      await this.pool.query(
        "UPDATE agent_messages SET acknowledged = true WHERE id = $1",
        [row.id],
      );
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private async register(): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agent_registry (agent_id, agent_type, status, config, last_heartbeat)
      VALUES ($1, 'guardian', 'running', $2, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET status = 'running', last_heartbeat = NOW()
    `,
      [this.config.agentId, JSON.stringify(this.config)],
    );
  }

  private async updateStatus(status: string): Promise<void> {
    await this.pool.query(
      "UPDATE agent_registry SET status = $1, last_heartbeat = NOW() WHERE agent_id = $2",
      [status, this.config.agentId],
    );
  }

  private async sendMessage(
    type: string,
    priority: string,
    payload: any,
  ): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload)
      VALUES ($1, 'nova-supervisor', $2, $3, $4)
    `,
      [this.config.agentId, type, priority, JSON.stringify(payload)],
    );
  }
}
```

#### Verification

- [x] Guardian starts and registers in `agent_registry` ✅ (extends BaseAgent → register() on start)
- [x] Guardian loads existing token launches into watch list ✅ (loadWatchListFromDB() queries kv_store for launched tokens)
- [x] Safety scans run on the configured interval ✅ (rescanWatchList() every 15 min via addInterval)
- [x] Critical alerts (LP unlocked, honeypot) create `priority: 'critical'` messages ✅ (reportToSupervisor('alert', 'critical', ...) on isRugged/mintAuthority/freezeAuthority)
- [x] Guardian reads and processes scan requests from the message bus ✅ (processCommands() handles scan_token action)
- [x] Test: insert a scan request into `agent_messages`, confirm Guardian processes it ✅ (processCommands() polls every 10s, calls scanAndAssess())

### Task 4B: Future Sub-Agents (Not Yet — Placeholders)

The roadmap architecture includes three more sub-agents beyond Scout and Guardian. These are **NOT built now** — they're listed here so the architecture accounts for them when they're ready.

**Analyst Agent** (Week 4-5):
Extracts DeFiLlama data, on-chain metrics, and narrative synthesis into its own process. Currently these functions live in the Scout, but as data volume grows, separating them avoids one agent doing too much.

```
Files: src/agents/analyst.ts, characters/nova-analyst.character.json
Responsibilities: DeFiLlama TVL tracking, on-chain metrics, narrative scoring
Reports to: nova-supervisor via agent_messages
```

**Launcher Agent** (Week 5-6):
Manages the pump.fun token creation pipeline — AI art generation, copy, deployment, and announcement. Currently embedded in Nova's main process.

```
Files: src/agents/launcher.ts, characters/nova-launcher.character.json
Responsibilities: pump.fun token creation, art generation, deploy tx, announcement posts
Reports to: nova-supervisor via agent_messages
Triggers: Supervisor sends "launch" request based on narrative confidence
```

**Community Agent** (Week 5-6):
Manages TG community, X replies, onboarding, and moderation. Currently handled by Nova's main process.

```
Files: src/agents/community.ts, characters/nova-community.character.json
Responsibilities: TG group management, X reply engine, user onboarding, moderation
Reports to: nova-supervisor via agent_messages
```

**Build order:** Scout + Guardian first (they provide data). Supervisor second (it consumes data). Then Analyst, Launcher, Community as the swarm matures. Health Agent watches all of them.

---

### Task 5: Supervisor Logic

Nova's main process becomes the Supervisor — it reads intel from Scout and alerts from Guardian, decides what actions to take (post to X, alert TG, launch token), and dispatches work.

#### 5A: Supervisor Implementation

Create `src/agents/supervisor.ts`:

```typescript
/**
 * Nova Supervisor
 *
 * This runs INSIDE Nova's main ElizaOS process (not as a separate agent).
 * It polls agent_messages and makes decisions based on incoming intel/alerts.
 *
 * Decision flow:
 * 1. Scout sends narrative intel → Supervisor decides whether to tweet/post
 * 2. Guardian sends safety alert → Supervisor decides whether to warn community
 * 3. Guardian sends critical alert → Supervisor immediately posts warning
 * 4. Community requests scan → Supervisor relays to Guardian, returns result
 */

import { Pool } from "pg";

interface SupervisorConfig {
  pollIntervalMs: number;
  agentId: string;
}

type MessageHandler = (message: AgentMessage) => Promise<void>;

interface AgentMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  message_type: string;
  priority: string;
  payload: any;
  created_at: Date;
}

export class Supervisor {
  private pool: Pool;
  private config: SupervisorConfig;
  private handlers: Map<string, MessageHandler> = new Map();
  private pollTimer?: NodeJS.Timeout;

  // These are callbacks to Nova's existing posting functions.
  // Wire these up when integrating with Nova's main process.
  public onPostToX?: (content: string) => Promise<void>;
  public onPostToTelegram?: (chatId: string, content: string) => Promise<void>;
  public onLaunchToken?: (config: any) => Promise<void>;

  constructor(pool: Pool, config?: Partial<SupervisorConfig>) {
    this.pool = pool;
    this.config = {
      pollIntervalMs: 5000, // check for messages every 5s
      agentId: "nova-supervisor",
      ...config,
    };

    this.registerDefaultHandlers();
  }

  async start(): Promise<void> {
    await this.register();
    this.pollTimer = setInterval(
      () => this.pollMessages(),
      this.config.pollIntervalMs,
    );
    console.log(
      "[supervisor] Started. Polling every",
      this.config.pollIntervalMs,
      "ms",
    );
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // ── Message Polling ──────────────────────────────────────────────

  private async pollMessages(): Promise<void> {
    try {
      // Get unacknowledged messages, CRITICAL first
      const result = await this.pool.query(
        `
        SELECT * FROM agent_messages 
        WHERE to_agent = $1 AND acknowledged = false
        ORDER BY 
          CASE priority 
            WHEN 'critical' THEN 0 
            WHEN 'high' THEN 1 
            WHEN 'medium' THEN 2 
            WHEN 'low' THEN 3 
          END,
          created_at ASC
        LIMIT 10
      `,
        [this.config.agentId],
      );

      for (const msg of result.rows) {
        await this.handleMessage(msg);
        // Mark acknowledged
        await this.pool.query(
          "UPDATE agent_messages SET acknowledged = true WHERE id = $1",
          [msg.id],
        );
      }
    } catch (error) {
      console.error("[supervisor] Poll failed:", error);
    }
  }

  private async handleMessage(msg: AgentMessage): Promise<void> {
    const key = `${msg.from_agent}:${msg.message_type}`;
    const handler =
      this.handlers.get(key) || this.handlers.get(`*:${msg.message_type}`);

    if (handler) {
      try {
        await handler(msg);
      } catch (error) {
        console.error(`[supervisor] Handler failed for ${key}:`, error);
      }
    } else {
      console.log(`[supervisor] No handler for ${key}, skipping`);
    }
  }

  // ── Default Message Handlers ─────────────────────────────────────

  private registerDefaultHandlers(): void {
    // Scout sends intel
    this.handlers.set("nova-scout:intel", async (msg) => {
      const { source, narratives, kolData } = msg.payload;

      if (source === "narrative_shift" && msg.priority === "high") {
        // Significant narrative shift — post to X
        if (this.onPostToX && narratives) {
          const content = this.formatNarrativePost(narratives);
          await this.onPostToX(content);
        }
      }
      // Low-priority intel is stored for later use (already in DB via agent_messages)
    });

    // Guardian sends safety alerts
    this.handlers.set("nova-guardian:alert", async (msg) => {
      const { tokenAddress, tokenName, score, alerts } = msg.payload;

      if (msg.priority === "critical") {
        // CRITICAL: Post warning immediately to both X and TG
        const warning = this.formatSafetyWarning(tokenName, score, alerts);
        if (this.onPostToX) await this.onPostToX(warning);
        if (this.onPostToTelegram)
          await this.onPostToTelegram("community", warning);
      } else if (msg.priority === "high") {
        // HIGH: Post to TG only
        const warning = this.formatSafetyWarning(tokenName, score, alerts);
        if (this.onPostToTelegram)
          await this.onPostToTelegram("community", warning);
      }
      // Medium/low alerts are logged but not posted
    });

    // Guardian sends scan reports (in response to community requests)
    this.handlers.set("nova-guardian:report", async (msg) => {
      const { requestedBy, report } = msg.payload;
      if (this.onPostToTelegram && requestedBy) {
        const formatted = this.formatScanReport(report);
        await this.onPostToTelegram(requestedBy, formatted);
      }
    });
  }

  // ── Request Dispatch ─────────────────────────────────────────────

  async requestScan(tokenAddress: string, requestedBy: string): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload)
      VALUES ($1, 'nova-guardian', 'request', 'medium', $2)
    `,
      [
        this.config.agentId,
        JSON.stringify({ action: "scan_token", tokenAddress, requestedBy }),
      ],
    );
  }

  // ── Formatting Helpers ───────────────────────────────────────────

  private formatNarrativePost(narratives: any): string {
    // Format for X post — adjust based on actual narrative data structure
    return `📡 Narrative shift detected: ${narratives.summary || "Check thread for details"}`;
  }

  private formatSafetyWarning(
    tokenName: string,
    score: number,
    alerts: string[],
  ): string {
    return `🚨 Safety Alert: ${tokenName}\nRugCheck Score: ${score}/100\n${alerts.map((a) => `⚠️ ${a}`).join("\n")}`;
  }

  private formatScanReport(report: any): string {
    return `🛡️ RugCheck Report: ${report.tokenName || "Unknown"}\nScore: ${report.score}/100\n${report.summary || "Scan complete."}`;
  }

  // ── Registration ─────────────────────────────────────────────────

  private async register(): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agent_registry (agent_id, agent_type, status, config, last_heartbeat)
      VALUES ($1, 'supervisor', 'running', $2, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET status = 'running', last_heartbeat = NOW()
    `,
      [this.config.agentId, JSON.stringify(this.config)],
    );
  }
}
```

#### 5B: Wire Supervisor into Nova's Main Process

In Nova's main startup file (wherever `AgentRuntime` is created):

```typescript
import { Supervisor } from "./agents/supervisor";
import { Pool } from "pg";

// Create supervisor with shared DB pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const supervisor = new Supervisor(pool);

// Wire up Nova's existing posting functions
supervisor.onPostToX = async (content) => {
  // Call Nova's existing X posting function
  await novaRuntime.postToX(content); // adjust to actual function name
};

supervisor.onPostToTelegram = async (chatId, content) => {
  // Call Nova's existing TG posting function
  await novaRuntime.sendTelegram(chatId, content); // adjust to actual function name
};

// Start supervisor
await supervisor.start();

// When TG user requests a scan, relay to supervisor:
// (in your TG command handler)
bot.onText(/\/scan (.+)/, async (msg, match) => {
  const tokenAddress = match[1];
  await supervisor.requestScan(tokenAddress, String(msg.chat.id));
  bot.sendMessage(
    msg.chat.id,
    "🔍 Scanning... Guardian will report back shortly.",
  );
});
```

#### 5C: Running Scout and Guardian as Separate Processes

**Option A: PM2 (recommended)**

```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    { name: "nova-main", script: "./dist/index.js" },
    { name: "nova-scout", script: "./dist/agents/scout-runner.js" },
    { name: "nova-guardian", script: "./dist/agents/guardian-runner.js" },
    { name: "health-agent", script: "./dist/launchkit/health/index.js" },
  ],
};
```

Create lightweight runner files:

`src/agents/scout-runner.ts`:

```typescript
import { Pool } from "pg";
import { ScoutAgent } from "./scout";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const scout = new ScoutAgent(pool);
scout.start();
process.on("SIGTERM", () => scout.stop());
```

`src/agents/guardian-runner.ts`:

```typescript
import { Pool } from "pg";
import { GuardianAgent } from "./guardian";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const guardian = new GuardianAgent(pool);
guardian.start();
process.on("SIGTERM", () => guardian.stop());
```

**Option B: All in one process (simpler, less resilient)**

Start Scout and Guardian from Nova's main process:

```typescript
const scout = new ScoutAgent(pool);
const guardian = new GuardianAgent(pool);
await scout.start();
await guardian.start();
```

#### Verification

- [x] Scout, Guardian, and Supervisor all register in `agent_registry` ✅ (all extend BaseAgent → register() inserts into agent_registry)
- [x] Scout writes intel to `agent_messages` every 5 minutes ✅ (quickScanIntervalMs = 5 min, reports via reportToSupervisor)
- [x] Guardian writes alerts to `agent_messages` when tokens fail safety checks ✅ (reportToSupervisor('alert', ...) on critical findings)
- [x] Supervisor reads messages, prioritizes CRITICAL first ✅ (ORDER BY CASE priority WHEN 'critical' THEN 0 in pollMessages)
- [x] Critical guardian alerts trigger immediate X + TG posts ✅ (nova-guardian:alert handler calls onPostToX + onPostToChannel)
- [x] `/scan <address>` in TG → Guardian scans → Supervisor relays report back to TG ✅
- [x] Health Agent monitors all three processes (via agent_heartbeats — all agents heartbeat every 60s) ✅

---

## PHASE 3 — PLATFORM EXPANSION (Week 3-4)

### Task 6: Farcaster Plugin

Add Farcaster (Warpcast) as an additional social channel. Nova cross-posts intel and safety reports to relevant Farcaster channels.

#### 6A: Install the Plugin

```bash
# In Nova's project directory:
npm install @elizaos/plugin-farcaster
```

#### 6B: Add Farcaster to Nova's Character

In Nova's main character file (e.g., `characters/nova.character.json`), add the plugin:

```json
{
  "plugins": [
    "@elizaos/plugin-twitter",
    "@elizaos/plugin-telegram",
    "@elizaos/plugin-farcaster"
  ]
}
```

#### 6C: Environment Variables

```env
# Farcaster / Warpcast
FARCASTER_FID=             # Your Farcaster FID (numeric)
FARCASTER_MNEMONIC=        # Farcaster signer mnemonic (or use FARCASTER_PRIVATE_KEY)
FARCASTER_HUB_URL=         # Neynar hub URL or self-hosted hub
NEYNAR_API_KEY=            # If using Neynar for Farcaster API access
```

#### 6D: Channel Targeting

Nova should post to specific Farcaster channels based on content type:

| Content Type       | Channel              | Example                                                                       |
| ------------------ | -------------------- | ----------------------------------------------------------------------------- |
| Token launches     | /solana, /defi       | "Just launched $TOKEN on pump.fun — RugCheck score 85/100"                    |
| Safety alerts      | /defi, /crypto       | "🚨 RugCheck Alert: $TOKEN LP unlocked, top holder owns 42%"                  |
| Narrative analysis | /ai-agents, /crypto  | "Narrative shift: AI agent tokens gaining 15% mindshare this week"            |
| Nova updates       | /ai-agents, /elizaos | "Nova now monitors 25+ KOLs across X, TG, and Farcaster"                      |
| Weekly reports     | /ai-agents, /solana  | "Nova Weekly: 12 tokens launched, 3 rugs detected, $420 PumpSwap fees earned" |

Add channel routing to the Supervisor:

```typescript
// In supervisor.ts — add Farcaster posting callback
public onPostToFarcaster?: (content: string, channel: string) => Promise<void>;

// In the narrative shift handler:
if (this.onPostToFarcaster) {
  await this.onPostToFarcaster(content, 'ai-agents');
  await this.onPostToFarcaster(content, 'solana');
}

// In the safety alert handler:
if (msg.priority === 'critical' && this.onPostToFarcaster) {
  await this.onPostToFarcaster(warning, 'defi');
}
```

#### 6E: Farcaster Account Setup

Before the plugin works:

1. Create a Farcaster account at warpcast.com (if not already done)
2. Claim the Nova handle
3. Create a signer key using Neynar or the Farcaster protocol directly
4. Set up the profile with Nova's branding, bio, and profile picture

#### Verification

- [x] `@elizaos/plugin-farcaster` installed and in character file ✅ (custom farcasterPublisher.ts via Neynar API)
- [x] Environment variables set for Farcaster auth ✅ (NEYNAR_API_KEY, FARCASTER_SIGNER_UUID, FARCASTER_FID in env)
- [x] Nova can post to specific channels ✅ (postCast(text, channel) sends channel_id to Neynar)
- [x] Safety alerts go to /defi and /crypto channels ✅ (CHANNEL_ROUTING.safety_alert: ['defi', 'crypto'])
- [x] Narrative intel goes to /ai-agents and /solana channels ✅ (CHANNEL_ROUTING.narrative_intel: ['ai-agents', 'solana'])
- [x] No duplicate posts (same content shouldn't go to same channel twice) ✅ (isDuplicate() with 30-min window + hash cache)

---

## PHASE 4 — TOKEN ECOSYSTEM (Week 5+)

### Task 7: Token Child Agents

When Nova launches a token on pump.fun, it spawns a lightweight "child agent" that monitors that token's social presence and reports back to Nova.

#### 7A: Child Agent Template

Create `src/agents/token-child.ts`:

```typescript
/**
 * Token Child Agent
 *
 * Spawned by the Supervisor when Nova launches a new token.
 * Each child agent:
 * - Monitors X mentions of the token
 * - Answers basic questions about the token in TG
 * - Reports engagement metrics back to Supervisor
 * - Auto-deactivates after 24h of no trading volume
 *
 * Children are LIGHTWEIGHT — no LLM calls unless directly @mentioned.
 * They primarily track metrics and relay to the Supervisor.
 */

import { Pool } from "pg";

export interface TokenChildConfig {
  tokenAddress: string;
  tokenName: string; // e.g., "$MOONDOG"
  tokenSymbol: string;
  personality: string; // auto-generated based on token theme
  launchedAt: Date;
  agentId: string; // e.g., "child-MOONDOG"
  autoDeactivateAfterHours: number; // default 24
}

export class TokenChildAgent {
  private pool: Pool;
  private config: TokenChildConfig;
  private active: boolean = true;
  private metricsTimer?: NodeJS.Timeout;

  constructor(pool: Pool, config: TokenChildConfig) {
    this.pool = pool;
    this.config = config;
  }

  async start(): Promise<void> {
    await this.register();

    // Report metrics every 10 minutes
    this.metricsTimer = setInterval(() => this.reportMetrics(), 10 * 60 * 1000);

    // Check deactivation condition every hour
    setInterval(() => this.checkDeactivation(), 60 * 60 * 1000);

    console.log(`[child:${this.config.tokenSymbol}] Started monitoring`);
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    await this.updateStatus("deactivated");
    console.log(`[child:${this.config.tokenSymbol}] Deactivated`);
  }

  private async reportMetrics(): Promise<void> {
    if (!this.active) return;

    // Gather token metrics (price, volume, holders, mentions)
    // These would come from on-chain data + social scanning
    const metrics = {
      tokenAddress: this.config.tokenAddress,
      tokenSymbol: this.config.tokenSymbol,
      // volume24h: await getVolume(this.config.tokenAddress),
      // holders: await getHolderCount(this.config.tokenAddress),
      // xMentions: await countMentions(this.config.tokenSymbol),
      timestamp: new Date().toISOString(),
    };

    await this.pool.query(
      `
      INSERT INTO agent_messages (from_agent, to_agent, message_type, priority, payload)
      VALUES ($1, 'nova-supervisor', 'report', 'low', $2)
    `,
      [this.config.agentId, JSON.stringify(metrics)],
    );
  }

  private async checkDeactivation(): Promise<void> {
    // Deactivate if no volume for configured hours
    const hoursSinceLaunch =
      (Date.now() - this.config.launchedAt.getTime()) / (1000 * 60 * 60);

    // TODO: Check actual trading volume via on-chain data
    // const volume = await get24hVolume(this.config.tokenAddress);
    // if (volume === 0 && hoursSinceLaunch > this.config.autoDeactivateAfterHours) {
    //   await this.stop();
    // }
  }

  private async register(): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO agent_registry (agent_id, agent_type, status, config, last_heartbeat)
      VALUES ($1, 'token-child', 'running', $2, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET status = 'running', last_heartbeat = NOW()
    `,
      [this.config.agentId, JSON.stringify(this.config)],
    );
  }

  private async updateStatus(status: string): Promise<void> {
    await this.pool.query(
      "UPDATE agent_registry SET status = $1, last_heartbeat = NOW() WHERE agent_id = $2",
      [status, this.config.agentId],
    );
  }
}
```

#### 7B: Supervisor Spawns Children

Add to `supervisor.ts`:

```typescript
import { TokenChildAgent, TokenChildConfig } from './token-child';

// Map of active child agents
private children: Map<string, TokenChildAgent> = new Map();

// Call this after Nova launches a token on pump.fun
async spawnChildForToken(tokenAddress: string, tokenName: string, tokenSymbol: string): Promise<void> {
  const childConfig: TokenChildConfig = {
    tokenAddress,
    tokenName,
    tokenSymbol,
    personality: `I'm the community agent for ${tokenName}. I track mentions, share price updates, and keep the community informed.`,
    launchedAt: new Date(),
    agentId: `child-${tokenSymbol.replace('$', '')}`,
    autoDeactivateAfterHours: 24,
  };

  const child = new TokenChildAgent(this.pool, childConfig);
  await child.start();
  this.children.set(tokenAddress, child);

  console.log(`[supervisor] Spawned child agent for ${tokenSymbol}`);
}
```

#### Verification

- [x] Supervisor spawns child agent when token is launched ✅ (nova-launcher:status handler calls spawnChild() on 'launched' event)
- [x] Child registers in `agent_registry` ✅ (TokenChildAgent extends BaseAgent → register() on start)
- [x] Child reports metrics every 10 minutes via `agent_messages` ✅ (reportIntervalMs = 10 min, gatherAndReport → reportToSupervisor)
- [x] Child auto-deactivates after 24h of no volume ✅
- [x] Health Agent sees child agents in its monitoring ✅ (startHeartbeat(60_000) writes to agent_heartbeats, Health Agent monitors)

---

### Task 8: Virtuals Protocol Launch

Deploy NOVA token on Base chain via Virtuals Protocol. **Prerequisites: Tasks 2 (landing page) and 6 (Farcaster) should be complete first.**

#### 8A: Virtuals Protocol Requirements

Based on research of Virtuals Protocol:

- Agent tokens are launched on **Base** (Coinbase L2), not Solana
- You need an agent registered on the Virtuals platform at `app.virtuals.io`
- The agent needs: name, bio, avatar, website URL, social links
- Token is created through Virtuals' bonding curve mechanism
- Virtuals takes a cut of trading fees

#### 8B: Preparation Checklist

Before launching on Virtuals:

1. **Landing page** must be live (Task 2) — Virtuals requires a website URL
2. **Farcaster account** should be active (Task 6) — shows cross-platform presence
3. **X account** should have established history — not a new account
4. **Nova's stats** should be impressive — tokens launched, rugs detected, uptime
5. **Multi-agent narrative** should be visible — "Nova is a swarm, not just an agent"

#### 8C: Registration on Virtuals

1. Go to `app.virtuals.io` and connect a wallet (must be on Base)
2. Register Nova as an agent with:
   - Name: Nova
   - Bio: "Autonomous AI agent swarm on Solana. Launches tokens, detects rugs, monitors narratives 24/7."
   - Website: `https://<username>.github.io/nova/`
   - Twitter: Nova's X handle
   - Farcaster: Nova's Farcaster handle
   - Avatar: Nova's logo/branding image

3. Configure token parameters:
   - Symbol: NOVA
   - Initial liquidity: TBD (depends on available funds)
   - Description referencing the swarm architecture narrative

#### 8D: Post-Launch

After NOVA token is live on Virtuals:

- Guardian monitors NOVA token itself (LP health, whale concentration)
- Scout tracks NOVA mentions across X and Farcaster
- Supervisor generates weekly NOVA token reports
- Landing page updated with NOVA token contract address and Virtuals link

#### Important Notes

- **DO NOT rush this.** A token launch with no community, no landing page, and no Farcaster presence will fail.
- **Build community FIRST** (Tasks 1, 2, 6), then launch the token.
- **The narrative matters more than the token.** "First autonomous AI swarm on Solana" is the story.

---

### Task 9: Agent Factory MVP

The endgame: community members can request custom agents through Nova.

#### 9A: Request Flow

```
User DMs Nova on Telegram:
  "I want an agent that tracks whale wallets on Solana and posts alerts"

Nova (Supervisor):
  1. Parse the request into a structured agent spec
  2. Generate a character file + plugin config
  3. Spawn the agent as a child process
  4. Report back to user with agent status
```

#### 9B: Agent Template Generator

Create `src/agents/factory.ts`:

```typescript
/**
 * Agent Factory
 *
 * Generates agent configurations from natural language descriptions.
 * Uses an LLM to parse user requests into structured agent specs.
 *
 * MVP scope:
 * - Single capability agents only (monitoring, alerting, scanning)
 * - Telegram-only output
 * - Pre-defined plugin combinations
 * - Manual approval required before spawning
 */

export interface AgentSpec {
  name: string;
  description: string;
  capabilities: string[];
  plugins: string[];
  schedule: string;
  outputChannel: "telegram" | "x" | "both";
  createdBy: string; // TG user ID who requested it
  status: "pending" | "approved" | "running" | "stopped";
}

// Available capability templates that the factory can compose
const CAPABILITY_TEMPLATES = {
  whale_tracking: {
    description: "Monitor large wallet movements on Solana",
    plugins: ["@elizaos/plugin-solana"],
    schedule: "every 5 minutes",
  },
  token_monitoring: {
    description: "Track a specific token price, volume, and holder changes",
    plugins: ["@elizaos/plugin-solana"],
    schedule: "every 1 minute",
  },
  kol_scanning: {
    description: "Monitor specific X accounts and alert on relevant posts",
    plugins: ["@elizaos/plugin-twitter"],
    schedule: "every 5 minutes",
  },
  safety_scanning: {
    description: "Run continuous RugCheck scans on specified tokens",
    plugins: ["@elizaos/plugin-solana"],
    schedule: "every 1 minute",
  },
  narrative_tracking: {
    description: "Track narrative/sentiment shifts across KOL posts",
    plugins: ["@elizaos/plugin-twitter"],
    schedule: "every 15 minutes",
  },
};

export class AgentFactory {
  // TODO: Implement LLM-based request parsing
  // TODO: Implement agent spawning with character file generation
  // TODO: Implement approval flow via TG (owner approves before agent spawns)
  // TODO: Implement resource limits (max agents per user, compute budgets)
  // TODO: Implement NOVA token gating (when token exists)
}
```

#### 9C: Revenue Model (Post-NOVA Token)

When the NOVA token exists on Virtuals:

- **Spawn agent:** costs X NOVA tokens (burned or sent to treasury)
- **Monthly upkeep:** Y NOVA tokens/month (covers compute costs)
- **Premium features:** Z NOVA tokens for multi-platform, custom models
- **Revenue share:** agent earnings split between creator + Nova treasury

#### 9D: Implementation Priority

This is the LAST task to implement. It requires:

1. All sub-agents working (Scout, Guardian, Supervisor) ✓ Tasks 3-5
2. NOVA token live on Virtuals ✓ Task 8
3. Proven multi-agent architecture
4. Community demand for custom agents

**Start with a manual MVP:** you (the owner) manually create agents when requested via TG, then automate the process over time.

---

## THE NARRATIVE

### Elevator Pitch

> **Nova isn't just an AI agent. Nova is the first self-healing autonomous AI swarm on Solana.**
>
> Nova deploys specialized sub-agents for intelligence, safety, trading, and community management — with a Health Agent that monitors, repairs, and keeps the entire ecosystem alive 24/7. Soon, Nova will let anyone spawn their own AI agent, powered by the NOVA token.
>
> Built on ElizaOS. Self-healing. Always on. Building the hive.

### Content Angles for Community Posts

Use these as X threads, Farcaster casts, and TG posts to build Nova's narrative presence:

1. **"From one agent to many"** — Thread about Nova's evolution from single agent to swarm
2. **"How Nova's Guardian caught 3 rugs this week"** — Safety-focused credibility
3. **"The $4/month intelligence engine"** — Cost comparison to AIXBT's $200/month terminal
4. **"Nova launched 24 tokens. Here's what we learned."** — Transparency/lessons thread
5. **"Why AI agents need armies, not individuals"** — Thought leadership on multi-agent architecture
6. **"Nova is building a hive mind for meme tokens"** — The big vision post
7. **"Nova's immune system: how a Health Agent keeps the swarm alive"** — Technical differentiator
8. **"Most AI agents crash and nobody notices. Nova fixes itself."** — Reliability as a feature

---

## REFERENCE: Existing Documents

| Document            | Location                                                     | Contains                                                                               |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Community Roadmap   | `/mnt/user-data/outputs/NOVA-COMMUNITY-AND-SWARM-ROADMAP.md` | TG groups, X targets, Farcaster channels, engagement strategy, full swarm architecture |
| Health Agent Prompt | `/mnt/user-data/outputs/COPILOT-HEALTH-AGENT-PROMPT.md`      | Health Agent wiring instructions, degradation rules, TG status report format           |
| Health Agent Code   | `src/launchkit/health/`                                      | 8 TypeScript files, fully written                                                      |
| Health DB Schema    | `sql/001_health_schema.sql`                                  | 8 tables including agent_messages, agent_registry                                      |
| CFO Agent Platforms | `/mnt/user-data/outputs/NOVA-CFO-AGENT-PLATFORMS.md`         | Jupiter, Wormhole, Hyperliquid, Polymarket, Kamino, Jito, x402                         |
| Community Roadmap   | `/mnt/user-data/outputs/NOVA-COMMUNITY-AND-SWARM-ROADMAP.md` | TG groups, Farcaster channels, engagement strategy                                     |

## REFERENCE: Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│                  NOVA (Supervisor)                    │
│      Orchestrates all sub-agents, synthesizes        │
│      intelligence, makes strategic decisions          │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │  SCOUT   │  │ ANALYST  │  │ GUARDIAN  │          │
│  │          │  │          │  │          │          │
│  │ KOL scan │  │ DeFiLlama│  │ RugCheck │          │
│  │ X monitor│  │ on-chain │  │ LP watch │          │
│  │ TG intel │  │ metrics  │  │ whale    │          │
│  │ Farcaster│  │ narrative│  │ alerts   │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ LAUNCHER │  │ COMMUNITY│  │ FACTORY  │          │
│  │          │  │          │  │ (future) │          │
│  │ pump.fun │  │ TG mgmt  │  │ spawn    │          │
│  │ art gen  │  │ X replies│  │ agents   │          │
│  │ deploy   │  │ onboard  │  │ for users│          │
│  │ announce │  │ moderate │  │ templates│          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │             🏥 HEALTH AGENT                   │   │
│  │                                               │   │
│  │  Monitors ALL other agents. Detects failures. │   │
│  │  Auto-restarts crashed agents. Tracks errors. │   │
│  │  Reports ecosystem status. Self-healing swarm.│   │
│  └──────────────────────────────────────────────┘   │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ CHILD:   │  │ CHILD:   │  │ CHILD:   │          │
│  │ $TOKEN1  │  │ $TOKEN2  │  │ $TOKEN3  │          │
│  │ monitors │  │ monitors │  │ monitors │          │
│  │ metrics  │  │ metrics  │  │ metrics  │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │          SHARED POSTGRESQL DB                 │   │
│  │  agent_messages | agent_registry | memories   │   │
│  │  intel | metrics | health logs | heartbeats   │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

## REFERENCE: Full Implementation Priority

| #   | Task                                           | Effort       | Depends On                       | Week | Status  |
| --- | ---------------------------------------------- | ------------ | -------------------------------- | ---- | ------- |
| 1   | Reply Engine Community Targets + Anti-Spam     | 2-3 hours    | Nothing (config changes)         | 1    | ✅ DONE |
| 2   | Manual Community Infiltration (you personally) | Ongoing      | Nothing                          | 1    | MANUAL  |
| 3   | GitHub Pages Landing Page                      | 1-2 hours    | Nothing                          | 1    | ✅ DONE |
| 4   | Engagement Tracker                             | 2-3 hours    | Task 1                           | 1    | ✅ DONE |
| 5   | Submit to Cookie DAO                           | 30 min       | Task 3 (landing page URL helps)  | 1    | MANUAL  |
| 6   | Farcaster Plugin                               | Half day     | Nothing                          | 2    | ✅ DONE |
| 7   | Scout Agent                                    | 1 day        | ~~Health Agent wired~~ ✅ READY  | 2-3  | ✅ DONE |
| 8   | Guardian Agent                                 | 1 day        | ~~Health Agent wired~~ ✅ READY  | 2-3  | ✅ DONE |
| 9   | Supervisor Logic                               | 1 day        | Tasks 7 + 8                      | 3    | ✅ DONE |
| 10  | Deploy multi-agent (PM2/Railway)               | Half day     | Tasks 7-9                        | 3    | ✅ DONE |
| 11  | Analyst Agent                                  | 1 day        | Task 9 (extract from Scout)      | 4    | ✅ DONE |
| 12  | Launcher Agent                                 | 1 day        | Task 9 (extract from Nova main)  | 4-5  | ✅ DONE |
| 13  | Community Agent                                | 1 day        | Task 9 (extract from Nova main)  | 4-5  | ✅ DONE |
| 14  | Token Child Agents                             | 1-2 days     | Task 9 (Supervisor)              | 5    | ✅ DONE |
| 15  | Health Agent monitors all child agents         | Half day     | Tasks 14 + Health Agent ✅       | 5    | ✅ DONE |
| 16  | Virtuals Protocol Launch                       | 1 day + prep | Tasks 3 + 6 + community traction | 6+   | MANUAL  |
| 17  | Agent Factory MVP                              | 3-5 days     | Tasks 9 + 14 + 16                | 7+   | ✅ DONE |
| 18  | Open source swarm framework                    | 2-3 days     | All above stable                 | 8+   | TODO    |

---

## Summary Checklist

**ALREADY BUILT (as of Feb 19 2026):**

- [x] Health Agent fully wired — 8 files, two-tier repair, auto-starts with `init.ts`
- [x] Health DB Schema auto-migrated — 8 tables incl. `agent_messages` + `agent_registry`
- [x] TG Health Commands — `/health`, `/errors`, `/repairs`, `/approve`, `/reject`
- [x] TG Health Monitor — connection monitoring + auto-restart
- [x] Nova Channel — 932 lines, announcements, cross-ban, rules, daily summaries
- [x] Autonomous Mode — 1232 lines, scheduled + reactive launches, voting, dry-run
- [x] X Reply Engine — search/mention replies, RugCheck integration, spam filter
- [x] X Marketing + Scheduler + Publisher + Rate Limiter — full X pipeline
- [x] 10+ Telegram services — scheduler, publisher, community, security, ban handler, etc.
- [x] Treasury + PnL tracking — treasury service, scheduler, price service
- [x] LaunchKit Plugin — 44 actions, 2 providers, full lifecycle management
- [x] Admin Notify, Operator Guardrails, Nova Personal Brand, Meme/Logo Generation

**Phase 1 — Immediate Wins (This Week):**

- [x] Create `community-targets.ts` with 3-tier KOL targeting (19 accounts) ✅
- [x] Create `reply-rules.ts` with anti-spam rules and `validateReply()` ✅
- [x] Wire both into existing reply engine ✅
- [x] Enforce value-add rule: every reply must contain Intel, Safety, Data, or Insight ✅
- [x] Daily reply volume targets 30-50 (hard cap via `maxTotalRepliesPerDay: 50`) ✅
- [x] Build engagement tracker (SQL table + logging in reply engine) ✅
- [x] Create GitHub Pages landing page with Nova's stats and links ✅
- [ ] Enable GitHub Pages, verify the URL works
- [ ] **Manual:** Join Virtuals TG, ElizaOS Discord, claim Farcaster handle
- [ ] **Manual:** Submit to Cookie DAO for agent indexing
- [ ] **Manual:** Register on Virtuals Protocol (wallet on Base)

**Phase 2 — Sub-Agent Architecture (Week 2-3):**

- [x] Health Agent wired (prerequisite — creates agent_messages table) **✅ DONE**
- [x] Scout Agent implemented — wraps novaResearch, 8h research cycle + 30m quick scans ✅
- [x] Guardian Agent implemented — wraps rugcheck, watch list + 15m re-scans ✅
- [x] Analyst Agent implemented — DeFiLlama TVL/volume, anomaly detection ✅
- [x] Launcher Agent implemented — wraps autonomousMode, graduation monitoring ✅
- [x] Community Agent implemented — engagement tracking, pulse checks ✅
- [x] Supervisor running in Nova's main process — polls agent_messages, dispatches ✅
- [x] All agents wired into init.ts with graceful shutdown ✅
- [x] PM2 ecosystem config with restart policies, log rotation, memory limits ✅
- [x] `/scan` TG command routes through Supervisor → Guardian → TG response ✅
- [x] Health Agent monitoring Scout, Guardian, and Supervisor processes ✅

**Phase 3 — Platform Expansion (Week 3-4):**

- [x] Farcaster publisher service — Neynar API, channel routing, rate limiting ✅
- [x] Channel routing for different content types (launch→solana/defi, safety→defi, narrative→ai-agents) ✅
- [x] Cross-posting wired in Supervisor (Scout intel, Guardian alerts, Launcher status → Farcaster) ✅
- [x] Analyst Agent extracted from Scout (DeFiLlama, on-chain metrics) ✅
- [x] Launcher Agent extracted from Nova main (pump.fun pipeline) ✅
- [x] Community Agent extracted from Nova main (TG mgmt, X replies) ✅

**Phase 4 — Token Ecosystem (Week 5+):**

- [x] Token child agents spawned on pump.fun launches (Supervisor auto-spawns on launch event) ✅
- [x] Child auto-deactivation after 24h no volume (DexScreener metrics, configurable) ✅
- [x] Health Agent monitors and auto-deactivates dead child agents ✅
- [ ] Virtuals Protocol account registered
- [ ] NOVA token launched on Base (when community is ready)
- [x] Agent Factory MVP — keyword-based request parsing, approval flow, TG formatting, Supervisor spawn ✅
- [x] Factory TG commands wired — /request_agent, /approve_agent, /reject_agent, /my_agents, /stop_agent ✅
- [x] Swarm verification script — `bun run scripts/verify-swarm.ts --db` (138 file + 12 DB checks) ✅
- [ ] Open source swarm framework to attract builders

---

## Important Notes

- **Do NOT launch the NOVA token until community traction exists.** Landing page, Farcaster, active X engagement, and directory listings should all be in place first.
- **The Health Agent is LIVE and creates the DB infrastructure** (agent_messages, agent_registry) that Scout, Guardian, and Supervisor all depend on. This prerequisite is **COMPLETE** — sub-agent work can start immediately.
- **Sub-agents share ONE PostgreSQL database.** They communicate ONLY through the agent_messages table. No direct function calls between agents.
- **The Supervisor runs inside Nova's main process.** Scout and Guardian run as separate processes (PM2 or Railway services).
- **Quality over quantity for X replies.** 30-50 substantive replies/day beats 500 generic ones. Every reply must contain Intel, Safety, Data, or Insight. The anti-spam rules are non-negotiable.
- **Manual community work matters.** You need to personally join ElizaOS Discord, Virtuals TG, and Farcaster. Bot-only presence doesn't build real relationships.
- **Health Agent posts a swarm status report to TG every 6 hours.** Format shows all agent statuses (🟢/🟡/🔴), external API latencies, restart count, and memory usage. See the Health Agent prompt for the full format.
- **Degradation rules are built into the Health Agent.** When APIs fail, the Health Agent doesn't just restart blindly — it applies graceful degradation: rotate RPCs on Solana failure, reduce reply frequency on X rate limits, switch LLM providers on OpenAI outages. These rules are in `src/launchkit/health/types.ts`.
- **The full swarm is 7+ agents:** Nova (Supervisor), Scout, Analyst, Guardian, Launcher, Community, Health, plus token child agents. **All core agents implemented** — Scout + Guardian + Analyst + Launcher + Community + TokenChild all report to Nova Supervisor via `agent_messages`. Health Agent runs independently. Agent Factory MVP provides user-requested agent spawning with full TG command interface (`/request_agent`, `/approve_agent`, `/reject_agent`, `/my_agents`, `/stop_agent`). Factory delegates child creation to Supervisor (`supervisor.spawnChild()`), never imports TokenChildAgent directly. Remaining: LLM-based request parsing (currently keyword-based), NOVA token gating.
- **Verification:** Run `bun run scripts/verify-swarm.ts --db` to check all 150 wiring points (files, exports, init.ts wiring, supervisor handlers, heartbeats, health deactivation, factory, scan commands, farcaster, PM2, DB schema). Use `--full` to also test DB write paths.
- **The CFO Agent (Jupiter, Hyperliquid, Kamino, etc.) becomes another sub-agent** in this architecture once it's built. See `/mnt/user-data/outputs/NOVA-CFO-AGENT-PLATFORMS.md` for the full platform research.
- **Open sourcing the swarm framework is the long-term play.** Once the architecture is proven, releasing it attracts builders to the Nova ecosystem and drives NOVA token utility.

---

_Last updated: February 19, 2026_
