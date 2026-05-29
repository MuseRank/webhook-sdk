import express from "express";
import {
  createMuseRankWebhook,
  createRawBodyVerifier,
} from "@muserank/webhook-sdk/express";

const app = express();
const port = Number(process.env.PORT ?? 3000);

const signingSecret = (process.env.MUSERANK_SIGNING_SECRET ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// `verify` runs while express.json() is reading the body, before
// parsing — the perfect spot to snapshot the raw bytes so HMAC
// verification doesn't fight whitespace re-serialization. We cap the
// body at 2 MB; the SDK separately enforces 1 MB by default and you
// can tighten either side independently.
app.use(
  "/api/webhooks/muserank",
  express.json({
    limit: "2mb",
    verify: createRawBodyVerifier({ maxBodySizeBytes: 2 * 1024 * 1024 }),
  }),
  createMuseRankWebhook({
    accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
    signingSecret:
      signingSecret.length > 1 ? signingSecret : signingSecret[0],
    handlerTimeoutMs: 10_000,

    onArticlePublished: async (article, _payload, ctx) => {
      console.log(
        `[muserank] article.published id=${article.id} event=${ctx.eventId}`,
      );
      // Replace with real upsert. Here we synthesize a unique-violation
      // path so the onError override below has something to demo.
      if (article.id === "demo-conflict") {
        const err = new Error("UNIQUE constraint failed: external_id");
        throw err;
      }
    },

    onTestPing: async (_payload, ctx) => {
      console.log(`[muserank] test.ping (event_id=${ctx.eventId})`);
    },

    // Response override: 200 on poison messages stops MuseRank
    // retrying. Anything else falls through to the default 500.
    onError: (error) => {
      if (error.message.startsWith("UNIQUE constraint")) {
        return {
          statusCode: 200,
          success: true,
          message: "duplicate ignored",
        };
      }
      return undefined;
    },

    debug: process.env.NODE_ENV !== "production",
  }),
);

app.get("/", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`MuseRank webhook receiver listening on :${port}`);
});
