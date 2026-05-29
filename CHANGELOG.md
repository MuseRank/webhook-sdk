# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- `WebhookPayload.event_id?: string` — stable idempotency key (`evt_<32-hex>`,
  36 chars). Anchored on `article.updatedAt` at enqueue time so every retry of
  the same logical event carries the same value. Also sent as the
  `X-MuseRank-Event-ID` request header. Optional for backward compatibility.
- `WebhookPayload.delivery_id?: string` — per-attempt delivery identifier
  (`dlv_<24-hex>`, 28 chars). Fresh on every retry for log correlation; do
  **not** use for deduplication. Also sent as the `X-MuseRank-Delivery-ID`
  request header. Optional for backward compatibility.
- `WebhookResult.eventId?: string` — echoed from `payload.event_id`.
- `WebhookResult.deliveryId?: string` — echoed from `payload.delivery_id`.
- `parseWebhookPayload` validates both `event_id` and `delivery_id` are strings
  when present (rejects non-string values with `400`); payloads without them
  remain accepted for backward compatibility.

### Documentation

- Added an "Idempotency & delivery semantics" section covering `event_id` vs
  `delivery_id` semantics, both fields and headers, and switched examples to
  upserts.
- Corrected the "Setting Up in MuseRank" steps (user-supplied access token vs.
  MuseRank-generated `whsec_…` signing secret shown once).
- Documented that `content_html` is the source of truth and `content_markdown`
  is best-effort.

## [2.0.0] - 2026-02-26

### Changed

- Switched signature verification to Web Crypto API for runtime portability (Node, Bun, Deno, Cloudflare Workers)
- Added strict payload validation for `event_type`, `timestamp`, and `data.articles`
- Added configurable payload size limits (`maxBodySizeBytes`, default `1MB`) with `413` responses
- Improved HTTP status mapping for verification errors (`400`, `401`, `413`)
- Enforced raw-body requirements when `signingSecret` is configured
- Added method checks to Next.js App Router adapter and body-size guards to stream readers
- Updated `lint` script to run type checks (`tsc --noEmit`) without extra tooling dependencies
- Expanded tests to cover malformed payloads, payload limits, and raw-body signature requirements

## [1.0.0] - 2026-01-06

### Added

- Initial release
- Core webhook handler with Bearer token verification
- **Security: HMAC signature verification** using SHA-256
- **Security: Constant-time token comparison** to prevent timing attacks
- **Security: Replay attack protection** via timestamp verification (5-minute default tolerance)
- Universal Web API adapter (`@muserank/webhook-sdk/web`) for:
  - Remix
  - Astro
  - SvelteKit
  - Cloudflare Workers
  - Deno
  - Bun
- Next.js App Router adapter (`@muserank/webhook-sdk/nextjs`)
- Next.js Pages Router adapter
- Express.js adapter (`@muserank/webhook-sdk/express`)
- Full TypeScript support with exported types
- Event handlers for:
  - `article.published`
  - `article.updated`
  - `article.scheduled`
  - `article.failed`
  - `test.ping` (handled gracefully without requiring explicit handler)
- Generic `onEvent` handler for all events
- Error handling with custom error types
- Debug logging option
- `timestampToleranceMs` configuration for replay attack protection
- Raw body middleware for Express signature verification
- Comprehensive test suite (31 tests)
- Comprehensive documentation with examples for all supported frameworks
