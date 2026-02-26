/**
 * Tests for @muserank/webhook-sdk/web
 *
 * Covers the Web/Fetch API adapter layer on top of the core handler.
 */

import { describe, it, expect } from "vitest";
import { createMuseRankWebhook } from "./web";
import type { WebhookPayload } from "./web";

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
  body?: string | null;
  /** When provided, REPLACES the default headers entirely. */
  headers?: Record<string, string>;
}): Request {
  const method = options?.method ?? "POST";
  // GET/HEAD requests may not carry a body (spec requirement)
  const canHaveBody = method !== "GET" && method !== "HEAD";
  const body = canHaveBody
    ? options?.body === undefined
      ? JSON.stringify(validPayload)
      : (options.body ?? undefined)
    : undefined;

  return new Request("https://example.com/api/webhooks/muserank", {
    method,
    body: body ?? undefined,
    headers: options?.headers ?? {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("web adapter – createMuseRankWebhook", () => {
  it("returns 405 for non-POST requests", async () => {
    const handler = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    const res = await handler(makeRequest({ method: "GET" }));
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const handler = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    // Pass headers without `authorization` to simulate missing header
    const res = await handler(
      makeRequest({ headers: { "content-type": "application/json" } }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 401 when Authorization token is wrong", async () => {
    const handler = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    const res = await handler(
      makeRequest({
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed JSON", async () => {
    const handler = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
    });
    const res = await handler(makeRequest({ body: "{not-valid" }));
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
  });

  it("returns 413 when payload exceeds maxBodySizeBytes", async () => {
    const handler = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      maxBodySizeBytes: 10,
    });
    const res = await handler(makeRequest());
    expect(res.status).toBe(413);
  });

  it("calls onArticlePublished handler", async () => {
    let received: string | undefined;
    const handler = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
      onArticlePublished: (article) => {
        received = article.title;
      },
    });
    const res = await handler(makeRequest());
    expect(res.status).toBe(200);
    expect(received).toBe("Test article");
  });

  it("returns 500 when event handler throws", async () => {
    // onArticlePublished errors are wrapped as WebhookProcessingError → 500 JSON
    const handler = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
      onArticlePublished: async () => {
        throw new Error("DB error");
      },
    });
    const res = await handler(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("throws at construction when maxBodySizeBytes is negative", () => {
    expect(() =>
      createMuseRankWebhook({ accessToken: VALID_TOKEN, maxBodySizeBytes: -1 }),
    ).toThrow();
  });
});
