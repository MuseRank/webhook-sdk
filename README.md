# @muserank/webhook-sdk

Official SDK for receiving MuseRank webhook events in your application. Easily integrate article publishing events into your Next.js, Remix, Astro, SvelteKit, Express, or any server runtime with standard `Request`/`Response` support.

## Features

- **Idempotency built-in** — every event carries a stable `event_id`; use it as your `UNIQUE` constraint
- **HMAC signing** — `signingSecret` accepts an array (for rotation), every secret is tried in constant time
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
    // Upsert, not create: MuseRank retries failed deliveries, so the
    // same article can arrive more than once.
    const data = {
      title: article.title,
      content: article.content_html,
      slug: article.slug,
      metaDescription: article.meta_description,
      featuredImage: article.image_url,
      tags: article.tags,
      createdAt: new Date(article.created_at), // creation time, not publish time
    };
    await prisma.article.upsert({
      where: { externalId: article.id },
      create: { externalId: article.id, ...data },
      update: data,
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
// express.json() defaults to a 100kb limit. MuseRank sends long articles
// as HTML plus Markdown, so raise it to match the SDK's 5MB default.
app.use(express.json({ limit: '5mb' }));

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
  // Pass an array to accept several secrets (e.g. `[new, old]` right after
  // rotating in MuseRank) — the SDK tries every entry.
  signingSecret?: string | readonly string[];

  // Optional: Timestamp tolerance for replay attack protection (default: 5 minutes)
  // Set to 0 to disable timestamp verification
  timestampToleranceMs?: number;

  // Optional: Max accepted payload size in bytes (default: 5MB, sized for
  // MuseRank's largest articles). Set to 0 to disable size checks
  maxBodySizeBytes?: number;

  // Optional: Per-handler timeout in milliseconds (default: 25s, just under
  // MuseRank's 30s delivery timeout).
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
| `article.published` | Article was published for the first time |
| `article.updated` | An already-published article was published again (for example after edits). Saving edits alone does not send this event. |
| `article.scheduled` | Article was scheduled for publishing |
| `article.failed` | A publish attempt for the article failed |
| `test.ping` | **Test** button in the MuseRank dashboard. `data.articles` is empty. |

You choose which article events to receive when you connect the webhook in
MuseRank. `test.ping` is always sent when you press **Test**; without an
`onTestPing` handler the SDK acknowledges it with `200`.

## Article Payload

Each article in the webhook payload includes:

```typescript
interface WebhookArticle {
  id: string;               // Unique article ID
  title: string;            // SEO-optimized title (falls back to editorial title)
  content_markdown: string; // Content as Markdown (converted from the editor's HTML)
  content_html: string;     // Content as raw HTML (exactly as edited in MuseRank)
  meta_description: string; // SEO meta description
  created_at: string;       // ISO 8601 creation time in MuseRank (not the publish time)
  image_url: string;        // Featured image URL ("" when none set)
  slug: string;             // Slug of the editorial title (key records on `id`, not `slug`)
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

### How MuseRank delivers

| Your response | What MuseRank does |
|---------------|--------------------|
| `2xx` | Delivered. |
| `5xx`, `408`, `429`, network error, or no response within **30 seconds** | Retries with exponential backoff: up to 8 attempts, starting at 30s and doubling (about an hour in total). |
| Any other `4xx` (including the SDK's `400`, `401`, `413`) | Permanent failure. Not retried. |

Each attempt is signed again and carries a fresh `timestamp` and
`delivery_id`, so retries pass the SDK's replay window. MuseRank does not
follow redirects, so register the final URL. When the webhook is the
article's publishing destination (rather than a notification alongside
another destination), a failed delivery fails that publish job, which
follows the publishing queue's retry schedule instead. After **10
consecutive failed deliveries** MuseRank disables the webhook; saving the
webhook settings or a successful **Test** re-enables it.

The `event_id` stays the same on every retry, so the
production-recommended pattern is to claim the event and do the work in
**one transaction**. If the work fails, the rollback releases the claim and
MuseRank's retry is processed. A claim committed before the work would make
that retry look like a duplicate, and the event would be lost:

```typescript
onArticlePublished: async (article, _payload, ctx) => {
  await db.transaction(async (tx) => {
    // Race-safe atomic claim. If another request already processed this
    // event, the INSERT does nothing and we ack-and-drop.
    const { rowCount } = await tx.query(
      `INSERT INTO processed_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [ctx.eventId],
    );
    if (rowCount === 0) return;

    await tx.article.upsert({ ... });
  });
}
```

### Headers MuseRank sends

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <access token>` — the token you entered in MuseRank. Verified by the SDK. |
| `X-MuseRank-Signature` | `sha256=<hex>` HMAC-SHA256 of the raw body. Sent when a signing secret exists. Verified by the SDK when you set `signingSecret`. |
| `X-MuseRank-Signature-V2` | `sha256=<hex>` HMAC-SHA256 of `` `${X-MuseRank-Timestamp}.${rawBody}` ``. For receivers that check freshness before parsing JSON. The SDK does not need it: the body `timestamp` it checks is already covered by `X-MuseRank-Signature`. |
| `X-MuseRank-Timestamp` | Send time in Unix milliseconds (pairs with `X-MuseRank-Signature-V2`). |
| `X-MuseRank-Event-ID` | Same as `payload.event_id`. |
| `X-MuseRank-Delivery-ID` | Same as `payload.delivery_id`. |
| `X-Webhook-Event` | Same as `payload.event_type`. |

A non-TypeScript consumer can validate payloads against the JSON Schema we
ship at the package root:

```bash
node -e "console.log(require('@muserank/webhook-sdk/payload.schema.json').$id)"
```

CI checks the schema against `WebhookPayload` on every run, so the two
cannot drift apart unnoticed.

## Handler timeouts

Long-running handlers block MuseRank's outbound request and waste retry
budget. MuseRank waits 30 seconds per attempt; the SDK enforces a
per-handler timeout (default 25 seconds, so it answers first) and exposes
the abort signal via `context.signal`:

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

**Rotating the secret**

**Rotate** in MuseRank takes effect immediately: every delivery after that,
including retries of older events, is signed with the new secret. Until your
endpoint has the new secret, those deliveries fail with `401` and are not
retried. Keep that window short:

1. Have your deploy ready, then press **Rotate** and copy the new secret.
2. Deploy right away with both secrets (`signingSecret` accepts an array and
   tries every entry in constant time):

   ```typescript
   createMuseRankWebhook({
     accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
     signingSecret: [
       process.env.MUSERANK_SIGNING_SECRET_NEW!, // everything sent after the rotation
       process.env.MUSERANK_SIGNING_SECRET_OLD!, // requests already in flight
     ],
   });
   ```

3. Drop the old secret on your next deploy.

If articles were published during the window, republish them or check the
webhook status in MuseRank.

**How to get the signing secret:**

1. Open **Integrations → Webhook** in your MuseRank dashboard.
2. On first connect, MuseRank generates a `whsec_…` signing secret and shows it **once** — copy it immediately into your environment as `MUSERANK_SIGNING_SECRET`.
3. To rotate (e.g. after a suspected leak), use the **Rotate** action on the same screen. The previous secret stops being used immediately — see **Rotating the secret** above.

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

The SDK rejects requests larger than **5MB** by default with HTTP `413`.
MuseRank allows article HTML up to 2,000,000 characters and sends it twice
(HTML plus Markdown), so payloads for long articles can reach about 4–5MB.
MuseRank treats `413` as permanent and does not retry, so don't set the
limit lower than the articles you publish. The `/web` and `/nextjs`
adapters (and the Express handler when no body parser runs before it) check
the `Authorization` header before reading the body, so unauthenticated
requests are rejected without being buffered. Middleware that parses the
body first (`express.json()`, `rawBodyMiddleware`) reads it before that
check, so its `limit` is your upper bound.

```typescript
createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  maxBodySizeBytes: 8 * 1024 * 1024, // 8MB
  // Set to 0 to disable payload size enforcement
});
```

Your framework may enforce its own, smaller limit before the SDK runs:
`express.json()` defaults to **100kb** (set `limit: '5mb'`), and the Next.js
Pages Router body parser defaults to **1mb** (disable it with
`bodyParser: false`, which signature verification needs anyway). The
App Router and `/web` adapters read the body themselves.

### ⚠️ Important: Raw Body Preservation

**If you're using signature verification**, you must ensure the raw request body is preserved. Body parsers (like `express.json()` or Next.js API routes) can modify whitespace/ordering, which invalidates signatures.

**For Express:**
```typescript
import express from 'express';
import { createRawBodyVerifier, createMuseRankWebhook } from '@muserank/webhook-sdk/express';

app.post(
  '/api/webhooks/muserank',
  express.json({
    limit: '5mb',
    verify: createRawBodyVerifier({
      maxBodySizeBytes: 5 * 1024 * 1024, // Optional, defaults to 5MB
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
  rawBodyMiddleware({ maxBodySizeBytes: 5 * 1024 * 1024 }),
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
3. Enter your webhook endpoint URL (e.g., `https://yourdomain.com/api/webhooks/muserank`). It must be a public `https` URL, and redirects are not followed.
4. Enter an access token (at least 10 characters). You choose it; use a long random value and set the same value as `MUSERANK_WEBHOOK_TOKEN` (`accessToken`) on your endpoint.
5. Select which event types to receive
6. Click **Connect Webhook**. MuseRank generates a `whsec_…` signing secret and shows it **once**; copy it into `MUSERANK_SIGNING_SECRET` (`signingSecret`).
7. Use the **Test** button to verify your integration (sends `test.ping`)

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
