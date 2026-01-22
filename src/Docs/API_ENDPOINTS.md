# LaunchKit API Documentation (Base URL: `http://localhost:8787`)

Complete REST API reference for the LaunchKit token launch system.

---

## Base Information

- **Base URL**: `http://localhost:8787`
- **Version**: `v1`
- **Authentication**: `x-admin-token` header (see below)
- **Content-Type**: `application/json`
- **Response Format**: All responses follow the pattern:
  ```json
  {
    "data": { ... },  // Success responses
    "error": { ... }  // Error responses
  }
  ```

---

## Authentication

All authenticated endpoints require the `x-admin-token` header:

```bash
curl -H "x-admin-token: YOUR_ADMIN_TOKEN" http://localhost:8787/v1/launchpacks
```

### Token Priority

The server uses tokens in this order (first found wins):

1. `LAUNCHKIT_ADMIN_TOKEN` environment variable
2. `ADMIN_TOKEN` environment variable

**Important:** If both are set, `LAUNCHKIT_ADMIN_TOKEN` takes priority.

### Example `.env`

```bash
LAUNCHKIT_ADMIN_TOKEN=7d9f4a2b1c6e8f0d3a5c9e1b4f7a0d2c8b6e1f3a9d5c2e7b0a4f8c1d6e3b9a0f
```

---

## Health Check

### `GET /health`

Check if the API server is running.

**Authentication**: None required

**Response**: `200 OK`

```json
{
  "status": "ok",
  "timestamp": "2026-01-12T10:30:00.000Z"
}
```

---

## LaunchPacks

### 1. List All LaunchPacks

**`GET /v1/launchpacks`**

Retrieve all LaunchPacks in the system, ordered by creation date (newest first).

**Authentication**: Required

**Query Parameters**: None

**Response**: `200 OK`

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "brand": {
        "name": "MoonDog",
        "ticker": "MOON",
        "tagline": "To the moon!",
        "description": "The ultimate moon token",
        "lore": "Born from memes..."
      },
      "assets": {
        "logo_url": "https://api.dicebear.com/7.x/shapes/png?seed=MoonDog&size=400",
        "banner_url": "https://example.com/banner.png",
        "memes": [
          {
            "url": "https://example.com/meme1.jpg",
            "caption": "When MOON hits $1"
          }
        ]
      },
      "links": {
        "website": "https://moondogcoin.com",
        "x": "https://x.com/moondogcoin",
        "telegram": "https://t.me/moondogofficial"
      },
      "tg": {
        "chat_id": "-1001234567890",
        "pins": {
          "welcome": "Welcome to MoonDog!",
          "how_to_buy": "Buy on pump.fun",
          "memekit": "Check out our memes"
        },
        "schedule": []
      },
      "x": {
        "main_post": "🚀 $MOON is launching!",
        "thread": ["Thread tweet 1", "Thread tweet 2"],
        "reply_bank": ["LFG! 🚀", "To the moon!"],
        "schedule": []
      },
      "launch": {
        "status": "success",
        "mint": "ABC123...DEF456",
        "tx_signature": "sig123...sig456",
        "pump_url": "https://pump.fun/ABC123...DEF456",
        "requested_at": "2026-01-12T10:00:00.000Z",
        "completed_at": "2026-01-12T10:01:30.000Z",
        "launched_at": "2026-01-12T10:01:30.000Z"
      },
      "ops": {
        "checklist": {
          "copy_ready": true,
          "tg_ready": true,
          "x_ready": true,
          "launch_ready": true
        },
        "tg_published_at": "2026-01-12T10:02:00.000Z",
        "tg_publish_status": "published",
        "tg_message_ids": ["123", "456"],
        "x_published_at": "2026-01-12T10:02:30.000Z",
        "x_publish_status": "published",
        "x_post_ids": ["789"],
        "audit_log": [
          {
            "at": "2026-01-12T10:00:00.000Z",
            "message": "LaunchPack created",
            "actor": "system"
          }
        ]
      },
      "created_at": "2026-01-12T09:00:00.000Z",
      "updated_at": "2026-01-12T10:02:30.000Z"
    }
  ]
}
```

**Error Responses**:

- `401 Unauthorized`: Missing or invalid authentication
- `500 Internal Server Error`: Database error

---

### 2. Create LaunchPack

**`POST /v1/launchpacks`**

Create a new LaunchPack.

**Authentication**: Required

**Request Body**:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",  // Optional, auto-generated if not provided
  "brand": {
    "name": "MoonDog",          // Required
    "ticker": "MOON",           // Required, max 12 chars, auto-uppercased
    "tagline": "To the moon!",  // Optional
    "description": "...",       // Optional
    "lore": "..."               // Optional
  },
  "assets": {
    "logo_url": "https://...",  // Optional, auto-generated if not provided
    "banner_url": "https://...", // Optional
    "memes": []                 // Optional
  },
  "links": {
    "website": "https://...",   // Optional
    "x": "https://x.com/...",   // Optional
    "telegram": "https://t.me/..." // Optional
  },
  "tg": {
    "chat_id": "-1001234567890", // Optional
    "pins": { ... },            // Optional
    "schedule": []              // Optional
  },
  "x": {
    "main_post": "...",         // Optional
    "thread": [],               // Optional
    "reply_bank": [],           // Optional
    "schedule": []              // Optional
  }
}
```

