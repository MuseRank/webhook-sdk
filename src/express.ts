/**
 * @muserank/webhook-sdk/express
 *
 * Express.js adapter for MuseRank webhooks.
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
  readNodeBodyWithLimit,
} from "./_internal";
import type { NodeBodyStream } from "./_internal";

export * from "./index";

/**
 * Minimal Express-compatible request interface.
 * Uses specific `on` overloads instead of `any` to remain type-safe.
 */
interface ExpressRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  method?: string;
  rawBody?: string | Buffer;
  on?(event: "data", fn: (chunk: Buffer) => void): void;
  on?(event: "end", fn: () => void): void;
  on?(event: "error", fn: (err: Error) => void): void;
}

/**
 * Express Response type
 */
interface ExpressResponse {
  status: (code: number) => ExpressResponse;
  json: (body: object) => void;
}

/**
 * Express Next function type
 */
type ExpressNext = (error?: Error) => void;

/**
 * Create an Express.js webhook middleware
 *
 * @example
 * ```typescript
 * // With express.json() middleware (recommended)
 * import express from 'express';
 * import { createMuseRankWebhook } from '@muserank/webhook-sdk/express';
 *
 * const app = express();
 * app.use(express.json());
 *
 * app.post('/api/webhooks/muserank', createMuseRankWebhook({
 *   accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
 *   onArticlePublished: async (article) => {
 *     await Article.create({
 *       externalId: article.id,
 *       title: article.title,
 *       content: article.content_html,
 *     });
 *   },
 * }));
 *
 * app.listen(3000);
 * ```
 */
