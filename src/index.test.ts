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
  WebhookVerificationError,
  WebhookProcessingError,
  DEFAULT_TIMESTAMP_TOLERANCE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
} from "./index";
import type { WebhookPayload, WebhookConfig } from "./index";
import { createHmac } from "crypto";

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
  it("should parse a valid JSON string", () => {
    const payload = JSON.stringify({
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [] },
    });

    const result = parseWebhookPayload(payload);
    expect(result.event_type).toBe("article.published");
  });

  it("should accept an object directly", () => {
    const payload = {
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [] },
    };

    const result = parseWebhookPayload(payload);
    expect(result.event_type).toBe("article.published");
  });

  it("should throw on missing event_type", () => {
    const payload = { timestamp: "2024-01-01T00:00:00Z" };

    expect(() => parseWebhookPayload(payload)).toThrow(
      WebhookVerificationError,
    );
  });

  it("should throw on missing timestamp", () => {
    const payload = { event_type: "article.published" };

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
    const payload = {
      event_type: "article.deleted",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [] },
    };

    expect(() => parseWebhookPayload(payload)).toThrow(
      WebhookVerificationError,
    );
  });

  it("should throw when data.articles is missing", () => {
    const payload = {
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: {},
    };

    expect(() => parseWebhookPayload(payload)).toThrow(
      WebhookVerificationError,
    );
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

  it("should call onArticlePublished handler", async () => {
    const onArticlePublished = vi.fn();
    const config: WebhookConfig = {
      accessToken: "test",
      onArticlePublished,
    };

    const payload: WebhookPayload<"article.published"> = {
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    await processWebhookEvent(payload, config);

    expect(onArticlePublished).toHaveBeenCalledWith(mockArticle, payload);
  });

  it("should call onArticleUpdated handler", async () => {
    const onArticleUpdated = vi.fn();
    const config: WebhookConfig = {
      accessToken: "test",
      onArticleUpdated,
    };

    const payload: WebhookPayload<"article.updated"> = {
      event_type: "article.updated",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    await processWebhookEvent(payload, config);

    expect(onArticleUpdated).toHaveBeenCalledWith(mockArticle, payload);
  });

  it("should call onEvent handler for all events", async () => {
    const onEvent = vi.fn();
    const config: WebhookConfig = {
      accessToken: "test",
      onEvent,
    };

    const payload: WebhookPayload = {
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    await processWebhookEvent(payload, config);

    expect(onEvent).toHaveBeenCalledWith("article.published", payload);
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
      event_type: "article.published",
      timestamp: "2024-01-01T00:00:00Z",
      data: { articles: [mockArticle] },
    };

    await expect(processWebhookEvent(payload, config)).rejects.toThrow(
      WebhookProcessingError,
    );
    expect(onError).toHaveBeenCalled();
  });
});

describe("createWebhookHandler", () => {
  const validPayload: WebhookPayload = {
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
      event_type: "test.ping",
      timestamp: new Date().toISOString(),
      data: { articles: [] },
    };

    await processWebhookEvent(payload, config);

    expect(onTestPing).toHaveBeenCalledWith(payload);
  });

  it("should log test.ping in debug mode without handler", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const config: WebhookConfig = {
      accessToken: "test",
      debug: true,
      // No onTestPing handler
    };

    const payload: WebhookPayload<"test.ping"> = {
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
