/**
 * Type-level tests.
 *
 * These don't assert runtime behavior — vitest only ever calls
 * `expect.hasAssertions()` here so the file participates in the suite.
 * The real value is in `expectTypeOf` calls: tsc is the test runner,
 * the suite passes iff `bun run typecheck` passes. They guard against
 * a future refactor silently widening / narrowing the public surface
 * (e.g. someone changing `event_id` from required to optional, or
 * adding a third positional arg to a handler signature).
 */

import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  WebhookArticle,
  WebhookConfig,
  WebhookContext,
  WebhookErrorOverride,
  WebhookEventType,
  WebhookPayload,
  WebhookResult,
} from "./index";
import {
  WebhookHandlerTimeoutError,
  WebhookProcessingError,
  WebhookVerificationError,
} from "./index";

describe("public type surface (compile-time)", () => {
  it("WebhookEventType is the closed union of all 5 supported events", () => {
    expectTypeOf<WebhookEventType>().toEqualTypeOf<
      | "article.published"
      | "article.updated"
      | "article.scheduled"
      | "article.failed"
      | "test.ping"
    >();
    expect(true).toBe(true);
  });

  it("WebhookPayload requires event_id as a string", () => {
    expectTypeOf<WebhookPayload>().toHaveProperty("event_id").toEqualTypeOf<string>();
    // Required: this construction must compile.
    const p: WebhookPayload = {
      event_id: "evt_1",
      event_type: "article.published",
      timestamp: new Date().toISOString(),
      data: { articles: [] },
    };
    expect(p.event_id).toBe("evt_1");
  });

  it("WebhookPayload.delivery_id is optional", () => {
    expectTypeOf<WebhookPayload>().toHaveProperty("delivery_id").toEqualTypeOf<
      string | undefined
    >();
    const withoutDelivery: WebhookPayload = {
      event_id: "evt_1",
      event_type: "article.published",
      timestamp: new Date().toISOString(),
      data: { articles: [] },
    };
    expect(withoutDelivery.delivery_id).toBeUndefined();
  });

  it("WebhookContext exposes eventId / deliveryId / signal", () => {
    expectTypeOf<WebhookContext["eventId"]>().toEqualTypeOf<string>();
    expectTypeOf<WebhookContext["deliveryId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<WebhookContext["signal"]>().toEqualTypeOf<AbortSignal>();
    expect(true).toBe(true);
  });

  it("each on*Article handler accepts (article, payload, ctx)", () => {
    expectTypeOf<NonNullable<WebhookConfig["onArticlePublished"]>>().parameters.toEqualTypeOf<
      [WebhookArticle, WebhookPayload<"article.published">, WebhookContext]
    >();
    expectTypeOf<NonNullable<WebhookConfig["onArticleUpdated"]>>().parameters.toEqualTypeOf<
      [WebhookArticle, WebhookPayload<"article.updated">, WebhookContext]
    >();
    expectTypeOf<NonNullable<WebhookConfig["onArticleScheduled"]>>().parameters.toEqualTypeOf<
      [WebhookArticle, WebhookPayload<"article.scheduled">, WebhookContext]
    >();
    expectTypeOf<NonNullable<WebhookConfig["onArticleFailed"]>>().parameters.toEqualTypeOf<
      [WebhookArticle, WebhookPayload<"article.failed">, WebhookContext]
    >();
    expect(true).toBe(true);
  });

  it("onTestPing accepts (payload, ctx) — no article", () => {
    expectTypeOf<NonNullable<WebhookConfig["onTestPing"]>>().parameters.toEqualTypeOf<
      [WebhookPayload<"test.ping">, WebhookContext]
    >();
    expect(true).toBe(true);
  });

  it("onEvent accepts (eventType, payload, ctx)", () => {
    expectTypeOf<NonNullable<WebhookConfig["onEvent"]>>().parameters.toEqualTypeOf<
      [WebhookEventType, WebhookPayload, WebhookContext]
    >();
    expect(true).toBe(true);
  });

  it("signingSecret is string | readonly string[] | undefined", () => {
    expectTypeOf<WebhookConfig["signingSecret"]>().toEqualTypeOf<
      string | readonly string[] | undefined
    >();
    // Both invocations must compile.
    const single: WebhookConfig = { accessToken: "t", signingSecret: "whsec_a" };
    const multi: WebhookConfig = {
      accessToken: "t",
      signingSecret: ["whsec_a", "whsec_b"],
    };
    expect(single.accessToken).toBe("t");
    expect(multi.accessToken).toBe("t");
  });

  it("onError can return WebhookErrorOverride or void (sync or async)", () => {
    type Return = ReturnType<NonNullable<WebhookConfig["onError"]>>;
    expectTypeOf<Return>().toEqualTypeOf<
      | Promise<WebhookErrorOverride | void>
      | WebhookErrorOverride
      | void
    >();
    expect(true).toBe(true);
  });

  it("WebhookErrorOverride.statusCode is required, success/message optional", () => {
    expectTypeOf<WebhookErrorOverride["statusCode"]>().toEqualTypeOf<number>();
    expectTypeOf<WebhookErrorOverride["success"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<WebhookErrorOverride["message"]>().toEqualTypeOf<string | undefined>();
    expect(true).toBe(true);
  });

  it("error subclasses extend the right base", () => {
    expectTypeOf<WebhookHandlerTimeoutError>().toMatchTypeOf<WebhookProcessingError>();
    expectTypeOf<WebhookVerificationError>().toHaveProperty("statusCode").toEqualTypeOf<number>();
    expect(true).toBe(true);
  });

  it("WebhookResult shape stays stable", () => {
    expectTypeOf<WebhookResult>().toEqualTypeOf<{
      success: boolean;
      message: string;
      eventType?: WebhookEventType;
      articlesProcessed?: number;
    }>();
    expect(true).toBe(true);
  });
});
