# Changelog

All notable changes to this project will be documented in this file.

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
