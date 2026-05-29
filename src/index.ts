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
  /**
   * Article title as it should appear to readers and search engines.
   * MuseRank prefers the SEO-optimized title (`seoTitle`) when set and
   * falls back to the editorial title otherwise. Treat this as the
   * authoritative public title.
   */
  title: string;
  /**
   * Article content rendered as Markdown.
   * Produced by converting the editor's HTML through Turndown so it
   * round-trips into Markdown-native targets (Contentful long-text,
   * Ghost, MDX) without manual cleanup. May be `""` when the article
   * has no content yet — always check before persisting.
   */
  content_markdown: string;
  /**
   * Article content as raw HTML, exactly as edited in the MuseRank
   * Tiptap editor. Use this when your destination is HTML-native
   * (a CMS, an `<article>` tag, an Email Builder).
   */
  content_html: string;
  /** Meta description for SEO */
  meta_description: string;
  /** ISO 8601 timestamp of article creation */
  created_at: string;
  /** Featured image URL (if any) */
  image_url: string;
  /** URL-friendly slug */
  slug: string;
  /**
   * Topical tags for the article. MuseRank derives these from the
   * primary keyword, the SEO focus keyphrase, and any sibling
   * keywords assigned to the article in the topical map. Order is
   * stable: `tags[0]` is always the primary keyword. Duplicates are
   * removed case-insensitively.
   */
  tags: string[];
}

/**
 * Base webhook payload structure
 */