**Response**: `201 Created`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "brand": { ... },
    "created_at": "2026-01-12T10:00:00.000Z",
    "updated_at": "2026-01-12T10:00:00.000Z"
  }
}
```

**Error Responses**:

- `400 Bad Request`: Invalid payload (validation error)
- `401 Unauthorized`: Missing or invalid authentication

---

### 3. Get LaunchPack by ID

**`GET /v1/launchpacks/{id}`**

Retrieve a specific LaunchPack.

**Authentication**: Required

**Path Parameters**:

- `id` (UUID): LaunchPack ID

**Response**: `200 OK`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "brand": { ... },
    "assets": { ... },
    // ... full LaunchPack object
  }
}
```

**Error Responses**:

- `404 Not Found`: LaunchPack doesn't exist
- `401 Unauthorized`: Missing or invalid authentication

---

### 4. Update LaunchPack

**`PATCH /v1/launchpacks/{id}`**

Update an existing LaunchPack (partial update supported).

**Authentication**: Required

**Path Parameters**:

- `id` (UUID): LaunchPack ID

**Request Body** (all fields optional, deep merge):

```json
{
  "brand": {
    "tagline": "New tagline"
  },
  "links": {
    "website": "https://newsite.com"
  },
  "tg": {
    "chat_id": "-1001234567890"
  }
}
```

**Response**: `200 OK`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    // ... updated LaunchPack with merged changes
    "updated_at": "2026-01-12T10:30:00.000Z"
  }
}
```

**Error Responses**:

- `400 Bad Request`: Invalid payload
- `404 Not Found`: LaunchPack doesn't exist
- `401 Unauthorized`: Missing or invalid authentication

---

### 5. Generate Marketing Copy

**`POST /v1/launchpacks/{id}/generate`**

Generate marketing materials for a LaunchPack using AI.

**Authentication**: Required

**Path Parameters**:

- `id` (UUID): LaunchPack ID

**Request Body**:

```json
{
  "theme": "bullish", // Optional: "bullish", "meme", "serious"
  "keywords": ["moon", "rocket"], // Optional
  "tone": "casual" // Optional: "casual", "professional", "hype"
}
```

**Response**: `200 OK`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "brand": {
      "tagline": "Generated tagline",
      "description": "Generated description"
    },
    "tg": {
      "pins": {
        "welcome": "Generated welcome message",
        "how_to_buy": "Generated how to buy",
        "memekit": "Generated meme kit"
      }
    },
    "x": {
      "main_post": "Generated main post",
      "thread": ["Tweet 1", "Tweet 2", "Tweet 3"],
      "reply_bank": ["Reply 1", "Reply 2"]
    },
    "ops": {
      "checklist": {
        "copy_ready": true
      }
    }
  }
}
```

**Error Responses**:

- `404 Not Found`: LaunchPack doesn't exist
- `500 Internal Server Error`: Generation failed
- `401 Unauthorized`: Missing or invalid authentication

---

### 6. Launch Token on Pump.fun

**`POST /v1/launchpacks/{id}/launch`**

Deploy the token to pump.fun blockchain.

**Authentication**: Required

**Path Parameters**:

- `id` (UUID): LaunchPack ID

**Request Body**:

```json
{
  "force": false // Optional: Force relaunch even if already launched
}
```

**Response**: `200 OK`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "launch": {
      "status": "success",
      "mint": "ABC123...DEF456",
      "tx_signature": "sig123...sig456",
      "pump_url": "https://pump.fun/ABC123...DEF456",
      "requested_at": "2026-01-12T10:00:00.000Z",
      "completed_at": "2026-01-12T10:01:30.000Z",
      "launched_at": "2026-01-12T10:01:30.000Z"
    },
    "ops": {
      "checklist": {
        "launch_ready": true
      }
    }
  }
}
```

**Error Responses**:

- `404 Not Found`: LaunchPack doesn't exist
- `400 Bad Request`: Launch prerequisites not met
- `500 Internal Server Error`: Launch failed
- `401 Unauthorized`: Missing or invalid authentication

**Prerequisites**:

- LaunchPack must have:
  - `brand.name`
  - `brand.ticker`
  - `assets.logo_url` (auto-generated if missing)
- Pump wallet must have sufficient SOL (0.15-0.2 SOL)

---

### 7. Publish to Telegram

**`POST /v1/launchpacks/{id}/publish/telegram`**

Publish marketing materials to Telegram group.

**Authentication**: Required

**Path Parameters**:

- `id` (UUID): LaunchPack ID

**Request Body**:

```json
{
  "force": false // Optional: Force republish even if already published
}
```

**Response**: `200 OK`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "ops": {
      "tg_published_at": "2026-01-12T10:02:00.000Z",
      "tg_publish_status": "published",
      "tg_message_ids": ["123", "456", "789"]
    }
  }
}
```

