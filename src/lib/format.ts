/**
 * Display formatters shared by server and client components.
 *
 * These must not live in a `'use client'` module: a server component that
 * formats a number before rendering would be calling across the boundary,
 * which Next.js correctly refuses.
 */

/** `12500` → `12.5K`, `3_200_000` → `3.2M`. */
export function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(value));
}

/** `2026-03-04` → `Mar 4`. Parsed as UTC so the label matches the bucket. */
export function formatDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}
