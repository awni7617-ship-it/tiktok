import { describe, expect, it } from 'vitest';
import { duration, fileSize, relativeTime, statusLabel } from '@/lib/format';
import { slug } from '@/lib/id';
import { nextIdea } from '@/server/content/ideas';
import { NICHES } from '@/lib/catalog';
import type { Video } from '@/lib/types';

describe('duration', () => {
  it('formats seconds as m:ss', () => {
    expect(duration(0)).toBe('0:00');
    expect(duration(9)).toBe('0:09');
    expect(duration(95)).toBe('1:35');
    expect(duration(3600)).toBe('60:00');
  });

  it('reads nonsense as zero rather than NaN:NaN', () => {
    expect(duration(null)).toBe('0:00');
    expect(duration(undefined)).toBe('0:00');
    expect(duration(-5)).toBe('0:00');
    expect(duration(Number.NaN)).toBe('0:00');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

  it('describes the recent past', () => {
    expect(relativeTime(ago(10_000), now)).toBe('just now');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('5m ago');
    expect(relativeTime(ago(3 * 3_600_000), now)).toBe('3h ago');
    expect(relativeTime(ago(2 * 86_400_000), now)).toBe('2d ago');
  });

  it('describes the near future, which is where scheduled posts live', () => {
    expect(relativeTime(ahead(5 * 60_000), now)).toBe('in 5m');
    expect(relativeTime(ahead(3 * 3_600_000), now)).toBe('in 3h');
    expect(relativeTime(ahead(2 * 86_400_000), now)).toBe('in 2d');
  });

  it('switches to a date beyond a week', () => {
    expect(relativeTime(ago(30 * 86_400_000), now)).toMatch(/\w/);
    expect(relativeTime(ago(30 * 86_400_000), now)).not.toContain('ago');
  });

  it('does not crash on an unparseable date', () => {
    expect(relativeTime('not a date', now)).toBe('—');
  });
});

describe('fileSize', () => {
  it('scales the unit to the size', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(2048)).toBe('2 KB');
    expect(fileSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('refuses to render nonsense', () => {
    expect(fileSize(-1)).toBe('—');
    expect(fileSize(Number.NaN)).toBe('—');
  });
});

describe('statusLabel', () => {
  it('has a human label for every status', () => {
    expect(statusLabel('illustrating')).toBe('Generating visuals');
    expect(statusLabel('published')).toBe('Published');
  });
});

describe('slug', () => {
  it('makes a filesystem-safe name', () => {
    expect(slug('A Video: About Things!')).toBe('a-video-about-things');
  });

  it('never returns an empty name', () => {
    expect(slug('!!!')).toBe('untitled');
    expect(slug('')).toBe('untitled');
  });

  it('does not end on a separator after truncation', () => {
    expect(slug('word '.repeat(40))).not.toMatch(/-$/);
  });
});

describe('nextIdea', () => {
  const video = (n: number): Video =>
    ({ idea: `idea ${n}` }) as Video;

  it('rotates through the niche seeds instead of repeating one', () => {
    const first = nextIdea('space', []);
    const second = nextIdea('space', [video(1)]);

    expect(first).not.toBe(second);
  });

  it('wraps back around once the seeds are used up', () => {
    const seeds = NICHES.find((n) => n.id === 'space')!.seeds.length;
    const history = Array.from({ length: seeds }, (_, i) => video(i));

    expect(nextIdea('space', history)).toBe(nextIdea('space', []));
  });

  it('still returns something for an unknown niche', () => {
    expect(nextIdea('does-not-exist', [])).toBeTruthy();
  });
});
