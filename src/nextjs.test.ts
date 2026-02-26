/**
 * Tests for @muserank/webhook-sdk/nextjs
 *
 * Covers both the App Router adapter (createMuseRankWebhook) and the
 * Pages Router adapter (createMuseRankPagesWebhook).
 */

import { describe, it, expect } from "vitest";
import { createMuseRankWebhook, createMuseRankPagesWebhook } from "./nextjs";
import type { WebhookPayload } from "./nextjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_TOKEN = "test-token";

const validPayload: WebhookPayload = {
  event_type: "article.published",
  timestamp: new Date().toISOString(),
  data: {
    articles: [
      {
        id: "1",
        title: "Test article",
        content_markdown: "",
        content_html: "",
        meta_description: "",
        created_at: "",
        image_url: "",
        slug: "test-article",
        tags: [],
      },
    ],
  },
};

function makeRequest(options?: {
  method?: string;
  body?: string;
  /** When provided, REPLACES the default headers entirely. */
  headers?: Record<string, string>;
}): Request {
  const method = options?.method ?? "POST";
  const canHaveBody = method !== "GET" && method !== "HEAD";
  return new Request("https://example.com/api/webhooks/muserank", {
    method,
    body: canHaveBody
      ? (options?.body ?? JSON.stringify(validPayload))
      : undefined,
    headers: options?.headers ?? {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
  });
}

// ---------------------------------------------------------------------------
// App Router adapter
// ---------------------------------------------------------------------------

describe("nextjs adapter – App Router (createMuseRankWebhook)", () => {
  it("returns 405 for non-POST requests", async () => {
    const handler = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    const res = await handler(makeRequest({ method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("returns 401 when token is missing", async () => {
    const handler = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    // Pass headers without `authorization`
    const res = await handler(
      makeRequest({ headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is wrong", async () => {
    const handler = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    const res = await handler(
      makeRequest({ headers: { authorization: "Bearer wrong" } }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed JSON", async () => {
    const handler = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
    });
    const res = await handler(makeRequest({ body: "{broken" }));
    expect(res.status).toBe(400);
  });

  it("returns 200 for a valid webhook", async () => {
    const handler = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
    });
    const res = await handler(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.eventType).toBe("article.published");
  });

  it("returns 413 when payload exceeds maxBodySizeBytes", async () => {
    const handler = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      maxBodySizeBytes: 10,
    });
    const res = await handler(makeRequest());
    expect(res.status).toBe(413);
  });

  it("calls onArticlePublished and returns articlesProcessed", async () => {
    let count = 0;
    const handler = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
      onArticlePublished: () => {
        count++;
      },
    });
    const res = await handler(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.articlesProcessed).toBe(1);
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pages Router adapter
// ---------------------------------------------------------------------------

type MockRes = { statusCode: number; body: object };

function makePagesReq(options?: {
  method?: string;
  body?: object | string;
  /** When provided, REPLACES the default headers entirely. */
  headers?: Record<string, string>;
}) {
  return {
    method: options?.method ?? "POST",
    headers: (options?.headers ?? {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    }) as Record<string, string>,
    body: options?.body ?? validPayload,
  };
}

function makePagesRes(): {
  result: MockRes;
  status: (code: number) => { json: (body: object) => void };
} {
  const result: MockRes = { statusCode: 0, body: {} };
  return {
    result,
    status: (code: number) => ({
      json: (body: object) => {
        result.statusCode = code;
        result.body = body;
      },
    }),
  };
}

describe("nextjs adapter – Pages Router (createMuseRankPagesWebhook)", () => {
  it("responds 405 for non-POST requests", async () => {
    const handler = createMuseRankPagesWebhook({ accessToken: VALID_TOKEN });
    const req = makePagesReq({ method: "GET" });
    const { result, status } = makePagesRes();
    await handler(req, { status });
    expect(result.statusCode).toBe(405);
  });

  it("responds 401 when token is missing", async () => {
    const handler = createMuseRankPagesWebhook({ accessToken: VALID_TOKEN });
    // Omit `authorization` from headers entirely
    const req = makePagesReq({
      headers: { "content-type": "application/json" },
    });
    const { result, status } = makePagesRes();
    await handler(req, { status });
    expect(result.statusCode).toBe(401);
  });

  it("responds 401 when token is wrong", async () => {
    const handler = createMuseRankPagesWebhook({ accessToken: VALID_TOKEN });
    const req = makePagesReq({
      headers: { authorization: "Bearer wrong" },
    });
    const { result, status } = makePagesRes();
    await handler(req, { status });
    expect(result.statusCode).toBe(401);
  });

  it("responds 200 when body is a parsed object", async () => {
    const handler = createMuseRankPagesWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
    });
    const req = makePagesReq();
    const { result, status } = makePagesRes();
    await handler(req, { status });
    expect(result.statusCode).toBe(200);
    expect((result.body as { success: boolean }).success).toBe(true);
  });

  it("responds 200 when body is a JSON string", async () => {
    const handler = createMuseRankPagesWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
    });
    const req = makePagesReq({ body: JSON.stringify(validPayload) });
    const { result, status } = makePagesRes();
    await handler(req, { status });
    expect(result.statusCode).toBe(200);
  });

  it("responds 400 when signingSecret is set and body is a parsed object", async () => {
    const handler = createMuseRankPagesWebhook({
      accessToken: VALID_TOKEN,
      signingSecret: "secret",
      timestampToleranceMs: 0,
    });
    const req = makePagesReq(); // body is the object, not a raw string
    const { result, status } = makePagesRes();
    await handler(req, { status });
    expect(result.statusCode).toBe(400);
  });
});
