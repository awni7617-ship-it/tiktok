import { config } from '@/server/config';

/**
 * In-process sliding-window rate limiter.
 *
 * Suitable for a single instance or a small fleet where approximate limits are
 * acceptable. The interface is deliberately async so a Redis-backed
 * implementation can be dropped in for a horizontally scaled deployment
 * without touching any call site.
 */

interface Bucket {
  /** Request timestamps inside the current window, oldest first. */
  hits: number[];
  expiresAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Unix ms at which the window resets. */
  resetAt: number;
  /** Seconds the caller should wait, for the `Retry-After` header. */
  retryAfterSec: number;
}

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
}

export async function rateLimit(
  key: string,
  options: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const windowMs = options.windowMs ?? config.RATE_LIMIT_WINDOW_MS;
  const max = options.max ?? config.RATE_LIMIT_MAX;
  const now = Date.now();

  sweep(now);

  const bucket = buckets.get(key) ?? { hits: [], expiresAt: now + windowMs };
  // Sliding window: drop hits that have aged out rather than resetting on a
  // fixed boundary, which would let a caller burst 2x across the boundary.
  bucket.hits = bucket.hits.filter((time) => now - time < windowMs);

  const oldest = bucket.hits[0] ?? now;
  const resetAt = oldest + windowMs;

  if (bucket.hits.length >= max) {
    bucket.expiresAt = resetAt;
    buckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  bucket.hits.push(now);
  bucket.expiresAt = now + windowMs;
  buckets.set(key, bucket);

  return {
    allowed: true,
    remaining: max - bucket.hits.length,
    resetAt,
    retryAfterSec: 0,
  };
}

/** Drop expired buckets so the map cannot grow without bound. */
function sweep(now: number): void {
  if (now - lastSweep < 30_000) return;
  lastSweep = now;

  for (const [key, bucket] of buckets) {
    if (bucket.expiresAt < now) buckets.delete(key);
  }
}

/** Tighter limits for endpoints an attacker would target. */
export const RATE_LIMITS = {
  login: { windowMs: 15 * 60_000, max: 8 },
  register: { windowMs: 60 * 60_000, max: 5 },
  passwordReset: { windowMs: 60 * 60_000, max: 5 },
  aiGenerate: { windowMs: 60_000, max: 20 },
  upload: { windowMs: 60_000, max: 30 },
  publish: { windowMs: 60_000, max: 20 },
  oauth: { windowMs: 60_000, max: 15 },
} as const;

export function resetRateLimits(): void {
  buckets.clear();
}

/** Best-effort client IP from the usual proxy headers. */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headers.get('x-real-ip') ?? headers.get('cf-connecting-ip') ?? 'unknown';
}
