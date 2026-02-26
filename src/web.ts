/**
 * @muserank/webhook-sdk/web
 *
 * Standard Web API adapter for MuseRank webhooks.
 * Works with any framework that uses the standard Request/Response APIs:
 * - Remix
 * - Astro
 * - SvelteKit
 * - Deno
 * - Bun
 * - Cloudflare Workers
 * - Next.js App Router (also available via /nextjs)
 */

import {
  createWebhookHandler,
  DEFAULT_MAX_BODY_SIZE_BYTES,
  WebhookVerificationError,
  WebhookProcessingError,
} from "./index";
import type { WebhookConfig } from "./index";
import { readFetchBodyWithLimit } from "./_internal";

export * from "./index";

/**
 * Create a webhook handler using the standard Web Request/Response API.
 *
 * This works with:
 * - Remix (action functions)
 * - Astro (API routes)
 * - SvelteKit (server routes)
 * - Deno (native)
 * - Bun (native)
 * - Cloudflare Workers
 * - Next.js App Router
 *
 * @example Remix
 * ```typescript
 * // app/routes/api.webhooks.muserank.tsx
 * import { createMuseRankWebhook } from '@muserank/webhook-sdk/web';
 *
 * const handler = createMuseRankWebhook({
 *   accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
 *   onArticlePublished: async (article) => {
 *     // Handle article
 *   },
 * });
 *
 * export const action = async ({ request }: { request: Request }) => {
 *   return handler(request);
 * };
 * ```
 *
 * @example Astro
 * ```typescript
 * // src/pages/api/webhooks/muserank.ts
 * import type { APIRoute } from 'astro';
 * import { createMuseRankWebhook } from '@muserank/webhook-sdk/web';
 *
 * const handler = createMuseRankWebhook({
 *   accessToken: import.meta.env.MUSERANK_WEBHOOK_TOKEN,
 *   onArticlePublished: async (article) => {
 *     // Handle article
 *   },
 * });
 *
 * export const POST: APIRoute = async ({ request }) => {
 *   return handler(request);
 * };
 * ```
 *
 * @example SvelteKit
 * ```typescript
 * // src/routes/api/webhooks/muserank/+server.ts
 * import { createMuseRankWebhook } from '@muserank/webhook-sdk/web';
 * import { MUSERANK_WEBHOOK_TOKEN } from '$env/static/private';
 *
 * const handler = createMuseRankWebhook({
 *   accessToken: MUSERANK_WEBHOOK_TOKEN,
 *   onArticlePublished: async (article) => {
 *     // Handle article
 *   },
 * });
 *
 * export const POST = async ({ request }) => {
 *   return handler(request);
 * };
 * ```
 *
 * @example Cloudflare Workers
 * ```typescript
 * import { createMuseRankWebhook } from '@muserank/webhook-sdk/web';
 *
 * const handler = createMuseRankWebhook({
 *   accessToken: 'your-token',
 *   onArticlePublished: async (article) => {
 *     // Handle article
 *   },
 * });
 *
 * export default {
 *   async fetch(request: Request) {
 *     if (request.method === 'POST') {
 *       return handler(request);
 *     }
 *     return new Response('Method not allowed', { status: 405 });
 *   },
 * };
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
    // Validate HTTP method
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ success: false, error: "Method not allowed" }),
        {
          status: 405,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    try {
      // Parse request body (preserves raw bytes for signature verification)
      const body = await readFetchBodyWithLimit(request, maxBodySizeBytes);

      // Get headers as a plain object
      const headers: Record<string, string | undefined> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      // Process webhook
      const result = await handler({
        headers,
        body,
      });

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          {
            status: error.statusCode,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (error instanceof WebhookProcessingError) {
        return new Response(
          JSON.stringify({ success: false, error: error.message }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      return new Response(JSON.stringify({ success: false, error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}

/**
 * Utility types
 */
export type {
  WebhookArticle,
  WebhookPayload,
  WebhookEventType,
  WebhookConfig,
  WebhookResult,
} from "./index";
