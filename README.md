# @muserank/webhook-sdk

Official SDK for receiving MuseRank webhook events in your application. Easily integrate article publishing events into your Next.js, Remix, Astro, SvelteKit, Express, or any server runtime with standard `Request`/`Response` support.

## Features

- 🔒 **Secure** - HMAC signature verification, constant-time token comparison, replay attack protection, payload size limits
- 📦 **Universal** - Works with Next.js, Remix, Astro, SvelteKit, Express, Cloudflare Workers, Deno, Bun
- 🎯 **Type-Safe** - Full TypeScript support with exported types
- ⚡ **Simple** - One function setup, handles all verification automatically

## Installation

```bash
npm install @muserank/webhook-sdk
# or
yarn add @muserank/webhook-sdk
# or
pnpm add @muserank/webhook-sdk
```

## Quick Start

### Next.js App Router

```typescript
// app/api/webhooks/muserank/route.ts
import { createMuseRankWebhook } from '@muserank/webhook-sdk/nextjs';

export const POST = createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  
  onArticlePublished: async (article) => {
    // Webhook delivery is at-least-once — keep this idempotent.
    // Upsert keyed on the stable article id so retries/redeliveries don't
    // create duplicates. See the "Idempotency & delivery semantics" section.
    await prisma.article.upsert({
      where: { externalId: article.id },
      create: {
        externalId: article.id,
        title: article.title,
        content: article.content_html,
        slug: article.slug,
        metaDescription: article.meta_description,
        featuredImage: article.image_url,
        tags: article.tags,
        publishedAt: new Date(article.created_at),
      },
      update: {
        title: article.title,
        content: article.content_html,
        slug: article.slug,
        metaDescription: article.meta_description,
        featuredImage: article.image_url,
        tags: article.tags,
      },
    });
  },

  onArticleUpdated: async (article) => {
    await prisma.article.update({
      where: { externalId: article.id },
      data: {
        title: article.title,
        content: article.content_html,
        updatedAt: new Date(),
      },
    });
  },

  debug: process.env.NODE_ENV === 'development',
});
```

### Remix

```typescript
// app/routes/api.webhooks.muserank.tsx
import { createMuseRankWebhook } from '@muserank/webhook-sdk/web';

const handler = createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  onArticlePublished: async (article) => {
    console.log('New article:', article.title);
  },
});

export const action = async ({ request }: { request: Request }) => {
  return handler(request);
};
```

### Astro

```typescript
// src/pages/api/webhooks/muserank.ts
import type { APIRoute } from 'astro';
import { createMuseRankWebhook } from '@muserank/webhook-sdk/web';

const handler = createMuseRankWebhook({
  accessToken: import.meta.env.MUSERANK_WEBHOOK_TOKEN,
  onArticlePublished: async (article) => {
    console.log('New article:', article.title);
  },
});

export const POST: APIRoute = async ({ request }) => {
  return handler(request);
};
```

### SvelteKit

```typescript
// src/routes/api/webhooks/muserank/+server.ts
import { createMuseRankWebhook } from '@muserank/webhook-sdk/web';
import { MUSERANK_WEBHOOK_TOKEN } from '$env/static/private';

const handler = createMuseRankWebhook({
  accessToken: MUSERANK_WEBHOOK_TOKEN,
  onArticlePublished: async (article) => {
    console.log('New article:', article.title);
  },
});

export const POST = async ({ request }) => {
  return handler(request);
};
```

### Express.js

```typescript
import express from 'express';
import { createMuseRankWebhook } from '@muserank/webhook-sdk/express';

const app = express();
app.use(express.json());

app.post('/api/webhooks/muserank', createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  
  onArticlePublished: async (article) => {
    // Delivery is at-least-once — upsert instead of insert so retries
    // and redeliveries are safe (see "Idempotency & delivery semantics").
    await Article.upsert(
      {
        externalId: article.id,
        title: article.title,
        content: article.content_html,
      },
      { conflictFields: ['externalId'] },
    );
  },
}));

app.listen(3000);
```