export interface WebhookPayload<T extends WebhookEventType = WebhookEventType> {
  /**
   * Stable identifier for the *event* (NOT the delivery attempt).
   *
   * The dispatcher derives this deterministically from the article id,
   * event type, and the article's `updated_at` timestamp, so retries
   * of the same event always carry the same `event_id`. Use this as
   * your idempotency key — typically as a `UNIQUE` column in your
   * receiver database — so a re-delivered event after a client-side
   * timeout doesn't produce duplicate rows.
   *
   * Format is opaque (do not parse), but is guaranteed to be a
   * non-empty string of printable ASCII characters with no
   * whitespace (`!`-`~`, i.e. ASCII 0x21–0x7E), ≤ 255 chars. Safe
   * to use directly as a SQL identifier or HTTP header value.
   */
  event_id: string;
  /**
   * Optional, per-attempt delivery identifier.
   *
   * Unlike `event_id`, this changes on every retry. Useful for
   * cross-referencing your receiver logs with MuseRank's outbound
   * delivery logs when debugging a specific failed attempt. Don't use
   * for idempotency — use `event_id` instead.
   *
   * When present, follows the same format as `event_id`: non-empty
   * printable ASCII without whitespace, ≤ 255 chars.
   */
  delivery_id?: string;
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
 * Default per-handler timeout: 30 seconds.
 *
 * Long-running event handlers block the inbound HTTP response (and
 * therefore MuseRank's outbound `pinnedFetch` connection). 30s is
 * comfortably above the worst-case webhook fan-out we've seen in
 * practice (DB upsert + image re-host) but well below typical edge /
 * Lambda execution caps.
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

/**
 * Per-event context passed to every handler as the third argument.
 *
 * - `eventId` / `deliveryId` mirror the payload fields so handlers
 *   that bind via `onEvent` or take only the article don't need to
 *   re-extract them.
 * - `signal` aborts when `handlerTimeoutMs` elapses. Long-running I/O
 *   should pass it to `fetch`, `AbortController`-aware DB drivers, or
 *   read it directly to short-circuit work.
 */
export interface WebhookContext {
  /** Idempotency key for this event (stable across retries). */
  eventId: string;
  /** Per-attempt id (varies across retries), if MuseRank sent one. */
  deliveryId: string | undefined;
  /**
   * Abort signal that fires when `handlerTimeoutMs` expires (or
   * immediately, if a previous handler in the same request already
   * timed out). Always present — even when `handlerTimeoutMs` is `0`
   * (in which case the signal simply never aborts).
   */
  signal: AbortSignal;
}

/**
 * Result returned from `onError` to override the default response.
 *
 * Returning this from `onError` tells the SDK to send a custom HTTP
 * response *instead of* the default 500 — useful when you've decided
 * the message is poison (return 4xx so MuseRank stops retrying) or
 * when you want to ack-and-drop a transient error (return 200).
 *
 * Returning `void` / `undefined` keeps the default behavior:
 * `WebhookProcessingError` → 500.
 */
export interface WebhookErrorOverride {
  /** HTTP status code to send (200–599). */
  statusCode: number;
  /** Response body's `error` field. Defaults to the original error message. */
  message?: string;
  /**
   * If `true`, treat the request as successfully processed (`success:
   * true` in the JSON body). Useful when ack-and-dropping at 200.
   * Defaults to `statusCode < 400`.
   */
  success?: boolean;
}

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
   * Optional: Webhook signing secret(s) for HMAC verification.
   * If provided, the X-MuseRank-Signature header will be validated.
   *
   * Pass an array to support zero-downtime rotation — every secret
   * in the array is tried in order and the request is accepted as
   * soon as any one of them matches. After rotating in MuseRank,
   * keep the previous secret in second position until you're sure
   * no in-flight requests still use it, then drop it on the next
   * deploy.
   *
   * Each secret is verified with a sequential async HMAC compute, so
   * the total verification time grows linearly with the array length.
   * Keep the array to ~2 entries (current + previous) during rotation
   * so the wall-clock cost — which is observable to a network attacker
   * — doesn't reveal more than the fact that rotation is in progress.
   * The match itself is constant-time and never short-circuits, so
   * *which* secret matched is not leaked.
   *
   * Empty arrays and arrays whose entries are all empty/non-string
   * are rejected at handler creation, since they would otherwise
   * make every incoming request fail with 401.
   */
  signingSecret?: string | readonly string[];

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
   * Optional: Maximum time, in milliseconds, that a single event
   * handler is allowed to run before its `signal` is aborted and the
   * SDK fails the request.
   *
   * Default: 30s ({@link DEFAULT_HANDLER_TIMEOUT_MS}). Set to `0` to
   * disable the timeout entirely (the abort signal will still be
   * present on `WebhookContext`, it just never fires).
   *
   * The timer is per-handler-call: an `article.published` event with
   * 3 articles in `data.articles` gets 3 timers, not one combined
   * 30-second budget.
   */
  handlerTimeoutMs?: number;

  /**
   * Handler for article.published events
   */
  onArticlePublished?: (
    article: WebhookArticle,
    payload: WebhookPayload<"article.published">,
    context: WebhookContext,
  ) => Promise<void> | void;

  /**
   * Handler for article.updated events
   */
  onArticleUpdated?: (
    article: WebhookArticle,
    payload: WebhookPayload<"article.updated">,
    context: WebhookContext,
  ) => Promise<void> | void;

  /**
   * Handler for article.scheduled events
   */
  onArticleScheduled?: (
    article: WebhookArticle,
    payload: WebhookPayload<"article.scheduled">,
    context: WebhookContext,
  ) => Promise<void> | void;

  /**
   * Handler for article.failed events
   */
  onArticleFailed?: (
    article: WebhookArticle,
    payload: WebhookPayload<"article.failed">,
    context: WebhookContext,
  ) => Promise<void> | void;

  /**
   * Handler for test.ping events (from the Test button in MuseRank)
   * If not provided, test events are acknowledged with a success response.
   */
  onTestPing?: (
    payload: WebhookPayload<"test.ping">,
    context: WebhookContext,
  ) => Promise<void> | void;

  /**
   * Generic handler for all events (called after specific handlers)
   */
  onEvent?: (
    eventType: WebhookEventType,
    payload: WebhookPayload,
    context: WebhookContext,
  ) => Promise<void> | void;

  /**
   * Error handler for when webhook processing fails.
   *
   * Return a `WebhookErrorOverride` (or a Promise of one) to override
   * the default 500 response — for example, return `{ statusCode:
   * 200 }` to ack-and-drop a poison message, or `{ statusCode: 400 }`
   * to permanently reject it (MuseRank will not retry on 4xx).
   *
   * Returning `void` keeps the default behavior.
   */
  onError?: (
    error: Error,
    payload?: WebhookPayload,
  ) => Promise<WebhookErrorOverride | void> | WebhookErrorOverride | void;

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
  /**
   * Optional override returned by `onError` for adapter consumption.
   * Adapters (`/web`, `/nextjs`, `/express`) read this to decide the
   * outgoing HTTP response. End users should rarely interact with it
   * directly.
   */
  override?: WebhookErrorOverride;

  constructor(
    message: string,
    public payload?: WebhookPayload,
    override?: WebhookErrorOverride,
  ) {
    super(message);
    this.name = "WebhookProcessingError";
    this.override = override;
  }
}

/**
 * Error thrown when a handler exceeds `handlerTimeoutMs`.
 *
 * Thin subclass of `WebhookProcessingError` so existing 500-mapping
 * code keeps working, while `instanceof` callers can distinguish a
 * timeout from an arbitrary handler bug.
 */
export class WebhookHandlerTimeoutError extends WebhookProcessingError {
  /** Timeout that was exceeded, in milliseconds. */
  timeoutMs: number;

