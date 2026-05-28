# @muserank/webhook-sdk

Official SDK for receiving MuseRank webhook events in your application. Easily integrate article publishing events into your Next.js, Remix, Astro, SvelteKit, Express, or any server runtime with standard `Request`/`Response` support.

## Features

- **Idempotency built-in** — every event carries a stable `event_id`; use it as your `UNIQUE` constraint
- **HMAC signing with zero-downtime rotation** — `signingSecret` accepts an array, every secret is tried in constant time
- **Per-handler timeouts** — slow handlers are aborted via `AbortSignal` so MuseRank can back off and retry
- **Structured error overrides** — `onError` can return a custom HTTP status to ack-and-drop poison messages instead of looping retries
- **Universal** — Next.js, Remix, Astro, SvelteKit, Express, Cloudflare Workers, Deno, Bun
- **Type-safe** — full TypeScript support, `payload.schema.json` shipped for non-TS consumers
- **Secure** — constant-time token comparison, replay protection, payload size limits

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
    await prisma.article.create({
      data: {
        externalId: article.id,
        title: article.title,
        content: article.content_html,
        slug: article.slug,
        metaDescription: article.meta_description,
        featuredImage: article.image_url,
        tags: article.tags,
        publishedAt: new Date(article.created_at),
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
    await Article.create({
      externalId: article.id,
      title: article.title,
      content: article.content_html,
    });
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

  // Optional: Signing secret for HMAC verification.
  // Pass an array during a rotation window — the SDK tries every entry,
  // so both old-and-new secrets verify until you drop the old one.
  signingSecret?: string | readonly string[];

  // Optional: Timestamp tolerance for replay attack protection (default: 5 minutes)
  // Set to 0 to disable timestamp verification
  timestampToleranceMs?: number;

  // Optional: Max accepted payload size in bytes (default: 1MB)
  // Set to 0 to disable size checks
  maxBodySizeBytes?: number;

  // Optional: Per-handler timeout in milliseconds (default: 30s).
  // The handler's `context.signal` is aborted when this elapses.
  // Set to 0 to disable.
  handlerTimeoutMs?: number;

  // Event handlers — third arg is a `WebhookContext`:
  //   { eventId, deliveryId, signal }
  onArticlePublished?: (article, payload, context) => Promise<void> | void;
  onArticleUpdated?:   (article, payload, context) => Promise<void> | void;
  onArticleScheduled?: (article, payload, context) => Promise<void> | void;
  onArticleFailed?:    (article, payload, context) => Promise<void> | void;
  onTestPing?:         (payload, context) => Promise<void> | void;

  // Generic handler (called after specific handlers)
  onEvent?: (eventType, payload, context) => Promise<void> | void;

  // Error handler. Return { statusCode, success?, message? } to override
  // the default 500 — e.g. `{ statusCode: 200 }` to ack-and-drop poison
  // messages, or `{ statusCode: 422 }` to permanently reject. Returning
  // `void` keeps the default behavior.
  onError?: (error, payload?) =>
    | Promise<{ statusCode: number; success?: boolean; message?: string } | void>
    | { statusCode: number; success?: boolean; message?: string }
    | void;

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

## Article Payload

Each article in the webhook payload includes:

```typescript
interface WebhookArticle {
  id: string;               // Unique article ID
  title: string;            // SEO-optimized title (falls back to editorial title)
  content_markdown: string; // Content as Markdown (converted from the editor's HTML)
  content_html: string;     // Content as raw HTML (exactly as edited in MuseRank)
  meta_description: string; // SEO meta description
  created_at: string;       // ISO 8601 timestamp
  image_url: string;        // Featured image URL ("" when none set)
  slug: string;             // URL-friendly slug
  tags: string[];           // [primary keyword, focus keyphrase, ...topical-map siblings]
}
```

> **Note**
> `content_markdown` and `content_html` are both present in every payload — pick whichever fits your destination. Use `content_html` when writing to an HTML-native target (e.g. an `<article>` tag, a CMS rich-text field, an email template) and `content_markdown` when writing to a Markdown-native one (Contentful long-text, MDX, Ghost source).
>
> `tags` is derived from MuseRank's keyword pipeline (primary keyword + SEO focus keyphrase + the article's topical-map siblings), deduped case-insensitively. `tags[0]` is always the primary keyword.

## Envelope, idempotency, and retries

Every payload also carries:

```typescript
interface WebhookPayload {
  event_id: string;       // stable across retries — use as your idempotency key
  delivery_id?: string;   // changes per attempt — use for log correlation only
  event_type: WebhookEventType;
  timestamp: string;      // ISO 8601, this delivery attempt
  data: { articles: WebhookArticle[] };
}
```

MuseRank retries failed deliveries (5xx and timeouts) up to 3 times with
exponential backoff. The `event_id` stays the same on every retry, so the
production-recommended pattern is:

```typescript
onArticlePublished: async (article, _payload, ctx) => {
  // Race-safe atomic claim. If another worker already processed this
  // event, the INSERT does nothing and we ack-and-drop.
  const { rowCount } = await db.query(
    `INSERT INTO processed_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [ctx.eventId],
  );
  if (rowCount === 0) return;

  await db.article.upsert({ ... });
}
```

A non-TypeScript consumer can validate payloads against the JSON Schema we
ship at the package root:

```bash
node -e "console.log(require('@muserank/webhook-sdk/payload.schema.json').$id)"
```

The schema is regenerated against `WebhookPayload` on every CI run, so it
never drifts.

## Handler timeouts

Long-running handlers block MuseRank's outbound request and waste retry
budget. The SDK enforces a per-handler timeout (default 30 seconds) and
exposes the abort signal via `context.signal`:

```typescript
onArticlePublished: async (article, _payload, ctx) => {
  // `fetch` honors AbortSignal natively — pass it down so a timeout
  // actually cancels the network call instead of waiting for it.
  await fetch("https://my-cms.example.com/articles", {
    method: "POST",
    body: JSON.stringify(article),
    signal: ctx.signal,
  });
}
```

Tune with `handlerTimeoutMs`:

```typescript
createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  handlerTimeoutMs: 10_000, // tighter than default
  // handlerTimeoutMs: 0,    // disable entirely (signal still present, never aborts)
});
```

A timeout throws `WebhookHandlerTimeoutError` (a subclass of
`WebhookProcessingError`) so the request returns 500 and MuseRank retries.

## Response overrides — ack-and-drop poison messages

Returning a 5xx tells MuseRank to retry. That's the right default, but
some failures are permanent — a uniqueness constraint, a schema mismatch,
a tenant that's been deleted. For those, return a structured override
from `onError`:

```typescript
createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,

  onArticlePublished: async (article) => {
    await db.articles.create({ data: { externalId: article.id, ... } });
  },

  onError: (error) => {
    // Already have this row — definitely don't retry.
    if (error.message.includes("UNIQUE constraint")) {
      return { statusCode: 200, success: true, message: "duplicate ignored" };
    }
    // Permanently broken payload — 4xx tells MuseRank to give up.
    if (error.message.startsWith("Schema mismatch")) {
      return { statusCode: 422, message: "unprocessable" };
    }
    // Otherwise let it 500 so MuseRank retries.
    return undefined;
  },
});
```

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

The SDK will verify the `X-MuseRank-Signature` header (format: `sha256=<lowercase hex>`) against an HMAC-SHA256 of the **raw** request body using your `signingSecret`. Signature comparison is constant-time.

**Zero-downtime rotation**

`signingSecret` accepts an array; every entry is tried (in constant
time, so the loop runtime doesn't leak how many secrets you have).
During a rotation deploy, ship the new secret first and keep the
previous one in second position:

```typescript
createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  signingSecret: [
    process.env.MUSERANK_SIGNING_SECRET_NEW!, // matches new dispatcher
    process.env.MUSERANK_SIGNING_SECRET_OLD!, // matches in-flight requests
  ],
});
```

Once you're confident no in-flight request still uses the old secret,
drop it on the next deploy.

**How to get the signing secret:**

1. Open **Integrations → Webhook** in your MuseRank dashboard.
2. On first connect, MuseRank generates a `whsec_…` signing secret and shows it **once** — copy it immediately into your environment as `MUSERANK_SIGNING_SECRET`.
3. To rotate (e.g. after a suspected leak), use the **Rotate** action on the same screen. The previous secret stops verifying immediately — keep both in your SDK config during the rotation window.

If you set `signingSecret` on the SDK side but the destination has no secret configured in MuseRank, every request will fail with `401 Invalid signature`. Either generate one in the dashboard, or remove the `signingSecret` option from the SDK config until you do.

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
  WebhookHandlerTimeoutError,
} from '@muserank/webhook-sdk';

// WebhookVerificationError — 400/401/413 response
// 400: malformed payload, missing event_id, etc.
// 401: auth/signature/timestamp verification failures
// 413: payload exceeds configured size limit

// WebhookProcessingError — 500 by default; statusCode/message overridable
// via `onError` (see "Response overrides" above)

// WebhookHandlerTimeoutError — subclass of WebhookProcessingError, thrown
// when a handler exceeds `handlerTimeoutMs`. `instanceof` lets you
// distinguish a timeout from an arbitrary handler bug.
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
3. Enter your webhook endpoint URL (e.g., `https://yourdomain.com/api/webhooks/muserank`)
4. Generate and copy an access token
5. Select which event types to receive
6. Click **Connect Webhook**
7. Use the **Test** button to verify your integration

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
