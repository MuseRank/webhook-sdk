/**
 * Tests for @muserank/webhook-sdk
 */

import { describe, it, expect, vi } from "vitest";
import {
  verifySignature,
  verifyBearerToken,
  verifyTimestamp,
  parseWebhookPayload,
  processWebhookEvent,
  createWebhookHandler,
  WebhookHandlerTimeoutError,
  WebhookProcessingError,
  WebhookVerificationError,
  DEFAULT_HANDLER_TIMEOUT_MS,
  DEFAULT_TIMESTAMP_TOLERANCE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
} from "./index";
import type { WebhookContext, WebhookPayload, WebhookConfig } from "./index";
import { createHmac } from "crypto";

const SAMPLE_EVENT_ID = "evt_article_1_published_2024-01-01T00:00:00Z";
const SAMPLE_DELIVERY_ID = "dlv_01HXTEST";

describe("verifySignature", () => {
  it("should verify a valid signature", async () => {
    const payload = JSON.stringify({ test: "data" });
    const secret = "test-secret";
    const signature =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");

    await expect(verifySignature(payload, signature, secret)).resolves.toBe(
      true,
    );
  });

  it("should reject an invalid signature", async () => {
    const payload = JSON.stringify({ test: "data" });
    const secret = "test-secret";
    const wrongSignature = "sha256=invalid";

    await expect(
      verifySignature(payload, wrongSignature, secret),
    ).resolves.toBe(false);
  });

  it("should handle signature without sha256= prefix", async () => {
    const payload = JSON.stringify({ test: "data" });
    const secret = "test-secret";
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    await expect(verifySignature(payload, signature, secret)).resolves.toBe(
      true,
    );
  });

  it("accepts the request when ANY secret in the array matches (rotation)", async () => {
    const payload = "rotated-body";
    const oldSecret = "whsec_old";
    const newSecret = "whsec_new";

    // Build a signature using the NEW secret; verify with both
    // configured (new first, old second) AND the reverse order to
    // make sure neither position is privileged.
    const sig =
      "sha256=" + createHmac("sha256", newSecret).update(payload).digest("hex");

    await expect(
      verifySignature(payload, sig, [newSecret, oldSecret]),
    ).resolves.toBe(true);
    await expect(
      verifySignature(payload, sig, [oldSecret, newSecret]),
    ).resolves.toBe(true);
  });

  it("rejects when no secret in the array matches", async () => {
    const sig =
      "sha256=" +
      createHmac("sha256", "right").update("body").digest("hex");

    await expect(
      verifySignature("body", sig, ["wrong1", "wrong2"]),
    ).resolves.toBe(false);
  });

  it("accepts when previous-secret signature is sent during rotation window", async () => {
    // Sender still on the old secret; receiver already rotated to
    // [new, old]. Verification must succeed against the second entry.
    const sig =
      "sha256=" + createHmac("sha256", "old").update("body").digest("hex");

    await expect(verifySignature("body", sig, ["new", "old"])).resolves.toBe(
      true,
    );
  });

  it("ignores empty / non-string entries in the secret array", async () => {
    const sig =
      "sha256=" + createHmac("sha256", "good").update("body").digest("hex");

    await expect(
      verifySignature("body", sig, ["", "good"]),
    ).resolves.toBe(true);
  });
});

describe("verifyBearerToken", () => {
  it("should verify a valid bearer token", () => {
    expect(verifyBearerToken("Bearer my-token", "my-token")).toBe(true);
  });

  it("should reject an invalid bearer token", () => {
    expect(verifyBearerToken("Bearer wrong-token", "my-token")).toBe(false);
  });

  it("should handle missing header", () => {
    expect(verifyBearerToken(null, "my-token")).toBe(false);
    expect(verifyBearerToken(undefined, "my-token")).toBe(false);
  });
});

