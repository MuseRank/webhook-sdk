# Next.js App Router · MuseRank webhook receiver

Minimal end-to-end example that wires `@muserank/webhook-sdk/nextjs` into a
Next.js App Router project. Mirrors the production-ready pattern recommended
in the SDK README:

- HMAC signing **enabled** (multi-secret, so you can rotate without downtime).
- Idempotency via `event_id` (just a `Set` here — replace with a `UNIQUE`
  column in your DB).
- Per-handler timeout via `handlerTimeoutMs`.
- `onError` returns a structured override so a poison message ack-and-drops
  at 200 instead of forcing MuseRank to retry.

## Run it

```bash
# from the SDK repo root
bun install                                # install workspace deps
cd examples/nextjs-app-router

cp .env.example .env.local                  # fill in real values
bun install                                  # installs Next.js + the SDK
bun run dev                                  # http://localhost:3000
```

Then in the MuseRank dashboard:

1. **Integrations → Webhook → Connect**.
2. URL: `https://<your-tunnel>.ngrok.app/api/webhooks/muserank`.
3. Paste the access token you set in `.env.local` as `MUSERANK_WEBHOOK_TOKEN`.
4. Save. Copy the **signing secret** that's shown once and put it in
   `MUSERANK_SIGNING_SECRET`.
5. Click **Test connection** — the dev server logs should show the
   `test.ping` event.

## How it's structured

- `app/api/webhooks/muserank/route.ts` — the actual handler. The SDK
  wraps it; you only write business logic.
- `lib/idempotency.ts` — toy in-memory dedup. Real receivers should use
  `INSERT ... ON CONFLICT DO NOTHING` against a `processed_events` table.
- `.env.example` — env vars the handler reads.

## Production checklist

The example shows the right shape; before shipping replace:

- [ ] In-memory `Set` → durable store with `event_id` as the unique key.
- [ ] `console.log` of articles → your CMS / DB / email pipeline.
- [ ] Single signing secret → array `[currentSecret, previousSecret]`
      during the rotation window, drop the old one on the next deploy.
