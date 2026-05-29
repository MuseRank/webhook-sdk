# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed

- **Stricter `event_id` / `delivery_id` validation.** The SDK now rejects
  any non-empty string that contains characters outside the printable
  ASCII range `0x21–0x7E`, matching the dispatcher contract. Emoji,
  CJK, accented characters, and embedded whitespace / control chars
  are refused with `400 Missing or invalid event_id in payload` (or
  the corresponding `delivery_id` message). The JSON Schema now
  carries the matching `pattern` constraint so non-TS receivers
  enforce the same rule.
- **`signingSecret` array misconfiguration is caught at handler creation.**
  Passing `signingSecret: []`, `["", ""]`, or any array whose entries
  are all empty/non-string used to silently fail every request with
  `401 Invalid signature` because empty arrays are truthy in JS and
  the verification loop iterated zero usable candidates. The handler
  factory now throws a descriptive `Error` at construction time.
  Arrays with at least one non-empty entry (e.g. `["", "real_secret"]`,
  a common env-var pattern) keep working unchanged.
- **`onError` response overrides are range-checked.** Returning
  `{ statusCode }` from `onError` with a value that wasn't an integer
  in `[200, 599]` (`NaN`, `Infinity`, `-1`, `0`, `999`, `200.5`, …)
  used to flow straight into `res.status(...)` / `Response.json(...)`
  and either crash the adapter (Node throws `Invalid status code: NaN`,
  Web throws `RangeError`) or produce a malformed response. Invalid
  overrides are now discarded with a `console.warn` and the default
  `500` response path is used.
- **Express adapter JSDoc** now includes a second `@example` showing
  the `signingSecret` + `createRawBodyVerifier` combination, so users
  enabling HMAC verification don't fall into the
  `400 Raw request body is required for signature verification` trap
  by copying the basic example.

## [3.0.0] - 2026-05-28

### Breaking changes

- **Payload now requires `event_id`.** Every webhook from MuseRank carries
  a stable per-event identifier; receivers should use it as their
  idempotency key (`UNIQUE` column in your DB). The SDK rejects payloads
  missing or with an empty `event_id` with `400 Missing or invalid
  event_id in payload`. Older MuseRank deployments must update their
  dispatcher before upgrading the SDK.
- **Event handlers receive a third `WebhookContext` argument.** All
  `onArticle*`, `onTestPing`, and `onEvent` handlers now get
  `(article, payload, context)` (or `(payload, context)` for `onTestPing`,
  `(eventType, payload, context)` for `onEvent`). Existing handlers that
  only used the first two args keep working — TypeScript users will see
  a parameter-count widening, no type errors.

### Added

- **Idempotency**: `event_id` (required) and optional `delivery_id` on
  `WebhookPayload`. `event_id` is stable across retries, `delivery_id`
  changes per attempt — use the first for dedup, the second for log
  correlation.
- **`WebhookContext`**: third argument to every handler. Carries
  `eventId`, `deliveryId`, and an `AbortSignal` that fires when the
  per-handler timeout expires.
- **`handlerTimeoutMs`**: new config option (default **30s**). Aborts
  long-running handlers via the context's `signal` and fails the
  request with `WebhookHandlerTimeoutError` so MuseRank backs off and
  retries instead of holding the connection forever. Set to `0` to
  disable.
- **Multi-secret rotation**: `signingSecret` now accepts
  `string | readonly string[]`. Pass the array form during a rotation
  window so both the old and new secret verify; drop the old one on the
  next deploy. Iteration runs every candidate even after a match so
  the loop runtime doesn't leak how many secrets are configured.
- **`onError` response override**: `onError` may now return
  `{ statusCode, success?, message? }` to override the default 500
  response. Use `200` to ack-and-drop a poison message (so MuseRank
  stops retrying) or `4xx` to permanently reject. Returning `void`
  preserves the previous behavior.
- **`payload.schema.json`** shipped at the package root and exported via
  `package.json#exports["./payload.schema.json"]`. JSON Schema 2020-12,
  consumable by non-TS receivers (Python, Go, Ruby) without bringing in
  the runtime. CI runs a drift-check (`bun run schema:check`) so the
  schema can never silently lag behind `WebhookPayload`.
- **Type-level test suite** (`src/types.test.ts`) using `expect-type`
  to lock down the public surface — handler arity, optional vs required
  fields, error-class hierarchy. Stops a future minor from accidentally
  narrowing the API.
- **Runnable examples** under `examples/nextjs-app-router/` and
  `examples/express/` showing the recommended production pattern
  (multi-secret rotation env var, idempotency claim on `event_id`,
  `onError` ack-and-drop on `UNIQUE` violations).

### Changed

- CI now uses `oven-sh/setup-bun@v2` and `bun install --frozen-lockfile`,
  matching the declared `packageManager`. `bun.lock` (Bun 1.2's text
  lockfile format) is committed.
- `lint` script now runs `typecheck` + `schema:check` so a drifted
  schema fails CI before tests run.

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
