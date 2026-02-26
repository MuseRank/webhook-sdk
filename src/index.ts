/**
 * @muserank/webhook-sdk
 *
 * SDK for receiving MuseRank webhook events in your application.
 * Supports Next.js, Express, and generic HTTP handlers.
 */

const textEncoder = new TextEncoder();

const WEBHOOK_EVENT_TYPE_SET = new Set<string>([
  "article.published",
  "article.updated",
  "article.scheduled",
  "article.failed",
  "test.ping",
]);

// ============================================================================
// TYPES
// ============================================================================

/**
 * Webhook event types that can be received from MuseRank
 */
export type WebhookEventType =
  | "article.published"
  | "article.updated"
  | "article.scheduled"
  | "article.failed"
  | "test.ping";

/**
 * Article data included in webhook payloads
 */
export interface WebhookArticle {
  /** Unique article ID */
  id: string;
  /** Article title (may include SEO title) */
  title: string;
  /** Article content in Markdown format */
  content_markdown: string;
  /** Article content in HTML format */
  content_html: string;
  /** Meta description for SEO */
  meta_description: string;
  /** ISO 8601 timestamp of article creation */
  created_at: string;
  /** Featured image URL (if any) */
  image_url: string;
  /** URL-friendly slug */
  slug: string;
  /** Associated tags/keywords */
  tags: string[];
}

/**
 * Base webhook payload structure
 */
export interface WebhookPayload<T extends WebhookEventType = WebhookEventType> {
  /** Type of event */
  event_type: T;
  /** ISO 8601 timestamp of when the event was triggered */
  timestamp: string;
  /** Event data */
  data: {
    articles: WebhookArticle[];
  };
}

/**
 * Default timestamp tolerance: 5 minutes
 */
export const DEFAULT_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Maximum clock-skew allowed for future-dated webhook timestamps.
 * Webhooks timestamped up to this many milliseconds in the future are
 * accepted to accommodate minor server clock differences.  Anything
 * further in the future is rejected as invalid.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000; // 30 seconds

/**
 * Default max payload size: 1 MB
 */
export const DEFAULT_MAX_BODY_SIZE_BYTES = 1024 * 1024;

/**
 * Webhook configuration options
 */
export interface WebhookConfig {
  /**
   * Your webhook access token from MuseRank settings.
   * Used to verify the Authorization header.
   */
  accessToken: string;

  /**
   * Optional: Webhook signing secret for HMAC verification.
   * If provided, the X-MuseRank-Signature header will be validated.
   */
  signingSecret?: string;

  /**
   * Optional: Maximum age of webhook timestamp in milliseconds.
   * Webhooks older than this will be rejected to prevent replay attacks.
   * Default: 5 minutes (300000ms)
   * Set to 0 to disable timestamp verification.
   */
  timestampToleranceMs?: number;

  /**
   * Optional: Maximum webhook body size in bytes.
   * Requests exceeding this limit are rejected with status 413.
   * Default: 1MB (1048576 bytes)
   * Set to 0 to disable body size verification.
   */
  maxBodySizeBytes?: number;

  /**
   * Handler for article.published events
   */
  onArticlePublished?: (
    article: WebhookArticle,
    payload: WebhookPayload<"article.published">,
  ) => Promise<void> | void;

  /**
   * Handler for article.updated events
   */
  onArticleUpdated?: (
    article: WebhookArticle,
    payload: WebhookPayload<"article.updated">,
  ) => Promise<void> | void;

  /**
   * Handler for article.scheduled events
   */
  onArticleScheduled?: (
    article: WebhookArticle,
    payload: WebhookPayload<"article.scheduled">,
  ) => Promise<void> | void;

  /**
   * Handler for article.failed events
   */
  onArticleFailed?: (
    article: WebhookArticle,
    payload: WebhookPayload<"article.failed">,
  ) => Promise<void> | void;

