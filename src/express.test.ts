/**
 * Tests for @muserank/webhook-sdk/express
 *
 * Covers the Express adapter layer on top of the core handler.
 */

import { describe, it, expect, vi } from "vitest";
import {
    createMuseRankWebhook,
    createRawBodyVerifier,
    rawBodyMiddleware,
    WebhookVerificationError,
} from "./express";
import type { WebhookPayload } from "./express";
import { createHmac } from "crypto";

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

type MockReq = {
  method: string;
  headers: Record<string, string>;
  body?: object | string;
  rawBody?: Buffer;
};

type ResResult = { statusCode: number; body: object };

function makeReq(options?: {
  method?: string;
  body?: object | string;
  /** When provided, REPLACES the default headers entirely. */
  headers?: Record<string, string>;
  rawBody?: Buffer;
}): MockReq {
  return {
    method: options?.method ?? "POST",
    headers: (options?.headers ?? {
      "content-type": "application/json",
      authorization: `Bearer ${VALID_TOKEN}`,
    }) as Record<string, string>,
    body: options?.body ?? validPayload,
    rawBody: options?.rawBody,
  };
}

function makeRes(): { result: ResResult; res: ReturnType<typeof buildRes> } {
  const result: ResResult = { statusCode: 0, body: {} };

  /**
   * Minimal Express-response-compatible mock where `status(code)` records
   * the code and returns the same object, enabling `.json()` chaining.
   */
  function buildRes() {
    const mock = {
      status(code: number) {
        result.statusCode = code;
        return mock; // enables res.status(200).json(body)
      },
      json(body: object) {
        result.body = body;
      },
    };
    return mock;
  }

  return { result, res: buildRes() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("express adapter – createMuseRankWebhook", () => {
  it("responds 405 for non-POST requests", async () => {
    const middleware = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    const next = vi.fn();
    const { result, res } = makeRes();
    await middleware(makeReq({ method: "GET" }), res, next);
    expect(result.statusCode).toBe(405);
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 when Authorization header is missing", async () => {
    const middleware = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    const next = vi.fn();
    const { result, res } = makeRes();
    await middleware(
      makeReq({ headers: { "content-type": "application/json" } }),
      res,
      next,
    );
    expect(result.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 when token is wrong", async () => {
    const middleware = createMuseRankWebhook({ accessToken: VALID_TOKEN });
    const next = vi.fn();
    const { result, res } = makeRes();
    await middleware(
      makeReq({ headers: { authorization: "Bearer wrong" } }),
      res,
      next,
    );
    expect(result.statusCode).toBe(401);
  });

  it("responds 200 for a valid webhook (object body)", async () => {
    const middleware = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
    });
    const next = vi.fn();
    const { result, res } = makeRes();
    await middleware(makeReq(), res, next);
    expect(result.statusCode).toBe(200);
    expect((result.body as { success: boolean }).success).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 200 when body is a raw JSON string", async () => {
    const middleware = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
    });
    const next = vi.fn();
    const { result, res } = makeRes();
    await middleware(
      makeReq({ body: JSON.stringify(validPayload) }),
      res,
      next,
    );
    expect(result.statusCode).toBe(200);
  });

    it("responds 400 when signingSecret is set but body is a parsed object", async () => {
        const middleware = createMuseRankWebhook({
            accessToken: VALID_TOKEN,
            signingSecret: "secret",
            timestampToleranceMs: 0,
    });
    const next = vi.fn();
    const { result, res } = makeRes();
        await middleware(makeReq(), res, next);
        expect(result.statusCode).toBe(400);
    });

    it("responds 200 when signingSecret is set and rawBody is provided", async () => {
        const secret = "secret";
        const rawBody = JSON.stringify(validPayload);
        const signature =
            "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");

        const middleware = createMuseRankWebhook({
            accessToken: VALID_TOKEN,
            signingSecret: secret,
            timestampToleranceMs: 0,
        });

        const next = vi.fn();
        const { result, res } = makeRes();

        await middleware(
            makeReq({
                body: validPayload,
                rawBody: Buffer.from(rawBody),
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${VALID_TOKEN}`,
                    "x-muserank-signature": signature,
                },
            }),
            res,
            next
        );

        expect(result.statusCode).toBe(200);
        expect((result.body as { success: boolean }).success).toBe(true);
        expect(next).not.toHaveBeenCalled();
    });

  it("responds 500 JSON when event handler throws, without calling next", async () => {
    // onArticlePublished errors are wrapped as WebhookProcessingError and
    // converted to a 500 JSON response by the adapter.  `next` is only
    // called for truly unexpected errors that escape both error types.
    const middleware = createMuseRankWebhook({
      accessToken: VALID_TOKEN,
      timestampToleranceMs: 0,
      onArticlePublished: async () => {
        throw new Error("unexpected");
      },
    });
    const next = vi.fn();
    const { result, res } = makeRes();
    await middleware(makeReq(), res, next);
    expect(result.statusCode).toBe(500);
    expect((result.body as { success: boolean }).success).toBe(false);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("express adapter – rawBodyMiddleware", () => {
    it("captures raw body and parses JSON from a request stream", () => {
        const body = JSON.stringify(validPayload);
        const listeners: Partial<Record<"data" | "end" | "error", (...args: unknown[]) => void>> = {};
        const req = {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
            },
            on: vi.fn((event: "data" | "end" | "error", fn: (...args: unknown[]) => void) => {
                listeners[event] = fn;
            }),
        };
        const res = {};
        const next = vi.fn();

        rawBodyMiddleware(req as never, res as never, next);

        listeners.data?.(Buffer.from(body));
        listeners.end?.();

        expect(next).toHaveBeenCalledTimes(1);
        expect((req as { rawBody?: Buffer }).rawBody?.toString("utf-8")).toBe(body);
        expect((req as { body?: unknown }).body).toEqual(validPayload);
    });

    it("can be used directly as a middleware (no options)", () => {
        // Calling with three args should not throw; it should call next()
        const req = {
            method: "POST",
            headers: { "content-type": "application/json" },
      on: vi.fn(),
    };
    const res = {};
    const next = vi.fn();

    // Provide a minimal on() that immediately fires "end"
    req.on.mockImplementation((event: string, fn: () => void) => {
      if (event === "end") fn();
    });

    rawBodyMiddleware(req as never, res as never, next);

    expect(next).toHaveBeenCalled();
  });

    it("can be called as a factory and returns a middleware function", () => {
        const middleware = rawBodyMiddleware({ maxBodySizeBytes: 1024 });
        expect(typeof middleware).toBe("function");
    });
});

describe("express adapter – createRawBodyVerifier", () => {
    it("stores rawBody for downstream signature verification", () => {
        const verify = createRawBodyVerifier();
        const req: { rawBody?: Buffer } = {};
        const buf = Buffer.from(JSON.stringify(validPayload));

        verify(req as never, {} as never, buf, "utf-8");

        expect(req.rawBody).toBeDefined();
        expect(req.rawBody?.equals(buf)).toBe(true);
    });

    it("throws 413 when payload exceeds configured size", () => {
        const verify = createRawBodyVerifier({ maxBodySizeBytes: 4 });
        const req: { rawBody?: Buffer } = {};

        expect(() =>
            verify(req as never, {} as never, Buffer.from("12345"), "utf-8")
        ).toThrow(WebhookVerificationError);
    });
});
