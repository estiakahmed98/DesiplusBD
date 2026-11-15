import "server-only";
import { Redis } from "@upstash/redis";

// A viewer counts as "live" while its tab keeps sending heartbeats.
// The client heartbeats every 15s, so 40s tolerates one missed beat.
export const LIVE_VIEWER_TTL_MS = 40_000;

let redis: Redis | null | undefined;
function getRedis(): Redis | null {
  if (redis !== undefined) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  redis = url && token ? new Redis({ url, token }) : null;
  return redis;
}

// Fallback for local dev / single-instance deployments without Redis.
const memory = new Map<number, Map<string, number>>();

function memoryTouch(productId: number, visitorId: string, leave: boolean, now: number) {
  let viewers = memory.get(productId);
  if (!viewers) memory.set(productId, (viewers = new Map()));
  if (leave) viewers.delete(visitorId);
  else viewers.set(visitorId, now);
  for (const [id, seenAt] of viewers) {
    if (seenAt <= now - LIVE_VIEWER_TTL_MS) viewers.delete(id);
  }
  if (!viewers.size) memory.delete(productId);
  return viewers.size;
}

/** Record a heartbeat (or departure) and return the number of real live viewers. */
export async function touchProductViewer(
  productId: number,
  visitorId: string,
  leave = false,
): Promise<number> {
  const now = Date.now();
  const client = getRedis();
  if (!client) return memoryTouch(productId, visitorId, leave, now);

  const key = `product-viewers:${productId}`;
  const count = await client.eval(
    `if ARGV[4] == '1' then redis.call('ZREM', KEYS[1], ARGV[2])
     else redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) end
     redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[3])
     redis.call('PEXPIRE', KEYS[1], ARGV[3])
     return redis.call('ZCARD', KEYS[1])`,
    [key],
    [String(now), visitorId, String(LIVE_VIEWER_TTL_MS), leave ? "1" : "0"],
  );
  return Number(count) || 0;
}
