# Express · MuseRank webhook receiver

Minimal Node + Express server that receives MuseRank webhooks via
`@muserank/webhook-sdk/express`.

Demonstrates the **production-recommended** raw-body pattern:
`express.json()` keeps doing JSON parsing for the rest of the app, while
`createRawBodyVerifier` captures the exact bytes for HMAC verification.

## Run it

```bash
cd examples/express
cp .env.example .env
bun install
bun run dev   # http://localhost:3000
```

Point your tunnel + the MuseRank dashboard at
`http://localhost:3000/api/webhooks/muserank`.

## Files

- `src/server.ts` — wires `createRawBodyVerifier` into `express.json()`
  and mounts the SDK middleware. Includes a synthetic
  `UNIQUE`-constraint-style error to show how `onError` overrides the
  response.
- `.env.example` — env vars the handler reads.

## Why this layout?

When `signingSecret` is set, the SDK insists on a raw string body so
HMAC verification doesn't drift over JSON whitespace re-formatting.
The `verify` hook on `express.json` is the cheapest, safest place to
capture those bytes — see the SDK README's "Raw Body Preservation"
section for the rationale.