  /**
   * Handler for test.ping events (from the Test button in MuseRank)
   * If not provided, test events are acknowledged with a success response.
   */
  onTestPing?: (payload: WebhookPayload<"test.ping">) => Promise<void> | void;

  /**
   * Generic handler for all events (called after specific handlers)
   */
  onEvent?: (
    eventType: WebhookEventType,
    payload: WebhookPayload,
  ) => Promise<void> | void;

  /**
   * Error handler for when webhook processing fails
   */
  onError?: (error: Error, payload?: WebhookPayload) => Promise<void> | void;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

/**
 * Result of webhook processing
 */
export interface WebhookResult {
  success: boolean;
  message: string;
  eventType?: WebhookEventType;
  articlesProcessed?: number;
}

/**
 * Error thrown when webhook verification fails
 */
export class WebhookVerificationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = "WebhookVerificationError";
    this.statusCode = statusCode;
  }
}

/**
 * Error thrown when webhook processing fails
 */
export class WebhookProcessingError extends Error {
  constructor(
    message: string,
    public payload?: WebhookPayload,
  ) {
    super(message);
    this.name = "WebhookProcessingError";
  }
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Check if a value is a valid MuseRank webhook event type
 */
export function isWebhookEventType(value: unknown): value is WebhookEventType {
  return typeof value === "string" && WEBHOOK_EVENT_TYPE_SET.has(value);
}

/**
 * Constant-time byte comparison to avoid timing attacks.
 */
function constantTimeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return mismatch === 0;
}

/**
 * Convert hex string to bytes.
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);

  for (let index = 0; index < hex.length; index += 2) {
    const byte = Number.parseInt(hex.slice(index, index + 2), 16);

    if (Number.isNaN(byte)) {
      return null;
    }

    bytes[index / 2] = byte;
  }

  return bytes;
}

/**
 * Convert bytes to lowercase hex.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

/**
 * Compute HMAC-SHA256 digest using Web Crypto API.
 */
async function computeHmacSha256Hex(
  payload: string,
  secret: string,
): Promise<string> {
  const cryptoApi = globalThis.crypto;

  if (!cryptoApi?.subtle) {
    throw new Error("Web Crypto API is not available in this runtime");
  }

  const key = await cryptoApi.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await cryptoApi.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(payload),
  );
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Verify the webhook signature using HMAC-SHA256
 */
export async function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const normalizedSignature = signature
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, "");
  const providedSignatureBytes = hexToBytes(normalizedSignature);

  if (!providedSignatureBytes) {
    return false;
  }

  try {
    const expectedSignature = await computeHmacSha256Hex(payload, secret);
    const expectedSignatureBytes = hexToBytes(expectedSignature);

    if (!expectedSignatureBytes) {
      return false;
    }

    return constantTimeEqualBytes(
      expectedSignatureBytes,
      providedSignatureBytes,
    );
  } catch {
    return false;
  }
}

/**
 * Verify the Bearer token from Authorization header.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyBearerToken(
  authHeader: string | null | undefined,
  expectedToken: string,
): boolean {
  if (!authHeader) return false;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }

  const token = match[1].trim();
  if (!token) {
    return false;
  }

  const tokenBytes = textEncoder.encode(token);
  const expectedBytes = textEncoder.encode(expectedToken);

  return constantTimeEqualBytes(tokenBytes, expectedBytes);
}

/**
 * Verify the webhook timestamp is within acceptable tolerance.
 * Prevents replay attacks by rejecting old webhooks, and rejects timestamps
 * that are too far in the future to guard against pre-dated payloads.
 *
 * Accepts timestamps in the range:
 *   [now - toleranceMs, now + CLOCK_SKEW_TOLERANCE_MS]
 */
