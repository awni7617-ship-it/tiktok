import { describe, expect, it } from 'vitest';
import {
  buildSlideshowCommand,
  chunkText,
  planSceneTiming,
  type SlideshowScene,
} from '../src/server/studio/slideshow';

/**
 * The faceless video compiler.
 *
 * A broken filter graph fails after the expensive part — narration and
 * visuals are already generated — so the graph is asserted here rather than
 * discovered by a creator watching a progress bar reach 70% and stop.
 */

const scene = (overrides: Partial<SlideshowScene> = {}): SlideshowScene => ({
  imagePath: '/tmp/scene.png',
  audioPath: '/tmp/narration.wav',
  durationSec: 4,
  ...overrides,
});

const graphOf = (scenes: SlideshowScene[], extra = {}) =>
  buildSlideshowCommand({
    scenes,
    outputPath: '/tmp/out.mp4',
    width: 1080,
    height: 1920,
    fps: 30,
    ...extra,
  });

describe('slideshow graph', () => {
  it('refuses to render nothing', () => {
    expect(() => graphOf([])).toThrow(/at least one scene/i);
  });

  it('only references variables zoompan actually defines', () => {
    // `n` is not a zoompan variable. Using it fails the entire graph with
    // "Error reinitializing filters" — after every asset has been generated.
    const { filterGraph } = graphOf([scene(), scene(), scene()]);
    const zoompans = filterGraph.match(/zoompan=[^;]*/g) ?? [];

    expect(zoompans.length).toBe(3);
    for (const filter of zoompans) {
      expect(filter).not.toMatch(/(?<![a-z_])n(?![a-z_0-9])/);
    }
  });

  it('gives every scene its own image input in order', () => {
    const { args } = graphOf([
      scene({ imagePath: '/a.png' }),
      scene({ imagePath: '/b.png' }),
    ]);
    const images = args.filter((arg) => arg.endsWith('.png'));
    expect(images).toEqual(['/a.png', '/b.png']);
  });

  it('places narration at each scene start rather than concatenating', () => {
    // Concatenation lets a clip that is shorter than its scene drag every
    // later line earlier, and the drift compounds.
    const { filterGraph } = graphOf([
      scene({ durationSec: 5, audioPath: '/1.wav' }),
      scene({ durationSec: 3, audioPath: '/2.wav' }),
      scene({ durationSec: 4, audioPath: '/3.wav' }),
    ]);

    const delays = [...filterGraph.matchAll(/adelay=(\d+)\|/g)].map((match) => Number(match[1]));
    expect(delays).toEqual([0, 5000, 8000]);
  });

  it('accounts for transition overlap in both timing and audio placement', () => {
    const command = graphOf(
      [scene({ durationSec: 5 }), scene({ durationSec: 5 }), scene({ durationSec: 5 })],
      { transitionSec: 0.5 },
    );

    // Each crossfade eats its duration from the timeline: 15 − 2×0.5.
    expect(command.durationSec).toBeCloseTo(14, 3);

    const delays = [...command.filterGraph.matchAll(/adelay=(\d+)\|/g)].map((m) => Number(m[1]));
    expect(delays).toEqual([0, 5000, 9500]);

    const offsets = [...command.filterGraph.matchAll(/xfade=[^[\]]*offset=([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(offsets).toEqual([4.5, 9]);
  });

  it('holds on a silent scene instead of dropping it', () => {
    const { filterGraph, durationSec } = graphOf([
      scene({ durationSec: 3, audioPath: null }),
      scene({ durationSec: 2 }),
    ]);

    expect(durationSec).toBeCloseTo(5, 3);
    // The silent scene still gets a video chain, and the next clip's delay
    // accounts for the time it occupied.
    expect(filterGraph).toContain('[v0]');
    expect(filterGraph).toMatch(/adelay=3000\|/);
  });

  it('produces a video-only command when nothing has audio', () => {
    const { args, filterGraph } = graphOf([scene({ audioPath: null })]);
    expect(args).toContain('-an');
    expect(filterGraph).not.toContain('loudnorm');
  });

  it('ducks music under narration rather than mixing at a fixed level', () => {
    const { filterGraph } = graphOf([scene()], { musicPath: '/music.mp3' });
    expect(filterGraph).toContain('sidechaincompress');
    expect(filterGraph).toContain('loudnorm');
  });

  it('escapes subtitle paths so a colon cannot break the filter', () => {
    const { filterGraph } = graphOf([scene()], { subtitlePath: 'C:/videos/my captions.ass' });
    expect(filterGraph).toContain("subtitles='C\\:/videos/my captions.ass'");
  });

  it('reports progress to stdout so the UI bar can move', () => {
    const { args } = graphOf([scene()]);
    expect(args).toContain('-progress');
    expect(args).toContain('pipe:1');
  });
});

describe('scene timing', () => {
  it('times scenes from measured narration, not guesses', () => {
    const { durations } = planSceneTiming([
      { text: 'short line', narrationSec: 1.2 },
      { text: 'a much longer line that takes a while to say', narrationSec: 6 },
    ]);

    expect(durations[0]).toBeCloseTo(2, 1); // floored at the 2s minimum
    expect(durations[1]).toBeCloseTo(6.35, 2);
  });

  it('falls back to an estimate when a clip could not be measured', () => {
    const { durations } = planSceneTiming([{ text: 'x'.repeat(140), narrationSec: null }]);
    expect(durations[0]).toBeGreaterThan(9);
  });

  it('keeps cues inside their scene and in order', () => {
    const { cues, durations } = planSceneTiming([
      { text: 'one two three four five six seven eight nine ten eleven twelve', narrationSec: 4 },
      { text: 'second scene line', narrationSec: 2 },
    ]);

    expect(cues.length).toBeGreaterThan(2);
    for (const [index, cue] of cues.entries()) {
      expect(cue.end).toBeGreaterThan(cue.start);
      if (index > 0) expect(cue.start).toBeGreaterThanOrEqual(cues[index - 1]!.start);
    }

    const total = durations.reduce((sum, value) => sum + value, 0);
    expect(cues.at(-1)!.end).toBeLessThanOrEqual(total);
  });

  it('shares spoken time by length, so a short cue does not linger', () => {
    const { cues } = planSceneTiming(
      [{ text: `${'a'.repeat(40)} ${'b'.repeat(4)}`, narrationSec: 4 }],
      { maxCueChars: 42 },
    );

    expect(cues).toHaveLength(2);
    const first = cues[0]!.end - cues[0]!.start;
    const second = cues[1]!.end - cues[1]!.start;
    expect(first).toBeGreaterThan(second * 3);
  });
});

describe('caption chunking', () => {
  it('breaks on words, never mid-word', () => {
    const chunks = chunkText('the quick brown fox jumps over the lazy dog', 12);
    expect(chunks.every((chunk) => chunk.length <= 12 || !chunk.includes(' '))).toBe(true);
    expect(chunks.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('keeps a word longer than the limit rather than losing it', () => {
    expect(chunkText('antidisestablishmentarianism', 8)).toEqual(['antidisestablishmentarianism']);
  });

  it('returns nothing for empty input', () => {
    expect(chunkText('   ', 20)).toEqual([]);
  });
});
