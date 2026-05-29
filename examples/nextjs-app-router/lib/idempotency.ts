/**
 * Toy in-memory dedup keyed on `event_id`.
 *
 * Real receivers should swap this for a durable store — typically a
 * Postgres table with `event_id text PRIMARY KEY` and an
 * `INSERT ... ON CONFLICT DO NOTHING` to atomically claim ownership
 * of the event. Two requests racing for the same `event_id` then both
 * see "no row was inserted" except the winner, and the loser
 * ack-and-drops without re-running side effects.
 */

const seen = new Set<string>();

/**
 * Returns `true` the first time we've seen this event id, `false` on
 * every subsequent retry. Synchronous to keep the example tight.
 */
export function claimEvent(eventId: string): boolean {
  if (seen.has(eventId)) return false;
  seen.add(eventId);
  return true;
}