export function verifyTimestamp(
  timestamp: string,
  toleranceMs: number = DEFAULT_TIMESTAMP_TOLERANCE_MS,
): boolean {
  if (toleranceMs < 0) {
    return false;
  }

  // If tolerance is 0, skip timestamp verification
  if (toleranceMs === 0) return true;

  const webhookTime = new Date(timestamp).getTime();
  if (!Number.isFinite(webhookTime)) {
    return false;
  }

  const now = Date.now();
  // age > 0  → webhook is in the past  (reject if too old)
  // age < 0  → webhook is in the future (reject if too far ahead)
  const age = now - webhookTime;

  return age >= -CLOCK_SKEW_TOLERANCE_MS && age <= toleranceMs;
}

/**
 * Get body size in bytes.
 */
export function getBodySizeBytes(body: string | object): number {
  if (typeof body === "string") {
    return textEncoder.encode(body).length;
  }

  return textEncoder.encode(JSON.stringify(body)).length;
}

/**
 * Enforce body size limits.
 */
export function assertBodySizeLimit(
  body: string | object,
  maxBodySizeBytes: number = DEFAULT_MAX_BODY_SIZE_BYTES,
): void {
  if (maxBodySizeBytes < 0) {
    throw new WebhookVerificationError(
      "Invalid maxBodySizeBytes configuration. Value must be >= 0.",
      500,
    );
  }

  if (maxBodySizeBytes === 0) {
    return;
  }

  let bodySizeBytes: number;

  try {
    bodySizeBytes = getBodySizeBytes(body);
  } catch {
    throw new WebhookVerificationError("Invalid JSON payload", 400);
  }

  if (bodySizeBytes > maxBodySizeBytes) {
    throw new WebhookVerificationError(
      `Webhook payload too large (${bodySizeBytes} bytes). Max allowed is ${maxBodySizeBytes} bytes.`,
      413,
    );
  }
}

/**
 * Parse and validate webhook payload
 */
export function parseWebhookPayload(body: string | object): WebhookPayload {
  let payload: unknown;

  if (typeof body === "string") {
    try {
      payload = JSON.parse(body);
    } catch {
      throw new WebhookVerificationError("Invalid JSON payload", 400);
    }
  } else {
    payload = body;
  }

  if (!payload || typeof payload !== "object") {
    throw new WebhookVerificationError(
      "Webhook payload must be a JSON object",
      400,
    );
  }

  const candidatePayload = payload as {
    event_type?: unknown;
    timestamp?: unknown;
    data?: {
      articles?: unknown;
    };
  };

  if (!isWebhookEventType(candidatePayload.event_type)) {
    throw new WebhookVerificationError(
      "Unsupported or missing event_type in payload",
      400,
    );
  }

  if (typeof candidatePayload.timestamp !== "string") {
    throw new WebhookVerificationError("Missing timestamp in payload", 400);
  }

  if (!Number.isFinite(new Date(candidatePayload.timestamp).getTime())) {
    throw new WebhookVerificationError("Invalid timestamp in payload", 400);
  }

  if (!candidatePayload.data || typeof candidatePayload.data !== "object") {
    throw new WebhookVerificationError("Missing data object in payload", 400);
  }

  if (!Array.isArray(candidatePayload.data.articles)) {
    throw new WebhookVerificationError(
      "Missing articles array in payload data",
      400,
    );
  }

  if (
    !candidatePayload.data.articles.every(
      (article) => article && typeof article === "object",
    )
  ) {
    throw new WebhookVerificationError("Payload articles must be objects", 400);
  }

  return candidatePayload as WebhookPayload;
}

/**
 * Process a webhook event with the configured handlers
 */