### Cloudflare Workers

```typescript
import { createMuseRankWebhook } from '@muserank/webhook-sdk/web';

const handler = createMuseRankWebhook({
  accessToken: 'your-token',
  onArticlePublished: async (article) => {
    console.log('New article:', article.title);
  },
});

export default {
  async fetch(request: Request) {
    if (request.method === 'POST') {
      return handler(request);
    }
    return new Response('Method not allowed', { status: 405 });
  },
};
```

### Next.js Pages Router

```typescript
// pages/api/webhooks/muserank.ts
import { createMuseRankPagesWebhook } from '@muserank/webhook-sdk/nextjs';

export default createMuseRankPagesWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  onArticlePublished: async (article) => {
    console.log('New article:', article.title);
  },
});

// Required for raw body access (needed for signature verification)
export const config = {
  api: { bodyParser: false },
};
```

## Configuration Options

```typescript
interface WebhookConfig {
  // Required: Your webhook token from MuseRank
  accessToken: string;

  // Optional: Signing secret for HMAC verification (recommended for production)
  signingSecret?: string;

  // Optional: Timestamp tolerance for replay attack protection (default: 5 minutes)
  // Set to 0 to disable timestamp verification
  timestampToleranceMs?: number;

  // Optional: Max accepted payload size in bytes (default: 1MB)
  // Set to 0 to disable size checks
  maxBodySizeBytes?: number;

  // Event handlers
  onArticlePublished?: (article, payload) => Promise<void> | void;
  onArticleUpdated?: (article, payload) => Promise<void> | void;
  onArticleScheduled?: (article, payload) => Promise<void> | void;
  onArticleFailed?: (article, payload) => Promise<void> | void;
  onTestPing?: (payload) => Promise<void> | void;

  // Generic handler (called for all events)
  onEvent?: (eventType, payload) => Promise<void> | void;

  // Error handler
  onError?: (error, payload) => Promise<void> | void;

  // Enable debug logging
  debug?: boolean;
}
```

## Event Types

| Event | Description |
|-------|-------------|
| `article.published` | Article was successfully published |
| `article.updated` | Published article was updated |
| `article.scheduled` | Article was scheduled for publishing |
| `article.failed` | Article publishing failed |
| `test.ping` | Test event from MuseRank dashboard |

## Webhook Payload

Every webhook body shares the same envelope:

```typescript
interface WebhookPayload {
  event_type: WebhookEventType; // e.g. "article.published"
  event_id?: string;            // Stable idempotency key: evt_<32-hex> (36 chars)
  delivery_id?: string;         // Per-attempt correlation id: dlv_<24-hex> (28 chars)
  timestamp: string;            // ISO 8601 time the event was dispatched
  data: { articles: WebhookArticle[] };
}
```

Both fields are also sent as request headers:
- `X-MuseRank-Event-ID` — stable across retries, use for deduplication
- `X-MuseRank-Delivery-ID` — unique per attempt, use for log correlation only