**Error Responses**:

- `404 Not Found`: LaunchPack doesn't exist
- `400 Bad Request`: Prerequisites not met (no chat_id or TG not enabled)
- `500 Internal Server Error`: Publishing failed
- `401 Unauthorized`: Missing or invalid authentication

**Prerequisites**:

- `TG_ENABLE=true` in environment
- `TG_BOT_TOKEN` configured
- LaunchPack must have `tg.chat_id`
- LaunchPack must have `ops.checklist.tg_ready=true`

---

### 8. Publish to X/Twitter

**`POST /v1/launchpacks/{id}/publish/x`**

Publish marketing materials to X/Twitter.

**Authentication**: Required

**Path Parameters**:

- `id` (UUID): LaunchPack ID

**Request Body**:

```json
{
  "force": false // Optional: Force republish even if already published
}
```

**Response**: `200 OK`

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "ops": {
      "x_published_at": "2026-01-12T10:02:30.000Z",
      "x_publish_status": "published",
      "x_post_ids": ["789"]
    }
  }
}
```

**Error Responses**:

- `404 Not Found`: LaunchPack doesn't exist
- `400 Bad Request`: Prerequisites not met (X not enabled)
- `500 Internal Server Error`: Publishing failed
- `401 Unauthorized`: Missing or invalid authentication

**Prerequisites**:

- `X_ENABLE=true` in environment
- X API credentials configured
- LaunchPack must have `ops.checklist.x_ready=true`

---

### 9. Send Direct Tweet (Testing)

**`POST /v1/tweet`**

Send a tweet directly for testing purposes.

**Authentication**: Required

**Request Body**:

```json
{
  "launchPackId": "550e8400-e29b-41d4-a716-446655440000",
  "text": "Your tweet content here"
}
```

**Response**: `200 OK`

```json
{
  "data": {
    "id": "2014420092398776524",
    "remaining": 445
  }
}
```

**Example**:

```bash
curl -X POST http://localhost:8787/v1/tweet \
  -H "Content-Type: application/json" \
  -H "x-admin-token: YOUR_ADMIN_TOKEN" \
  -d '{"launchPackId":"UUID","text":"$DUMP is unstoppable! Follow: @sir_dumps"}'
```

**Notes**:

- Counts against your X rate limit quota
- Returns remaining tweet count for the month
- Useful for testing before enabling auto-scheduler

---

### 9. Export LaunchPack as Text

**`GET /v1/launchpacks/{id}/export`**

Export LaunchPack as human-readable text/markdown format.

**Authentication**: Required

**Path Parameters**:

- `id` (UUID): LaunchPack ID

**Response**: `200 OK`

```json
{
  "data": {
    "markdown": "# Launch Brief: MoonDog (MOON)\n- Name: MoonDog\n- Symbol: MOON\n...",
    "payload": {
      "pump": { ... },
      "telegram": { ... },
      "x": { ... }
    }
  }
}
```

**Error Responses**:

- `404 Not Found`: LaunchPack doesn't exist
- `401 Unauthorized`: Missing or invalid authentication

---

## Data Models

### LaunchPack

```typescript
{
  id: string;              // UUID
  brand: {
    name: string;          // Required
    ticker: string;        // Required, max 12 chars, uppercase
    tagline?: string;
    description?: string;
    lore?: string;
  };
  assets?: {
    logo_url?: string;     // Auto-generated from DiceBear if not provided
    banner_url?: string;
    memes?: Array<{
      url: string;
      caption?: string;
    }>;
  };
  links?: {
    website?: string;
    x?: string;
    telegram?: string;
  };
  tg?: {
    chat_id?: string;      // Telegram group ID (format: -1001234567890)
    pins?: {
      welcome?: string;
      how_to_buy?: string;
      memekit?: string;
    };
    schedule?: Array<{
      when: string;        // ISO datetime
      text: string;
      media_url?: string;
    }>;
  };
  x?: {
    main_post?: string;
    thread?: string[];
    reply_bank?: string[];
    schedule?: Array<{
      when: string;
      text: string;
      media_url?: string;
    }>;
  };
  launch?: {
    status?: "draft" | "ready" | "launched" | "failed";
    mint?: string;
    tx_signature?: string;
    pump_url?: string;
    requested_at?: string;
    completed_at?: string;
    launched_at?: string;
    failed_at?: string;
    error_code?: string;
    error_message?: string;
  };
  ops?: {
    checklist?: {
      copy_ready?: boolean;
      tg_ready?: boolean;
      x_ready?: boolean;
      launch_ready?: boolean;
    };
    tg_published_at?: string;
    tg_publish_status?: string;
    tg_message_ids?: string[];
    x_published_at?: string;
    x_publish_status?: string;
    x_post_ids?: string[];
    audit_log?: Array<{
      at?: string;
      message: string;
      actor?: string;
    }>;
  };
  created_at: string;
  updated_at: string;
}
```

---

## Error Response Format

All errors follow this structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": { ... }  // Optional additional context
  }
}
```

