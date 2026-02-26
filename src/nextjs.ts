/**
 * @muserank/webhook-sdk/nextjs
 *
 * Next.js App Router adapter for MuseRank webhooks.
 * Works with both Route Handlers (app/) and API Routes (pages/api/).
 */

import {
  createWebhookHandler,
  DEFAULT_MAX_BODY_SIZE_BYTES,
  WebhookVerificationError,
  WebhookProcessingError,
} from "./index";
import type { WebhookConfig } from "./index";
import {
  enforceBodyStringLimit,
  enforceBodyObjectLimit,
  readFetchBodyWithLimit,
  readNodeBodyWithLimit,
} from "./_internal";
import type { NodeBodyStream } from "./_internal";

export * from "./index";

/**
 * Create a Next.js App Router webhook handler
 *
 * @example
 * ```typescript
 * // app/api/webhooks/muserank/route.ts
 * import { createMuseRankWebhook } from '@muserank/webhook-sdk/nextjs';
 *
 * export const POST = createMuseRankWebhook({
 *   accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
 *   onArticlePublished: async (article) => {
 *     await db.articles.create({
 *       data: {
 *         externalId: article.id,
 *         title: article.title,
 *         content: article.content_html,
 *         slug: article.slug,
 *       },
 *     });
 *   },
 * });
 * ```
 */
export function createMuseRankWebhook(config: WebhookConfig) {
  const handler = createWebhookHandler(config);
  const maxBodySizeBytes =
    config.maxBodySizeBytes ?? DEFAULT_MAX_BODY_SIZE_BYTES;

  if (maxBodySizeBytes < 0) {
    throw new Error("maxBodySizeBytes must be >= 0");
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json(
        { success: false, error: "Method not allowed" },
        { status: 405 },
      );
    }

    try {
      // Parse request body
      const body = await readFetchBodyWithLimit(request, maxBodySizeBytes);

      // Get headers
      const headers: Record<string, string | undefined> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      // Process webhook
      const result = await handler({
        headers,
        body,
      });

      return Response.json(result, { status: 200 });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return Response.json(
          { success: false, error: error.message },
          { status: error.statusCode },
        );
      }

      if (error instanceof WebhookProcessingError) {
        return Response.json(
          { success: false, error: error.message },
          { status: 500 },
        );
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      return Response.json({ success: false, error: message }, { status: 500 });
    }
  };
}

/**
 * Create a Next.js Pages API Route webhook handler
 *
 * @example
 * ```typescript
 * // pages/api/webhooks/muserank.ts
 * import { createMuseRankPagesWebhook } from '@muserank/webhook-sdk/nextjs';
 *
 * export default createMuseRankPagesWebhook({
 *   accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
 *   onArticlePublished: async (article) => {
 *     // Handle article
 *   },
 * });
 *
 * export const config = {
 *   api: { bodyParser: false }, // Required for raw body access
 * };
 * ```
 */
export function createMuseRankPagesWebhook(config: WebhookConfig) {
  const handler = createWebhookHandler(config);
  const maxBodySizeBytes =
    config.maxBodySizeBytes ?? DEFAULT_MAX_BODY_SIZE_BYTES;

  if (maxBodySizeBytes < 0) {
    throw new Error("maxBodySizeBytes must be >= 0");
  }

  return async (
    req: {
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      method?: string;
    },
    res: { status: (code: number) => { json: (body: object) => void } },
  ): Promise<void> => {
    // Only allow POST requests
    if (req.method !== "POST") {
      res.status(405).json({ success: false, error: "Method not allowed" });
      return;
    }

    try {
      // Get headers (normalize to single values)
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
      }

      // Get body (may need to read from raw stream if bodyParser is disabled)
      let body: string | object;
      if (typeof req.body === "string") {
        body = req.body;
        enforceBodyStringLimit(body, maxBodySizeBytes);
      } else if (req.body && typeof req.body === "object") {
        if (config.signingSecret) {
          throw new WebhookVerificationError(
            "Raw request body is required for signature verification",
            400,
          );
        }

        body = req.body;
        enforceBodyObjectLimit(body, maxBodySizeBytes);
      } else {
        // Body parser was disabled – read from the raw stream
        body = await readNodeBodyWithLimit(
          req as unknown as NodeBodyStream,
          maxBodySizeBytes,
        );
      }

      // Process webhook
      const result = await handler({ headers, body });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        res
          .status(error.statusCode)
          .json({ success: false, error: error.message });
        return;
      }

      if (error instanceof WebhookProcessingError) {
        res.status(500).json({ success: false, error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ success: false, error: message });
    }
  };
}

/**
 * Utility type for extracting article type
 */
export type { WebhookArticle, WebhookPayload, WebhookEventType } from "./index";