export async function processWebhookEvent(
  payload: WebhookPayload,
  config: WebhookConfig,
): Promise<WebhookResult> {
  const { event_type, data } = payload;
  const articles = data?.articles || [];

  if (config.debug) {
    console.log(`[MuseRank Webhook] Processing ${event_type} event`);
  }

  try {
    // Handle specific event types
    switch (event_type) {
      case "article.published":
        if (config.onArticlePublished) {
          for (const article of articles) {
            await config.onArticlePublished(
              article,
              payload as WebhookPayload<"article.published">,
            );
          }
        }
        break;

      case "article.updated":
        if (config.onArticleUpdated) {
          for (const article of articles) {
            await config.onArticleUpdated(
              article,
              payload as WebhookPayload<"article.updated">,
            );
          }
        }
        break;

      case "article.scheduled":
        if (config.onArticleScheduled) {
          for (const article of articles) {
            await config.onArticleScheduled(
              article,
              payload as WebhookPayload<"article.scheduled">,
            );
          }
        }
        break;

      case "article.failed":
        if (config.onArticleFailed) {
          for (const article of articles) {
            await config.onArticleFailed(
              article,
              payload as WebhookPayload<"article.failed">,
            );
          }
        }
        break;

      case "test.ping":
        if (config.onTestPing) {
          await config.onTestPing(payload as WebhookPayload<"test.ping">);
        } else if (config.debug) {
          // Log test ping even without handler
          console.log(
            "[MuseRank Webhook] Test ping received - connection verified",
          );
        }
        break;

      default:
        throw new WebhookVerificationError(
          `Unsupported event_type: ${String(event_type)}`,
          400,
        );
    }

    // Call generic handler
    if (config.onEvent) {
      await config.onEvent(event_type, payload);
    }

    return {
      success: true,
      message: `Successfully processed ${event_type} event`,
      eventType: event_type,
      articlesProcessed: articles.length,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    if (config.onError) {
      await config.onError(err, payload);
    }

    throw new WebhookProcessingError(err.message, payload);
  }
}

/**
 * Create a generic webhook handler function
 *
 * This is the core handler that can be used with any framework.
 * For framework-specific handlers, use the adapters in @muserank/webhook-sdk/nextjs or /express
 */
export function createWebhookHandler(config: WebhookConfig) {
  if (!config.accessToken) {
    throw new Error("Webhook accessToken is required");
  }

  const maxBodySizeBytes =
    config.maxBodySizeBytes ?? DEFAULT_MAX_BODY_SIZE_BYTES;

  if (maxBodySizeBytes < 0) {
    throw new Error("maxBodySizeBytes must be >= 0");
  }

  const timestampToleranceMs =
    config.timestampToleranceMs ?? DEFAULT_TIMESTAMP_TOLERANCE_MS;

  if (timestampToleranceMs < 0) {
    throw new Error("timestampToleranceMs must be >= 0");
  }

  return async (request: {
    headers: Record<string, string | undefined>;
    body: string | object;
  }): Promise<WebhookResult> => {
    assertBodySizeLimit(request.body, maxBodySizeBytes);

    // Verify bearer token
    const authHeader =
      request.headers["authorization"] || request.headers["Authorization"];
    if (!verifyBearerToken(authHeader, config.accessToken)) {
      throw new WebhookVerificationError(
        "Invalid or missing authorization",
        401,
      );
    }

    // Verify signature if secret is provided
    if (config.signingSecret) {
      if (typeof request.body !== "string") {
        throw new WebhookVerificationError(
          "Raw request body is required for signature verification",
          400,
        );
      }

      const signature =
        request.headers["x-muserank-signature"] ||
        request.headers["X-MuseRank-Signature"];
      const body = request.body;

      if (
        !signature ||
        !(await verifySignature(body, signature, config.signingSecret))
      ) {
        throw new WebhookVerificationError("Invalid signature", 401);
      }
    }

    // Parse payload
    const payload = parseWebhookPayload(request.body);

    // Verify timestamp to prevent replay attacks
    if (!verifyTimestamp(payload.timestamp, timestampToleranceMs)) {
      throw new WebhookVerificationError(
        `Webhook timestamp is too old (older than ${timestampToleranceMs / 1000} seconds). ` +
          "This may indicate a replay attack or clock skew.",
        401,
      );
    }

    // Process event
    return processWebhookEvent(payload, config);
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export { createWebhookHandler as createMuseRankWebhook };
