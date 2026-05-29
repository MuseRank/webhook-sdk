import { createMuseRankWebhook } from "@muserank/webhook-sdk/nextjs";

import { claimEvent } from "../../../../lib/idempotency";

// Comma-separated form lets you keep the previous secret valid during
// a rotation window without redeploying. Empty entries are ignored by
// the SDK, so the trailing-comma case is safe.
const signingSecret = (process.env.MUSERANK_SIGNING_SECRET ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const POST = createMuseRankWebhook({
  accessToken: process.env.MUSERANK_WEBHOOK_TOKEN!,
  signingSecret: signingSecret.length > 1 ? signingSecret : signingSecret[0],

  // 10 seconds is plenty for an upsert into your CMS. The default 30s
  // is safer if you're synchronously rebuilding indexes; tune to your
  // own infra.
  handlerTimeoutMs: 10_000,

  onArticlePublished: async (article, payload, ctx) => {
    if (!claimEvent(ctx.eventId)) {
      console.log(
        `[muserank] skipping retry for ${ctx.eventId} (already processed)`,
      );
      return;
    }
    console.log(
      `[muserank] article.published id=${article.id} title=${JSON.stringify(article.title)} delivery=${ctx.deliveryId ?? "n/a"}`,
    );
    // TODO: replace with your real upsert, e.g.:
    //   await prisma.article.upsert({ where: { externalId: article.id }, ... });
  },

  onArticleUpdated: async (article, _payload, ctx) => {
    if (!claimEvent(ctx.eventId)) return;
    console.log(`[muserank] article.updated id=${article.id}`);
  },

  onTestPing: async (_payload, ctx) => {
    console.log(`[muserank] test.ping received (event_id=${ctx.eventId})`);
  },

  // Ack-and-drop poison messages. We never want MuseRank to retry a
  // permanently broken receiver-side bug into a 5xx loop.
  onError: (error) => {
    console.error("[muserank] handler failed:", error);
    if (error.message.includes("UNIQUE constraint failed")) {
      // Your DB already has this row — definitely don't retry.
      return { statusCode: 200, success: true, message: "duplicate ignored" };
    }
    // Otherwise let the default 500 propagate so MuseRank backs off
    // and retries the event.
    return undefined;
  },

  debug: process.env.NODE_ENV !== "production",
});