describe("parseWebhookPayload", () => {
  function basePayload(overrides: Record<string, unknown> = {}) {
    return {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [] },
      ...overrides,
    };
  }

  it("should parse a valid JSON string", () => {
    const result = parseWebhookPayload(JSON.stringify(basePayload()));
    expect(result.event_type).toBe("article.published");
    expect(result.event_id).toBe(SAMPLE_EVENT_ID);
  });

  it("should accept an object directly", () => {
    const result = parseWebhookPayload(basePayload());
    expect(result.event_type).toBe("article.published");
  });

  it("preserves delivery_id when present", () => {
    const result = parseWebhookPayload(
      basePayload({ delivery_id: SAMPLE_DELIVERY_ID }),
    );
    expect(result.delivery_id).toBe(SAMPLE_DELIVERY_ID);
  });

  it("should throw on missing event_type", () => {
    const payload = {
      event_id: SAMPLE_EVENT_ID,
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [] },
    };
    expect(() => parseWebhookPayload(payload)).toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects payload missing event_id", () => {
    expect(() =>
      parseWebhookPayload({
        event_type: "article.published",
        timestamp: "2024-01-01T00:00:00Z",
        data: { articles: [] },
      }),
    ).toThrow(/Missing or invalid event_id/);
  });

  it("rejects empty event_id", () => {
    expect(() => parseWebhookPayload(basePayload({ event_id: "" }))).toThrow(
      /Missing or invalid event_id/,
    );
  });

  it("rejects non-string event_id", () => {
    expect(() =>
      parseWebhookPayload(basePayload({ event_id: 12345 })),
    ).toThrow(/Missing or invalid event_id/);
  });

  it("rejects oversized event_id (>255 chars)", () => {
    expect(() =>
      parseWebhookPayload(basePayload({ event_id: "x".repeat(256) })),
    ).toThrow(/Missing or invalid event_id/);
  });

  it("rejects empty delivery_id when the field is present", () => {
    expect(() =>
      parseWebhookPayload(basePayload({ delivery_id: "" })),
    ).toThrow(/Invalid delivery_id/);
  });

  it("rejects non-string delivery_id when the field is present", () => {
    expect(() =>
      parseWebhookPayload(basePayload({ delivery_id: 7 })),
    ).toThrow(/Invalid delivery_id/);
  });

  it("rejects event_id containing non-ASCII characters", () => {
    // The dispatcher contract guarantees a printable-ASCII opaque
    // identifier so receivers can put it in URL paths, HTTP headers,
    // and SQL UNIQUE columns without escaping. Emoji / CJK / accented
    // characters would break that assumption.
    for (const eventId of [
      "evt_💥_abc",
      "evt_中文_abc",
      "evt_café_abc",
      "evt_\u00a0_abc", // non-breaking space
    ]) {
      expect(() =>
        parseWebhookPayload(basePayload({ event_id: eventId })),
      ).toThrow(/Missing or invalid event_id/);
    }
  });

  it("rejects event_id containing whitespace or control chars", () => {
    for (const eventId of [
      "evt with space",
      "evt\twithtab",
      "evt\nwithnewline",
      "evt\x00withnul",
      "evt\x7fwithdel",
    ]) {
      expect(() =>
        parseWebhookPayload(basePayload({ event_id: eventId })),
      ).toThrow(/Missing or invalid event_id/);
    }
  });

  it("rejects delivery_id containing non-ASCII characters", () => {
    expect(() =>
      parseWebhookPayload(basePayload({ delivery_id: "dlv_💥_001" })),
    ).toThrow(/Invalid delivery_id/);
  });

  it("accepts the full printable-ASCII range in event_id and delivery_id", () => {
    // Sanity check — every printable ASCII char from `!` (0x21) to
    // `~` (0x7E) MUST round-trip without rejection. Catches an
    // accidental tightening of the regex (e.g. forgetting the `~`).
    let asciiId = "";
    for (let code = 0x21; code <= 0x7e; code += 1) {
      asciiId += String.fromCharCode(code);
    }
    expect(() =>
      parseWebhookPayload(
        basePayload({ event_id: asciiId, delivery_id: asciiId }),
      ),
    ).not.toThrow();
  });

  it("should throw on missing timestamp", () => {
    const payload = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.published",
      data: { articles: [] },
    };
    expect(() => parseWebhookPayload(payload)).toThrow(
      WebhookVerificationError,
    );
  });

  it("should throw on invalid json string", () => {
    expect(() => parseWebhookPayload("{not-valid-json")).toThrow(
      WebhookVerificationError,
    );
  });

  it("should throw on unsupported event type", () => {
    expect(() =>
      parseWebhookPayload(basePayload({ event_type: "article.deleted" })),
    ).toThrow(WebhookVerificationError);
  });

  it("should throw when data.articles is missing", () => {
    expect(() =>
      parseWebhookPayload(basePayload({ data: {} })),
    ).toThrow(WebhookVerificationError);
  });
});

