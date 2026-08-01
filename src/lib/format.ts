import type { VideoStatus } from './types';

/** `95` → `1:35`. Negative and non-finite input reads as `0:00`. */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.round(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Coarse relative time. Deliberately stops at days — anything older is better
 * served by an absolute date than by "3 months ago".
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';

  const diff = then - now.getTime();
  const future = diff > 0;
  const mins = Math.round(Math.abs(diff) / 60_000);

  if (mins < 1) return future ? 'in a moment' : 'just now';
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;

  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return future ? `in ${days}d` : `${days}d ago`;

  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_LABELS: Record<VideoStatus, string> = {
  queued: 'Queued',
  writing: 'Writing script',
  narrating: 'Recording voiceover',
  illustrating: 'Generating visuals',
  rendering: 'Rendering',
  ready: 'Ready',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
};

export function statusLabel(status: VideoStatus): string {
  return STATUS_LABELS[status];
}