  constructor(timeoutMs: number, payload?: WebhookPayload) {
    super(
      `Webhook handler exceeded ${timeoutMs}ms timeout`,
      payload,
      /* override */ undefined,
    );
    this.name = "WebhookHandlerTimeoutError";
    this.timeoutMs = timeoutMs;
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
 * Validate that a value is a non-empty string of printable ASCII
 * characters without whitespace (chars 0x21–0x7E), capped at 255
 * chars. Used for `event_id` and `delivery_id`, both of which the
 * dispatcher generates as opaque tokens and which MUST be safe to
 * stuff into URL paths, HTTP headers, log lines and SQL UNIQUE
 * columns without any extra escaping.
 */
function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    /^[\x21-\x7e]+$/.test(value)
  );
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
 * Verify the webhook signature using HMAC-SHA256.
 *
 * Accepts a single secret or a list of secrets — useful during
 * zero-downtime rotation, where both the new and old secret are
 * accepted briefly. Each candidate is checked with constant-time
 * comparison.
 */
export async function verifySignature(
  payload: string,
  signature: string,
  secret: string | readonly string[],
): Promise<boolean> {
  const normalizedSignature = signature
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, "");
  const providedSignatureBytes = hexToBytes(normalizedSignature);

  if (!providedSignatureBytes) {
    return false;
  }

  const candidates = Array.isArray(secret) ? secret : [secret as string];

  // Iterate every secret regardless of an early match so the loop
  // runtime doesn't leak how many secrets were configured. We OR the
  // results into `matched` and only act on it after all candidates
  // have been compared.
  let matched = false;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      continue;
    }

    try {
      const expectedSignature = await computeHmacSha256Hex(payload, candidate);
      const expectedSignatureBytes = hexToBytes(expectedSignature);

      if (!expectedSignatureBytes) {
        continue;
      }

      if (
        constantTimeEqualBytes(expectedSignatureBytes, providedSignatureBytes)
      ) {
        matched = true;
      }
    } catch {
      // Swallow per-secret errors so a single bad secret can't drop
      // the whole verification path.
    }
  }

  return matched;
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
    event_id?: unknown;
    delivery_id?: unknown;
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

  if (!isOpaqueId(candidatePayload.event_id)) {
    throw new WebhookVerificationError(
      "Missing or invalid event_id in payload",
      400,
    );
  }

  if (
    candidatePayload.delivery_id !== undefined &&
    !isOpaqueId(candidatePayload.delivery_id)
  ) {
    throw new WebhookVerificationError(
      "Invalid delivery_id in payload",
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
 * Race a promise against an `AbortSignal`-driven timeout.
 *
 * Resolves/rejects with whichever finishes first; cleans up the timer
 * either way. The signal MUST already be wired to the timeout — we
 * don't create the AbortController here so callers can share one
 * across multiple races (i.e. abort all handler timeouts on first
 * failure if we ever want to add fail-fast behavior).
 */
function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => Error,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(onAbort());
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      signal.removeEventListener("abort", handleAbort);
      reject(onAbort());
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      },
    );
  });
}

/**
 * Build a fresh `WebhookContext` for a single handler invocation.
 *
 * Each handler call gets its own AbortController so a slow handler
 * for article #2 can't abort the timer that's about to fire for
 * article #3 (and vice-versa).
 */
