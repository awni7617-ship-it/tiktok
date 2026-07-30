import type { TimeRange } from './types';

/** Clamp `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** Round to `decimals` places, avoiding `-0` and float dust like `0.30000000000000004`. */
export function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

export function duration(range: TimeRange): number {
  return Math.max(0, range.end - range.start);
}

/** `SS.mmm` → `HH:MM:SS.mmm`, the form ffmpeg and WebVTT both accept. */
export function formatTimecode(seconds: number, decimals = 3): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const secsStr = secs.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secsStr}`;
}

/** SRT uses a comma as the decimal separator; everything else matches WebVTT. */
export function formatSrtTimecode(seconds: number): string {
  return formatTimecode(seconds, 3).replace('.', ',');
}

/** ASS/SSA uses `H:MM:SS.cc` with centisecond precision and no zero padding on hours. */
export function formatAssTimecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${secs.toFixed(2).padStart(5, '0')}`;
}

export function parseTimecode(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

/** Human-friendly duration for the UI: `1:04`, `12:30`, `1:02:03`. */
export function humanDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** True when the two ranges share any time at all. */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function intersection(a: TimeRange, b: TimeRange): TimeRange | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/**
 * Merge overlapping or near-touching ranges into a minimal disjoint set.
 * Ranges closer together than `gapTolerance` are joined, which stops the cut
 * planner from emitting a stutter of 40ms cuts separated by 10ms of audio.
 */
export function mergeRanges<T extends TimeRange>(ranges: T[], gapTolerance = 0): TimeRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  let current: TimeRange = { start: sorted[0]!.start, end: sorted[0]!.end };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (next.start - current.end <= gapTolerance) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { start: next.start, end: next.end };
    }
  }
  merged.push(current);
  return merged;
}

/** Subtract `holes` from `base`, returning the surviving pieces in order. */
export function subtractRanges(base: TimeRange, holes: TimeRange[]): TimeRange[] {
  const merged = mergeRanges(holes);
  const result: TimeRange[] = [];
  let cursor = base.start;

  for (const hole of merged) {
    if (hole.end <= base.start || hole.start >= base.end) continue;
    if (hole.start > cursor) result.push({ start: cursor, end: Math.min(hole.start, base.end) });
    cursor = Math.max(cursor, hole.end);
  }
  if (cursor < base.end) result.push({ start: cursor, end: base.end });
  return result.filter((r) => r.end - r.start > 1e-6);
}

/** Total time covered by a set of (possibly overlapping) ranges. */
export function totalDuration(ranges: TimeRange[]): number {
  return mergeRanges(ranges).reduce((sum, r) => sum + (r.end - r.start), 0);
}