export function createMuseRankWebhook(config: WebhookConfig) {
  const handler = createWebhookHandler(config);
  const maxBodySizeBytes =
    config.maxBodySizeBytes ?? DEFAULT_MAX_BODY_SIZE_BYTES;

  if (maxBodySizeBytes < 0) {
    throw new Error("maxBodySizeBytes must be >= 0");
  }

  return async (
    req: ExpressRequest,
    res: ExpressResponse,
    next: ExpressNext,
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

      // Get body
      let body: string | object;
      if (typeof req.body === "string") {
        body = req.body;
        enforceBodyStringLimit(body, maxBodySizeBytes);
      } else if (req.rawBody) {
        // Some setups store raw body separately
        body =
          typeof req.rawBody === "string"
            ? req.rawBody
            : req.rawBody.toString("utf-8");
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
      } else if (req.on) {
        // No body parser in the pipeline – read from the stream directly
        body = await readNodeBodyWithLimit(
          req as NodeBodyStream,
          maxBodySizeBytes,
        );
      } else {
        throw new WebhookVerificationError("Unable to read request body", 400);
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

      // Pass unknown errors to Express error handler
      next(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

interface RawBodyMiddlewareOptions {
  maxBodySizeBytes?: number;
}

type ExpressJsonVerify = (
  req: ExpressRequest & { rawBody?: Buffer },
  res: unknown,
  buf: Buffer,
  encoding: string,
) => void;

/**
 * Preferred raw-body capture hook for apps that already use `express.json()`.
 *
 * Use this as the `verify` option to capture the exact request bytes while
 * still letting Express handle JSON parsing once.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { createRawBodyVerifier, createMuseRankWebhook } from '@muserank/webhook-sdk/express';
 *
 * const app = express();
 *
 * app.post(
 *   '/api/webhooks/muserank',
 *   express.json({
 *     limit: '2mb',
 *     verify: createRawBodyVerifier({ maxBodySizeBytes: 2 * 1024 * 1024 }),
 *   }),
 *   createMuseRankWebhook({
 *     accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
 *     signingSecret: process.env.MUSERANK_SIGNING_SECRET,
 *   })
 * );
 * ```
 */
export function createRawBodyVerifier(
  options?: RawBodyMiddlewareOptions,
): ExpressJsonVerify {
  const maxBodySizeBytes =
    options?.maxBodySizeBytes ?? DEFAULT_MAX_BODY_SIZE_BYTES;

  if (maxBodySizeBytes < 0) {
    throw new Error("maxBodySizeBytes must be >= 0");
  }

  return (req, _res, buf) => {
    if (maxBodySizeBytes > 0 && buf.length > maxBodySizeBytes) {
      throw new WebhookVerificationError(
        `Webhook payload too large (${buf.length} bytes). Max allowed is ${maxBodySizeBytes} bytes.`,
        413,
      );
    }

    req.rawBody = Buffer.from(buf);
  };
}

/**
 * Low-level Express middleware to capture and parse JSON directly from the
 * request stream for signature verification.
 *
 * Prefer `createRawBodyVerifier()` when you are already using `express.json()`.
 * If you use this middleware, do not also run `express.json()` on the same route
 * because both middlewares read the request body stream.
 *
 * @example
 * ```typescript
 * import express from 'express';
 * import { rawBodyMiddleware, createMuseRankWebhook } from '@muserank/webhook-sdk/express';
 *
 * const app = express();
 *
 * app.post(
 *   '/api/webhooks/muserank',
 *   rawBodyMiddleware({ maxBodySizeBytes: 2 * 1024 * 1024 }),
 *   createMuseRankWebhook({
 *     accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
 *     signingSecret: process.env.MUSERANK_SIGNING_SECRET,
 *   })
 * );
 * ```
 */
export function rawBodyMiddleware(
  req: ExpressRequest & { rawBody?: Buffer },
  res: ExpressResponse,
  next: ExpressNext,
): void;
export function rawBodyMiddleware(
  options?: RawBodyMiddlewareOptions,
): (
  req: ExpressRequest & { rawBody?: Buffer },
  res: ExpressResponse,
  next: ExpressNext,
) => void;
export function rawBodyMiddleware(
  arg1?: (ExpressRequest & { rawBody?: Buffer }) | RawBodyMiddlewareOptions,
  arg2?: ExpressResponse,
  arg3?: ExpressNext,
  // Return type intentionally omitted – the two overload signatures above
  // are the public API; an explicit `void | ((...) => void)` here would
  // trigger the `no-invalid-void-type` lint rule.
) {
  if (arg2 && arg3 && isExpressRequest(arg1)) {
    const middleware = createRawBodyMiddleware(DEFAULT_MAX_BODY_SIZE_BYTES);
    middleware(arg1, arg2, arg3);
    return;
  }

  const maxBodySizeBytes =
    (arg1 as RawBodyMiddlewareOptions | undefined)?.maxBodySizeBytes ??
    DEFAULT_MAX_BODY_SIZE_BYTES;

  return createRawBodyMiddleware(maxBodySizeBytes);
}

function createRawBodyMiddleware(maxBodySizeBytes: number) {
  if (maxBodySizeBytes < 0) {
    throw new Error("maxBodySizeBytes must be >= 0");
  }

  return (
    req: ExpressRequest & { rawBody?: Buffer },
    _res: ExpressResponse,
    next: ExpressNext,
  ): void => {
    const contentTypeHeader = req.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader)
      ? contentTypeHeader[0]
      : contentTypeHeader;

    if (!contentType?.includes("application/json")) {
      next();
      return;
    }

    const contentLengthHeader = req.headers["content-length"];
    const contentLength = Array.isArray(contentLengthHeader)
      ? contentLengthHeader[0]
      : contentLengthHeader;

    if (maxBodySizeBytes > 0 && contentLength) {
      const parsedLength = Number.parseInt(contentLength, 10);

      if (Number.isFinite(parsedLength) && parsedLength > maxBodySizeBytes) {
        next(
          new WebhookVerificationError(
            `Webhook payload too large (${parsedLength} bytes). Max allowed is ${maxBodySizeBytes} bytes.`,
            413,
          ),
        );
        return;
      }
    }

    if (!req.on) {
      next();
      return;
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    let done = false;

    const finishWithError = (error: Error) => {
      if (done) {
        return;
      }

      done = true;
      next(error);
    };

    req.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }

      totalSize += chunk.length;

      if (maxBodySizeBytes > 0 && totalSize > maxBodySizeBytes) {
        finishWithError(
          new WebhookVerificationError(
            `Webhook payload too large (${totalSize} bytes). Max allowed is ${maxBodySizeBytes} bytes.`,
            413,
          ),
        );
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (done) {
        return;
      }

      try {
        req.rawBody = Buffer.concat(chunks);
        const bodyString = req.rawBody.toString("utf-8");
        req.body = bodyString ? JSON.parse(bodyString) : {};
        done = true;
        next();
      } catch {
        finishWithError(
          new WebhookVerificationError("Invalid JSON payload", 400),
        );
      }
    });

    req.on("error", (err: Error) => finishWithError(err));
  };
}

function isExpressRequest(
  value:
    | (ExpressRequest & { rawBody?: Buffer })
    | RawBodyMiddlewareOptions
    | undefined,
): value is ExpressRequest & { rawBody?: Buffer } {
  return Boolean(value && typeof value === "object" && "headers" in value);
}

/**
 * Utility types
 */
export type { WebhookArticle, WebhookPayload, WebhookEventType } from "./index";
