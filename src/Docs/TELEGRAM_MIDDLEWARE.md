# Telegram Middleware & User Caching

## Overview

This document explains how Nova hooks into ElizaOS's Telegram plugin to cache user IDs and enable moderation features like `/ban` and `/kick`.

## The Problem

ElizaOS's `@elizaos/plugin-telegram` uses Telegraf for Telegram bot handling. By default, ElizaOS doesn't expose the raw Telegram `user_id` to actions and providers - it only provides the ElizaOS `entityId`.

This causes issues for:

- **Moderation**: Can't ban users by username lookup (need `user_id`)
- **Scam Detection**: Can't kick spammers without their `user_id`
- **Context**: Providers can't identify who sent a message

## The Solution: Patching `messageManager.handleMessage`

### Why `bot.use()` Doesn't Work

Telegraf middleware added via `bot.use()` AFTER `bot.launch()` is ignored. The middleware chain is "frozen" when polling starts.

```typescript
// ❌ This DOESN'T work - added after bot.launch()
bot.use(myMiddleware); // Never fires!
bot.on("message", handler); // Never fires!
```

ElizaOS calls `bot.launch()` during service initialization, before we get access to the bot instance.

### The Working Approach

Instead of adding middleware, we **patch the `handleMessage` method** that ElizaOS calls for every message:

```typescript
// ✅ This WORKS - wrapping the function that's already being called
const originalHandleMessage = messageManager.handleMessage.bind(messageManager);

messageManager.handleMessage = async (ctx: Context) => {
  // Cache user BEFORE ElizaOS processes
  const message = ctx.message;
  if (message?.from && message?.chat?.id) {
    cacheTelegramUser(
      String(message.chat.id),
      {
        id: message.from.id,
        username: message.from.username,
        firstName: message.from.first_name,
        lastName: message.from.last_name,
      },
      message.message_id,
    );
  }

  // Call original handler
  return originalHandleMessage(ctx);
};
```

## How It Works

### 1. Service Registration (init.ts)

```typescript
// Wait for Telegram service to initialize (5 seconds)
setTimeout(async () => {
  await registerBanCommands(runtime);
}, 5000);
```

### 2. Hook into ElizaOS (telegramBanHandler.ts)

```typescript
const telegramService = runtime.getService("telegram");
const bot = telegramService.messageManager?.bot;
const messageManager = telegramService.messageManager;

// Patch handleMessage
const original = messageManager.handleMessage.bind(messageManager);
messageManager.handleMessage = async (ctx) => {
  cacheUser(ctx); // Our logic
  return original(ctx); // Original logic
};
```

### 3. User Caching (telegramCommunity.ts)

```typescript
// In-memory cache: chatId -> username -> { id, username, firstName, ... }
const userCache = new Map<string, Map<string, CachedUser>>();

export function cacheTelegramUser(
  chatId: string,
  user: TelegramUser,
  messageId?: number,
);
export function lookupTelegramUser(
  chatId: string,
  usernameOrId: string,
): CachedUser | null;
```

## Usage

### Ban by Reply

```
1. User posts spam
2. Admin replies with /ban
3. Handler gets user_id from reply_to_message.from.id
4. User is banned
```

### Ban by Username

```
1. Spammer @scammer posts message (gets cached)
2. Admin types /ban @scammer
3. Handler looks up cached user_id for @scammer
4. User is banned
```

### Automatic Scam Detection

```
1. User posts wallet screenshot (detected as scam)
2. detectScam() triggers KICK_SPAMMER action
3. Action looks up user_id from cache
4. User is kicked
```

## Files Involved

| File                    | Purpose                                               |
| ----------------------- | ----------------------------------------------------- |
| `telegramBanHandler.ts` | Patches messageManager, registers /ban /kick commands |
| `telegramCommunity.ts`  | User cache storage and lookup functions               |
| `init.ts`               | Calls registerBanCommands after delay                 |

## Debugging

Check logs for:

```
[BAN_HANDLER] 🔌 Hooking into ElizaOS Telegraf instance...
[BAN_HANDLER] ✅ Patched messageManager.handleMessage for user caching
[BAN_HANDLER] 📥 Cached user: 123456 (@username) in chat -1001234567890
```

If you don't see `📥 Cached user` when messages arrive:

1. Check the patch succeeded
2. Verify Telegram service is running
3. Check if bot is admin in the group

## Key Insight

> **The middleware chain in Telegraf is immutable after `launch()`.**
> To intercept messages, you must either:
>
> 1. Add middleware BEFORE `bot.launch()` (requires patching ElizaOS)
> 2. Wrap the handler function that processes messages (our approach)

This pattern can be used for any post-launch message interception in ElizaOS Telegram bots.