function createHandlerContext(
  payload: WebhookPayload,
  handlerTimeoutMs: number,
): { context: WebhookContext; clear: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (handlerTimeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort();
    }, handlerTimeoutMs);
  }
  return {
    context: {
      eventId: payload.event_id,
      deliveryId: payload.delivery_id,
      signal: controller.signal,
    },
    clear: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Run a single handler invocation under the configured timeout.
 *
 * `runner` is a thunk so we can keep the handler-specific casts
 * (`onArticlePublished` vs `onTestPing` etc.) at the call site, while
 * the timer + abort plumbing lives here exactly once.
 */
async function runUnderTimeout(
  payload: WebhookPayload,
  handlerTimeoutMs: number,
  runner: (context: WebhookContext) => Promise<void> | void,
): Promise<void> {
  const { context, clear } = createHandlerContext(payload, handlerTimeoutMs);
  try {
    if (handlerTimeoutMs <= 0) {
      await runner(context);
      return;
    }
    await raceWithSignal(
      Promise.resolve().then(() => runner(context)),
      context.signal,
      () => new WebhookHandlerTimeoutError(handlerTimeoutMs, payload),
    );
  } finally {
    clear();
  }
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
  const handlerTimeoutMs =
    config.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;

  if (handlerTimeoutMs < 0) {
    throw new Error("handlerTimeoutMs must be >= 0");
  }

  if (config.debug) {
    console.log(
      `[MuseRank Webhook] Processing ${event_type} event (event_id=${payload.event_id})`,
    );
  }

  try {
    // Handle specific event types
    switch (event_type) {
      case "article.published":
        if (config.onArticlePublished) {
          for (const article of articles) {
            await runUnderTimeout(payload, handlerTimeoutMs, (ctx) =>
              config.onArticlePublished!(
                article,
                payload as WebhookPayload<"article.published">,
                ctx,
              ),
            );
          }
        }
        break;

      case "article.updated":
        if (config.onArticleUpdated) {
          for (const article of articles) {
            await runUnderTimeout(payload, handlerTimeoutMs, (ctx) =>
              config.onArticleUpdated!(
                article,
                payload as WebhookPayload<"article.updated">,
                ctx,
              ),
            );
          }
        }
        break;

      case "article.scheduled":
        if (config.onArticleScheduled) {
          for (const article of articles) {
            await runUnderTimeout(payload, handlerTimeoutMs, (ctx) =>
              config.onArticleScheduled!(
                article,
                payload as WebhookPayload<"article.scheduled">,
                ctx,
              ),
            );
          }
        }
        break;

      case "article.failed":
        if (config.onArticleFailed) {
          for (const article of articles) {
            await runUnderTimeout(payload, handlerTimeoutMs, (ctx) =>
              config.onArticleFailed!(
                article,
                payload as WebhookPayload<"article.failed">,
                ctx,
              ),
            );
          }
        }
        break;

      case "test.ping":
        if (config.onTestPing) {
          await runUnderTimeout(payload, handlerTimeoutMs, (ctx) =>
            config.onTestPing!(payload as WebhookPayload<"test.ping">, ctx),
          );
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
      await runUnderTimeout(payload, handlerTimeoutMs, (ctx) =>
        config.onEvent!(event_type, payload, ctx),
      );
    }

    return {
      success: true,
      message: `Successfully processed ${event_type} event`,
      eventType: event_type,
      articlesProcessed: articles.length,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    let override: WebhookErrorOverride | undefined;
    if (config.onError) {
      try {
        const result = await config.onError(err, payload);
        if (
          result &&
          typeof result === "object" &&
          typeof (result as { statusCode?: unknown }).statusCode === "number"
        ) {
          const candidate = result as WebhookErrorOverride;
          if (
            Number.isInteger(candidate.statusCode) &&
            candidate.statusCode >= 200 &&
            candidate.statusCode <= 599
          ) {
            override = candidate;
          } else {
            // Invalid override would either crash the adapter
            // (Response.json throws RangeError outside [200, 599], Node
            // throws on NaN status) or produce a malformed response.
            // Fall back to the default 500 path and surface the
            // misconfiguration loudly so it's visible in logs.
            console.warn(
              `[MuseRank Webhook] onError returned invalid statusCode=${String(candidate.statusCode)}; ` +
                "expected an integer in [200, 599]. Falling back to default 500 response.",
            );
          }
        }
      } catch (onErrorError) {
        // Don't let a buggy onError mask the real handler error.
        if (config.debug) {
          console.error(
            "[MuseRank Webhook] onError handler itself threw:",
            onErrorError,
          );
        }
      }
    }

    // Preserve the original timeout sub-class so adapters can map it
    // back to a 500 (or whatever the override says) without losing
    // its `instanceof WebhookHandlerTimeoutError` identity.
    if (err instanceof WebhookHandlerTimeoutError) {
      err.payload = payload;
      err.override = override;
      throw err;
    }
    throw new WebhookProcessingError(err.message, payload, override);
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

  const handlerTimeoutMs =
    config.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;

  if (handlerTimeoutMs < 0) {
    throw new Error("handlerTimeoutMs must be >= 0");
  }

  if (config.signingSecret !== undefined && Array.isArray(config.signingSecret)) {
    if (config.signingSecret.length === 0) {
      throw new Error(
        "signingSecret array must not be empty. Pass `undefined` to disable " +
          "signature verification, or include at least one non-empty secret string.",
      );
    }
    const hasUsableSecret = config.signingSecret.some(
      (secret) => typeof secret === "string" && secret.length > 0,
    );
    if (!hasUsableSecret) {
      throw new Error(
        "signingSecret array must contain at least one non-empty string. " +
          "All entries are empty or non-string, which would make every " +
          "request fail with 401 Invalid signature.",
      );
    }
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