> `event_id` is your **idempotency key**. It is present on events from MuseRank's
> production dispatcher and stays the same across all delivery retries of the same
> logical event. See [Idempotency & delivery semantics](#idempotency--delivery-semantics).

## Article Payload

Each article in the webhook payload includes:

```typescript
interface WebhookArticle {
  id: string;              // Unique article ID (stable — use as your idempotency/dedupe key)
  title: string;           // Article title (the SEO title when one is set)
  content_markdown: string; // Content in Markdown (best-effort, see note below)
  content_html: string;     // Content in HTML (source of truth)
  meta_description: string; // SEO meta description
  created_at: string;       // ISO 8601 timestamp
  image_url: string;        // Featured image URL ("" when none)
  slug: string;             // URL-friendly slug
  tags: string[];           // Associated tags/keywords ([] when none)
}
```

> **`content_html` is the source of truth.** `content_markdown` is generated
> best-effort by converting the HTML and may be an empty string if conversion
> fails — prefer `content_html` if you need guaranteed content.
>
> **`title`** reflects the article's SEO title when one is configured,
> otherwise the editor title.

## Idempotency & delivery semantics

MuseRank delivers webhooks **at-least-once**: deliveries are retried with
exponential backoff on transient failures, so your endpoint may legitimately
receive the **same event more than once**. Make your handlers idempotent:

- Deduplicate on `payload.event_id` (preferred — `evt_<32-hex>`, stable across all retries of the same event) or on the stable `article.id`.
- `payload.delivery_id` (`dlv_<24-hex>`) is **fresh per attempt** — use it only for correlating a specific retry with MuseRank's logs, never for deduplication.
- Use upserts (insert-or-update) rather than blind inserts.
- Treat handler work as safe to repeat (e.g. avoid sending a duplicate notification for an event you've already processed).

```typescript
onArticlePublished: async (article, payload) => {
  // Skip if we've already handled this logical event
  if (payload.event_id && (await seenEvent(payload.event_id))) return;

  await db.articles.upsert({
    where: { externalId: article.id },
    create: { externalId: article.id, title: article.title, content: article.content_html },
    update: { title: article.title, content: article.content_html },
  });

  if (payload.event_id) await markEventSeen(payload.event_id);
  // payload.delivery_id is useful here only for logging which attempt this was:
  // console.log('processed delivery', payload.delivery_id);
},
```

The SDK echoes both ids back to you on `WebhookResult` as `result.eventId`
and `result.deliveryId` for logging.

## Security

### Token Verification

The SDK automatically verifies the Bearer token in the Authorization header against your `accessToken`. **Constant-time comparison** is used to prevent timing attacks.

### Signature Verification (Recommended)

For additional security, enable HMAC signature verification:

```typescript
createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  signingSecret: process.env.MUSERANK_SIGNING_SECRET, // Optional but recommended
});
```

The SDK will verify the `X-MuseRank-Signature` header using HMAC-SHA256.

### Replay Attack Protection

The SDK automatically rejects webhooks with timestamps older than 5 minutes to prevent replay attacks. You can customize this:

```typescript
createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  timestampToleranceMs: 10 * 60 * 1000, // 10 minutes
  // Or set to 0 to disable timestamp verification
});
```

### Payload Size Limits

The SDK rejects requests larger than **1MB** by default with HTTP `413`.

```typescript
createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  maxBodySizeBytes: 2 * 1024 * 1024, // 2MB
  // Set to 0 to disable payload size enforcement
});
```

### ⚠️ Important: Raw Body Preservation

**If you're using signature verification**, you must ensure the raw request body is preserved. Body parsers (like `express.json()` or Next.js API routes) can modify whitespace/ordering, which invalidates signatures.

**For Express:**
```typescript
import express from 'express';
import { createRawBodyVerifier, createMuseRankWebhook } from '@muserank/webhook-sdk/express';

app.post(
  '/api/webhooks/muserank',
  express.json({
    limit: '2mb',
    verify: createRawBodyVerifier({
      maxBodySizeBytes: 2 * 1024 * 1024, // Optional, defaults to 1MB
    }),
  }),
  createMuseRankWebhook({
    accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
    signingSecret: process.env.MUSERANK_SIGNING_SECRET,
  })
);
```

Alternative (without `express.json()` on the webhook route):
```typescript
import { rawBodyMiddleware, createMuseRankWebhook } from '@muserank/webhook-sdk/express';

app.post(
  '/api/webhooks/muserank',
  rawBodyMiddleware({ maxBodySizeBytes: 2 * 1024 * 1024 }),
  createMuseRankWebhook({
    accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
    signingSecret: process.env.MUSERANK_SIGNING_SECRET,
  })
);
```

**For Next.js Pages Router:**
```typescript
export const config = {
  api: { bodyParser: false }, // Disable body parser
};
```

**For Next.js App Router / Web API frameworks:**
The `/web` and `/nextjs` adapters automatically read the raw body, so no extra configuration is needed.

## Error Handling

The SDK provides typed errors for better error handling:

```typescript
import {
  WebhookVerificationError,
  WebhookProcessingError,
} from '@muserank/webhook-sdk';

// WebhookVerificationError - 400/401/413 response
// 400: malformed payload or missing required fields
// 401: auth/signature/timestamp verification failures
// 413: payload exceeds configured size limit

// WebhookProcessingError - 500 response
// Thrown when event processing fails
```

## Generic Handler

For frameworks not listed above, use the core handler:

```typescript
import { createWebhookHandler } from '@muserank/webhook-sdk';

const handler = createWebhookHandler({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  onArticlePublished: async (article) => {
    // Handle article
  },
});

// Use with any framework
const result = await handler({
  headers: {
    authorization: 'Bearer your-token',
  },
  body: rawRequestBody,
});
```

## TypeScript Support

Full TypeScript support with exported types:

```typescript
import type {
  WebhookConfig,
  WebhookArticle,
  WebhookPayload,
  WebhookEventType,
  WebhookResult,
} from '@muserank/webhook-sdk';
```

## Framework Compatibility

| Framework | Import Path | Status |
|-----------|-------------|--------|
| Next.js App Router | `@muserank/webhook-sdk/nextjs` | ✅ Native |
| Next.js Pages Router | `@muserank/webhook-sdk/nextjs` | ✅ Native |
| Remix | `@muserank/webhook-sdk/web` | ✅ Native |
| Astro | `@muserank/webhook-sdk/web` | ✅ Native |
| SvelteKit | `@muserank/webhook-sdk/web` | ✅ Native |
| Express.js | `@muserank/webhook-sdk/express` | ✅ Native |
| Cloudflare Workers | `@muserank/webhook-sdk/web` | ✅ Native |
| Deno | `@muserank/webhook-sdk/web` | ✅ Native |
| Bun | `@muserank/webhook-sdk/web` | ✅ Native |
| Fastify | `@muserank/webhook-sdk` | ⚙️ Use core handler |
| Hono | `@muserank/webhook-sdk/web` | ✅ Native |
| AWS Lambda | `@muserank/webhook-sdk` | ⚙️ Use core handler |

## Setting Up in MuseRank

1. Go to **Integrations** in your MuseRank dashboard
2. Click **Connect** on the Webhook card
3. Enter your webhook endpoint URL (must be **HTTPS**, e.g. `https://yourdomain.com/api/webhooks/muserank`)
4. Choose an **access token** (a secret string you create) — MuseRank sends it as
   `Authorization: Bearer <token>`. Put the same value in the SDK's `accessToken`.
5. Select which event types to receive
6. Click **Connect Webhook**. MuseRank then **generates an HMAC signing secret**
   (`whsec_…`) and shows it **once** — copy it now and set it as the SDK's
   `signingSecret` to enable signature verification. (You can later rotate it from
   the dashboard; rotation is a hard cut-over with no grace period.)
7. Use the **Test** button to send a signed `test.ping` and verify your integration

```typescript
createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,   // the token you entered in step 4
  signingSecret: process.env.MUSERANK_SIGNING_SECRET, // the whsec_… shown once in step 6
});
```

## Examples

### Sync to Headless CMS

```typescript
onArticlePublished: async (article) => {
  await contentfulClient.createEntry('article', {
    fields: {
      title: { 'en-US': article.title },
      body: { 'en-US': article.content_html },
      slug: { 'en-US': article.slug },
    },
  });
},
```

### Send to Slack

```typescript
onArticlePublished: async (article) => {
  await fetch(process.env.SLACK_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `📝 New article published: *${article.title}*`,
    }),
  });
},
```

### Create GitHub Issue for Failed Articles

```typescript
onArticleFailed: async (article, payload) => {
  await octokit.issues.create({
    owner: 'your-org',
    repo: 'content-tracking',
    title: `Failed to publish: ${article.title}`,
    body: `Article ID: ${article.id}\nTimestamp: ${payload.timestamp}`,
  });
},
```

## License

MIT © MuseRank