describe("processWebhookEvent", () => {
  const mockArticle = {
    id: "article-1",
    title: "Test Article",
    content_markdown: "# Test",
    content_html: "<h1>Test</h1>",
    meta_description: "Test description",
    created_at: "2024-01-01T00:00:00Z",
    image_url: "https://example.com/image.jpg",
    slug: "test-article",
    tags: ["test"],
  };

  it("should call onArticlePublished handler with (article, payload, context)", async () => {
    const onArticlePublished = vi.fn();
    const config: WebhookConfig = {
      accessToken: "test",
      onArticlePublished,
    };

    const payload: WebhookPayload<"article.published"> = {
      event_id: SAMPLE_EVENT_ID,
      delivery_id: SAMPLE_DELIVERY_ID,
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    await processWebhookEvent(payload, config);

    expect(onArticlePublished).toHaveBeenCalledTimes(1);
    const call = onArticlePublished.mock.calls[0];
    expect(call[0]).toEqual(mockArticle);
    expect(call[1]).toBe(payload);
    const ctx = call[2] as WebhookContext;
    expect(ctx.eventId).toBe(SAMPLE_EVENT_ID);
    expect(ctx.deliveryId).toBe(SAMPLE_DELIVERY_ID);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it("should call onArticleUpdated handler", async () => {
    const onArticleUpdated = vi.fn();
    const config: WebhookConfig = {
      accessToken: "test",
      onArticleUpdated,
    };

    const payload: WebhookPayload<"article.updated"> = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.updated",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    await processWebhookEvent(payload, config);

    expect(onArticleUpdated).toHaveBeenCalledTimes(1);
    const call = onArticleUpdated.mock.calls[0];
    expect(call[0]).toEqual(mockArticle);
    expect(call[1]).toBe(payload);
    expect((call[2] as WebhookContext).eventId).toBe(SAMPLE_EVENT_ID);
  });

  it("should call onEvent handler for all events", async () => {
    const onEvent = vi.fn();
    const config: WebhookConfig = {
      accessToken: "test",
      onEvent,
    };

    const payload: WebhookPayload = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    await processWebhookEvent(payload, config);

    expect(onEvent).toHaveBeenCalledTimes(1);
    const call = onEvent.mock.calls[0];
    expect(call[0]).toBe("article.published");
    expect(call[1]).toBe(payload);
    expect((call[2] as WebhookContext).eventId).toBe(SAMPLE_EVENT_ID);
  });

  it("should call onError when handler throws", async () => {
    const error = new Error("Handler failed");
    const onArticlePublished = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const config: WebhookConfig = {
      accessToken: "test",
      onArticlePublished,
      onError,
    };

    const payload: WebhookPayload<"article.published"> = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    await expect(processWebhookEvent(payload, config)).rejects.toThrow(
      WebhookProcessingError,
    );
    expect(onError).toHaveBeenCalled();
  });

  it("attaches an onError-returned override onto WebhookProcessingError", async () => {
    const config: WebhookConfig = {
      accessToken: "test",
      onArticlePublished: async () => {
        throw new Error("DB violated unique constraint");
      },
      onError: () => ({
        statusCode: 200,
        message: "duplicate ignored",
        success: true,
      }),
    };

    const payload: WebhookPayload = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    try {
      await processWebhookEvent(payload, config);
      throw new Error("expected error to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookProcessingError);
      const override = (err as WebhookProcessingError).override;
      expect(override?.statusCode).toBe(200);
      expect(override?.success).toBe(true);
      expect(override?.message).toBe("duplicate ignored");
    }
  });

  it("ignores onError return values that are not valid overrides", async () => {
    const config: WebhookConfig = {
      accessToken: "test",
      onArticlePublished: async () => {
        throw new Error("boom");
      },
      // Common foot-guns: returning truthy non-objects, missing
      // statusCode, etc. Should NOT be treated as overrides.
      onError: () => "logged" as unknown as void,
    };

    const payload: WebhookPayload = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    try {
      await processWebhookEvent(payload, config);
      throw new Error("expected error to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookProcessingError);
      expect((err as WebhookProcessingError).override).toBeUndefined();
    }
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["0", 0],
    ["-1", -1],
    ["199 (below range)", 199],
    ["600 (above range)", 600],
    ["999999", 999_999],
    ["non-integer 200.5", 200.5],
  ])(
    "ignores onError statusCode override that is %s",
    async (_label, statusCode) => {
      // Without this validation, NaN / out-of-range codes flow into
      // res.status() / Response.json() and crash the adapter at
      // write time (Node throws "Invalid status code: NaN"; Response
      // throws RangeError). Falling back to undefined override means
      // the adapter uses the default 500 path.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const config: WebhookConfig = {
          accessToken: "test",
          onArticlePublished: async () => {
            throw new Error("boom");
          },
          onError: () => ({ statusCode: statusCode as number }),
        };
        const payload: WebhookPayload = {
          event_id: SAMPLE_EVENT_ID,
          event_type: "article.published",
          timestamp: "2024-01-01T00:00:00Z",
          data: { articles: [mockArticle] },
        };
        try {
          await processWebhookEvent(payload, config);
          throw new Error("expected error to be thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(WebhookProcessingError);
          expect((err as WebhookProcessingError).override).toBeUndefined();
        }
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("invalid statusCode"),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each([200, 204, 400, 404, 422, 500, 599])(
    "honors onError statusCode override that is in [200, 599]: %i",
    async (statusCode) => {
      const config: WebhookConfig = {
        accessToken: "test",
        onArticlePublished: async () => {
          throw new Error("boom");
        },
        onError: () => ({ statusCode }),
      };
      const payload: WebhookPayload = {
        event_id: SAMPLE_EVENT_ID,
        event_type: "article.published",
        timestamp: "2024-01-01T00:00:00Z",
        data: { articles: [mockArticle] },
      };

      try {
        await processWebhookEvent(payload, config);
        throw new Error("expected error to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(WebhookProcessingError);
        expect((err as WebhookProcessingError).override?.statusCode).toBe(
          statusCode,
        );
      }
    },
  );

  it("survives an onError handler that itself throws", async () => {
    const config: WebhookConfig = {
      accessToken: "test",
      onArticlePublished: async () => {
        throw new Error("primary");
      },
      onError: () => {
        throw new Error("secondary");
      },
    };

    const payload: WebhookPayload = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    // Caller must still see the primary error, not the onError throw.
    await expect(processWebhookEvent(payload, config)).rejects.toMatchObject({
      message: "primary",
    });
  });
});

describe("handlerTimeoutMs", () => {
  const mockArticle = {
    id: "1",
    title: "T",
    content_markdown: "",
    content_html: "",
    meta_description: "",
    created_at: "",
    image_url: "",
    slug: "",
    tags: [],
  };

  function payload(): WebhookPayload {
    return {
      event_id: SAMPLE_EVENT_ID,
      event_type: "article.published",
      timestamp: new Date().toISOString(),
      data: { articles: [mockArticle] },
    };
  }

  it("aborts a slow handler and throws WebhookHandlerTimeoutError", async () => {
    const onArticlePublished = vi.fn(
      (_a, _p, ctx: WebhookContext) =>
        new Promise<void>((_, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const config: WebhookConfig = {
      accessToken: "test",
      handlerTimeoutMs: 20,
      onArticlePublished,
    };

    await expect(processWebhookEvent(payload(), config)).rejects.toBeInstanceOf(
      WebhookHandlerTimeoutError,
    );
  });

  it("does NOT abort fast handlers", async () => {
    const onArticlePublished = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });

    const config: WebhookConfig = {
      accessToken: "test",
      handlerTimeoutMs: 200,
      onArticlePublished,
    };

    const result = await processWebhookEvent(payload(), config);
    expect(result.success).toBe(true);
    expect(onArticlePublished).toHaveBeenCalled();
  });

  it("disables timeout when handlerTimeoutMs is 0", async () => {
    const onArticlePublished = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    const config: WebhookConfig = {
      accessToken: "test",
      handlerTimeoutMs: 0,
      onArticlePublished,
    };

    const result = await processWebhookEvent(payload(), config);
    expect(result.success).toBe(true);
  });

  it("rejects negative handlerTimeoutMs", async () => {
    const config: WebhookConfig = {
      accessToken: "test",
      handlerTimeoutMs: -1,
      onArticlePublished: vi.fn(),
    };

    await expect(processWebhookEvent(payload(), config)).rejects.toThrow(
      "handlerTimeoutMs must be >= 0",
    );
  });

  it("DEFAULT_HANDLER_TIMEOUT_MS is 30s", () => {
    expect(DEFAULT_HANDLER_TIMEOUT_MS).toBe(30_000);
  });

  it("each article in a batch gets its own timer (no shared budget)", async () => {
    // Two articles, each handler sleeps 30ms, timeout is 60ms.
    // If they shared a single timer, the second would abort. They
    // shouldn't.
    const articles = [
      { ...mockArticle, id: "a" },
      { ...mockArticle, id: "b" },
    ];
    const seen: string[] = [];

    const config: WebhookConfig = {
      accessToken: "test",
      handlerTimeoutMs: 60,
      onArticlePublished: async (article) => {
        await new Promise((r) => setTimeout(r, 30));
        seen.push(article.id);
      },
    };

    const result = await processWebhookEvent(
      {
        event_id: SAMPLE_EVENT_ID,
        event_type: "article.published",
        timestamp: new Date().toISOString(),
        data: { articles },
      },
      config,
    );

    expect(result.articlesProcessed).toBe(2);
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("createWebhookHandler", () => {
  const validPayload: WebhookPayload = {
    event_id: SAMPLE_EVENT_ID,
    event_type: "article.published",
    timestamp: "2024-01-01T00:00:00Z",
    data: {
      articles: [
        {
          id: "1",
          title: "Test",
          content_markdown: "",
          content_html: "",
          meta_description: "",
          created_at: "",
          image_url: "",
          slug: "",
          tags: [],
        },
      ],
    },
  };

  it("should verify bearer token", async () => {
    const handler = createWebhookHandler({ accessToken: "my-token" });

    await expect(
      handler({
        headers: { authorization: "Bearer wrong-token" },
        body: validPayload,
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("should verify signature when secret is provided", async () => {
    const secret = "my-secret";
    const body = JSON.stringify(validPayload);
    const signature =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

    const handler = createWebhookHandler({
      accessToken: "my-token",
      signingSecret: secret,
      timestampToleranceMs: 0, // Disable for this test (validPayload has old timestamp)
    });

    const result = await handler({
      headers: {
        authorization: "Bearer my-token",
        "x-muserank-signature": signature,
      },
      body,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a signature from any secret in a rotated secrets array", async () => {
    const oldSecret = "whsec_old";
    const newSecret = "whsec_new";
    const body = JSON.stringify(validPayload);
    const sigFromOld =
      "sha256=" + createHmac("sha256", oldSecret).update(body).digest("hex");

    const handler = createWebhookHandler({
      accessToken: "my-token",
      signingSecret: [newSecret, oldSecret],
      timestampToleranceMs: 0,
    });

    const result = await handler({
      headers: {
        authorization: "Bearer my-token",
        "x-muserank-signature": sigFromOld,
      },
      body,
    });

    expect(result.success).toBe(true);
  });

  it("should require raw string body for signature verification", async () => {
    const handler = createWebhookHandler({
      accessToken: "my-token",
      signingSecret: "my-secret",
      timestampToleranceMs: 0,
    });

    await expect(
      handler({
        headers: {
          authorization: "Bearer my-token",
          "x-muserank-signature": "sha256=invalid",
        },
        body: validPayload,
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("should reject invalid signature", async () => {
    const handler = createWebhookHandler({
      accessToken: "my-token",
      signingSecret: "my-secret",
    });

    await expect(
      handler({
        headers: {
          authorization: "Bearer my-token",
          "x-muserank-signature": "sha256=invalid",
        },
        body: JSON.stringify(validPayload),
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("should process valid webhook", async () => {
    const onArticlePublished = vi.fn();
    const handler = createWebhookHandler({
      accessToken: "my-token",
      onArticlePublished,
      timestampToleranceMs: 0, // Disable for this test
    });

    const result = await handler({
      headers: { authorization: "Bearer my-token" },
      body: validPayload,
    });

    expect(result.success).toBe(true);
    expect(result.eventType).toBe("article.published");
    expect(onArticlePublished).toHaveBeenCalled();
  });

  it("should reject old timestamps (replay attack protection)", async () => {
    const oldPayload = {
      ...validPayload,
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
    };

    const handler = createWebhookHandler({
      accessToken: "my-token",
      timestampToleranceMs: 5 * 60 * 1000, // 5 minutes
    });

    await expect(
      handler({
        headers: { authorization: "Bearer my-token" },
        body: oldPayload,
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("should accept recent timestamps", async () => {
    const recentPayload = {
      ...validPayload,
      timestamp: new Date().toISOString(), // Now
    };

    const handler = createWebhookHandler({
      accessToken: "my-token",
      timestampToleranceMs: 5 * 60 * 1000,
    });

    const result = await handler({
      headers: { authorization: "Bearer my-token" },
      body: recentPayload,
    });

    expect(result.success).toBe(true);
  });

  it("should skip timestamp verification when tolerance is 0", async () => {
    const handler = createWebhookHandler({
      accessToken: "my-token",
      timestampToleranceMs: 0, // Disabled
    });

    const result = await handler({
      headers: { authorization: "Bearer my-token" },
      body: validPayload, // Has old timestamp
    });

    expect(result.success).toBe(true);
  });

  it("should reject payloads above max body size", async () => {
    const handler = createWebhookHandler({
      accessToken: "my-token",
      timestampToleranceMs: 0,
      maxBodySizeBytes: 20,
    });

    await expect(
      handler({
        headers: { authorization: "Bearer my-token" },
        body: JSON.stringify(validPayload),
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("should reject invalid json payload strings", async () => {
    const handler = createWebhookHandler({
      accessToken: "my-token",
      timestampToleranceMs: 0,
    });

    await expect(
      handler({
        headers: { authorization: "Bearer my-token" },
        body: "{invalid-json",
      }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it("should include status code for verification errors", async () => {
    const handler = createWebhookHandler({
      accessToken: "my-token",
      timestampToleranceMs: 0,
      maxBodySizeBytes: 10,
    });

    expect.hasAssertions();

    try {
      await handler({
        headers: { authorization: "Bearer my-token" },
        body: JSON.stringify(validPayload),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookVerificationError);
      expect((error as WebhookVerificationError).statusCode).toBe(413);
    }
  });

  it("rejects an empty signingSecret array at handler creation", () => {
    // Empty arrays are TRUTHY in JS, so without this guard the
    // handler would silently fail every request with 401 (the
    // verifySignature loop iterates zero candidates and returns
    // false). Catch the misconfiguration at config time instead.
    expect(() =>
      createWebhookHandler({
        accessToken: "my-token",
        signingSecret: [],
      }),
    ).toThrow(/signingSecret array must not be empty/);
  });

  it("rejects a signingSecret array of all-empty / non-string entries", () => {
    expect(() =>
      createWebhookHandler({
        accessToken: "my-token",
        signingSecret: ["", ""],
      }),
    ).toThrow(/at least one non-empty string/);

    expect(() =>
      createWebhookHandler({
        accessToken: "my-token",
        signingSecret: [
          "",
          undefined as unknown as string,
          null as unknown as string,
        ],
      }),
    ).toThrow(/at least one non-empty string/);
  });

  it("accepts a signingSecret array with at least one non-empty entry", () => {
    // ['', 'real_secret'] is a legitimate config — e.g. an env-var
    // driven array where the previous slot is intentionally blank
    // outside a rotation window. As long as one usable entry exists,
    // the handler should construct cleanly.
    expect(() =>
      createWebhookHandler({
        accessToken: "my-token",
        signingSecret: ["", "real_secret"],
      }),
    ).not.toThrow();

    expect(() =>
      createWebhookHandler({
        accessToken: "my-token",
        signingSecret: ["whsec_a", "whsec_b"],
      }),
    ).not.toThrow();
  });
});

describe("verifyTimestamp", () => {
  it("should accept timestamp within tolerance", () => {
    const now = new Date().toISOString();
    expect(verifyTimestamp(now, 5 * 60 * 1000)).toBe(true);
  });

  it("should reject timestamp outside tolerance", () => {
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    expect(verifyTimestamp(old, 5 * 60 * 1000)).toBe(false);
  });

  it("should skip verification when tolerance is 0", () => {
    const veryOld = new Date(0).toISOString(); // 1970
    expect(verifyTimestamp(veryOld, 0)).toBe(true);
  });

  it("should use default tolerance", () => {
    const now = new Date().toISOString();
    expect(verifyTimestamp(now)).toBe(true);
    expect(DEFAULT_TIMESTAMP_TOLERANCE_MS).toBe(5 * 60 * 1000);
  });

  it("should handle invalid timestamp", () => {
    expect(verifyTimestamp("not-a-date", 5000)).toBe(false);
  });

  it("should accept timestamp slightly in the future (clock skew)", () => {
    const slightlyFuture = new Date(
      Date.now() + CLOCK_SKEW_TOLERANCE_MS - 1000,
    ).toISOString();
    expect(verifyTimestamp(slightlyFuture, 5 * 60 * 1000)).toBe(true);
  });

  it("should reject timestamp too far in the future", () => {
    const farFuture = new Date(
      Date.now() + CLOCK_SKEW_TOLERANCE_MS + 5000,
    ).toISOString();
    expect(verifyTimestamp(farFuture, 5 * 60 * 1000)).toBe(false);
  });
});

describe("verifyBearerToken security", () => {
  it("should use constant-time comparison", () => {
    // This test verifies the function works correctly
    // Actual timing attack resistance requires benchmarking
    expect(verifyBearerToken("Bearer correct-token", "correct-token")).toBe(
      true,
    );
    expect(verifyBearerToken("Bearer wrong-token", "correct-token")).toBe(
      false,
    );
  });

  it("should handle different length tokens", () => {
    expect(verifyBearerToken("Bearer short", "longer-token")).toBe(false);
    expect(verifyBearerToken("Bearer very-long-token-here", "short")).toBe(
      false,
    );
  });
});

describe("test.ping handling", () => {
  it("should handle test.ping without handler", async () => {
    const config: WebhookConfig = {
      accessToken: "test",
      // No onTestPing handler
    };

    const payload: WebhookPayload<"test.ping"> = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "test.ping",
      timestamp: new Date().toISOString(),
      data: { articles: [] },
    };

    const result = await processWebhookEvent(payload, config);

    expect(result.success).toBe(true);
    expect(result.eventType).toBe("test.ping");
  });

  it("should call onTestPing handler when provided", async () => {
    const onTestPing = vi.fn();
    const config: WebhookConfig = {
      accessToken: "test",
      onTestPing,
    };

    const payload: WebhookPayload<"test.ping"> = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "test.ping",
      timestamp: new Date().toISOString(),
      data: { articles: [] },
    };

    await processWebhookEvent(payload, config);

    expect(onTestPing).toHaveBeenCalledTimes(1);
    const call = onTestPing.mock.calls[0];
    expect(call[0]).toBe(payload);
    expect((call[1] as WebhookContext).eventId).toBe(SAMPLE_EVENT_ID);
  });

  it("should log test.ping in debug mode without handler", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const config: WebhookConfig = {
      accessToken: "test",
      debug: true,
      // No onTestPing handler
    };

    const payload: WebhookPayload<"test.ping"> = {
      event_id: SAMPLE_EVENT_ID,
      event_type: "test.ping",
      timestamp: new Date().toISOString(),
      data: { articles: [] },
    };

    await processWebhookEvent(payload, config);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Test ping received"),
    );
    consoleSpy.mockRestore();
  });
});