### Common Error Codes

- `UNAUTHORIZED`: Missing or invalid authentication
- `NOT_FOUND`: Resource doesn't exist
- `INVALID_INPUT`: Request validation failed
- `LAUNCHPACK_STORE_UNAVAILABLE`: Database connection issue
- `LOGO_REQUIRED`: Token needs logo URL
- `LOGO_FETCH_FAILED`: Couldn't download logo
- `PUMP_LAUNCH_FAILED`: Blockchain deployment failed
- `TG_DISABLED`: Telegram publishing not enabled
- `TG_CONFIG_MISSING`: Missing Telegram credentials
- `TG_NOT_READY`: LaunchPack not ready for Telegram
- `TG_PUBLISH_FAILED`: Telegram API error
- `X_DISABLED`: X publishing not enabled
- `X_NOT_READY`: LaunchPack not ready for X
- `X_PUBLISH_FAILED`: X API error

---

## Authentication

All API requests (except `/health`) require authentication via Bearer token:

```bash
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
     http://localhost:8787/v1/launchpacks
```

Set `LAUNCHKIT_ADMIN_TOKEN` or `ADMIN_TOKEN` in your environment variables.

---

## Rate Limiting

Currently no rate limiting is enforced, but this may be added in future versions.

---

## Example Workflows

### Full Token Launch Flow

```bash
# 1. Create LaunchPack
curl -X POST http://localhost:8787/v1/launchpacks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "brand": {
      "name": "MoonDog",
      "ticker": "MOON"
    },
    "links": {
      "website": "https://moondogcoin.com",
      "x": "https://x.com/moondogcoin",
      "telegram": "https://t.me/moondogofficial"
    },
    "tg": {
      "chat_id": "-1001234567890"
    }
  }'

# 2. Generate marketing copy
curl -X POST http://localhost:8787/v1/launchpacks/{ID}/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"theme": "bullish", "tone": "hype"}'

# 3. Launch token
curl -X POST http://localhost:8787/v1/launchpacks/{ID}/launch \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# 4. Auto-publish to Telegram (happens automatically after launch)
# Or manually:
curl -X POST http://localhost:8787/v1/launchpacks/{ID}/publish/telegram \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

# 5. Publish to X
curl -X POST http://localhost:8787/v1/launchpacks/{ID}/publish/x \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### List and Monitor

```bash
# List all LaunchPacks
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:8787/v1/launchpacks

# Get specific LaunchPack
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:8787/v1/launchpacks/{ID}

# Export as markdown
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:8787/v1/launchpacks/{ID}/export
```

---

## Integration Status

✅ **Confirmed Integrated Endpoints**:

- `GET /health` - Health check
- `GET /v1/launchpacks` - List all LaunchPacks (JUST ADDED)
- `POST /v1/launchpacks` - Create LaunchPack
- `GET /v1/launchpacks/{id}` - Get LaunchPack
- `PATCH /v1/launchpacks/{id}` - Update LaunchPack
- `POST /v1/launchpacks/{id}/generate` - Generate copy
- `POST /v1/launchpacks/{id}/launch` - Launch token
- `POST /v1/launchpacks/{id}/publish/telegram` - Publish to Telegram
- `POST /v1/launchpacks/{id}/publish/x` - Publish to X
- `GET /v1/launchpacks/{id}/export` - Export as text

All endpoints are **fully integrated and tested** in the codebase. The server runs on **port 8787** by default.

---

## Notes for Dashboard Integration

1. **Base URL**: Always use `http://localhost:8787` (not port 3000)
2. **Authentication**: Store admin token securely, send with every request
3. **Real-time Updates**: No WebSocket support yet - use polling for status updates
4. **Pagination**: Not yet implemented for list endpoint - returns all items
5. **Filtering**: Not yet implemented - client-side filtering recommended
6. **Auto-refresh**: Poll every 5-10 seconds for launch status updates
7. **Error Handling**: Always check for `error` field in response before accessing `data`
