import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import { config } from "./config.ts";

const MINUTE = 60_000;
const windows = new Map<string, { start: number; count: number }>();

setInterval(() => {
  const cutoff = Date.now() - MINUTE;
  for (const [ip, w] of windows) if (w.start < cutoff) windows.delete(ip);
}, MINUTE).unref();

export function clientIp(c: Parameters<MiddlewareHandler>[0]): string {
  if (config.trustProxy === "cloudflare") {
    const ip = c.req.header("cf-connecting-ip")?.trim();
    if (ip) return ip;
  } else if (config.trustProxy === "true") {
    // Clients can put anything at the start of X-Forwarded-For; only the entry appended by the
    // nearest proxy is trustworthy.
    const ip = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (ip) return ip;
  }
  return getConnInfo(c).remote.address ?? "unknown";
}

/** Fixed one-minute window per client IP. */
export const rateLimit: MiddlewareHandler = async (c, next) => {
  const limit = config.rateLimitPerMinute;
  if (limit <= 0) return next();

  const now = Date.now();
  const ip = clientIp(c);
  let w = windows.get(ip);
  if (!w || now - w.start >= MINUTE) windows.set(ip, (w = { start: now, count: 0 }));
  w.count++;

  const reset = Math.ceil((w.start + MINUTE - now) / 1000);
  c.header("x-ratelimit-limit", String(limit));
  c.header("x-ratelimit-remaining", String(Math.max(0, limit - w.count)));
  c.header("x-ratelimit-reset", String(reset));
  if (w.count > limit) {
    c.header("retry-after", String(reset));
    return c.json({ error: `Rate limit of ${limit} requests per minute exceeded` }, 429);
  }
  return next();
};
