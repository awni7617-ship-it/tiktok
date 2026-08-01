import { describe, expect, it } from 'vitest';
import {
  assTimestamp,
  buildAssSubtitles,
  buildCues,
  chunkText,
  escapeAss,
} from '@/server/video/captions';

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('keeps a short line as one chunk of one line', () => {
    expect(chunkText('Short line here')).toEqual([['Short line here']]);
  });

  it('never exceeds two lines per chunk', () => {
    const chunks = chunkText(
      'This is a considerably longer piece of narration that must be split across several caption chunks to stay readable',
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2);
  });

  it('breaks on words, never mid-word', () => {
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'.split(' ');
    const rendered = chunkText(words.join(' '))
      .flat()
      .join(' ')
      .split(/\s+/);

    expect(rendered).toEqual(words);
  });

  it('gives an over-long word its own line rather than splitting it', () => {
    const long = 'supercalifragilisticexpialidocious';
    const chunks = chunkText(`a ${long} b`);

    expect(chunks.flat()).toContain(long);
  });
});

describe('buildCues', () => {
  it('returns nothing when there is no text or no time', () => {
    expect(buildCues('', 0, 5)).toEqual([]);
    expect(buildCues('some words', 0, 0)).toEqual([]);
    expect(buildCues('some words', 0, -3)).toEqual([]);
  });

  it('covers exactly the scene window without gaps or overlap', () => {
    const cues = buildCues(
      'One two three four five six seven eight nine ten eleven twelve thirteen fourteen',
      10,
      8,
    );

    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]!.start).toBe(10);
    expect(cues.at(-1)!.end).toBeCloseTo(18, 6);

    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.start).toBeCloseTo(cues[i - 1]!.end, 6);
    }
  });

  it('gives a chunk holding more text more time', () => {
    const cues = buildCues('Hi. Then a considerably longer stretch of narration follows here', 0, 10);
    const spans = cues.map((cue) => ({ chars: cue.lines.join(' ').length, span: cue.end - cue.start }));

    const shortest = spans.reduce((a, b) => (a.chars <= b.chars ? a : b));
    const longest = spans.reduce((a, b) => (a.chars >= b.chars ? a : b));

    expect(longest.span).toBeGreaterThan(shortest.span);
  });

  it('pins the last cue to the scene end so rounding cannot drift', () => {
    const cues = buildCues('a b c d e f g h i j k l m n o p q r s t u v', 3.3333, 7.7777);
    expect(cues.at(-1)!.end).toBeCloseTo(3.3333 + 7.7777, 6);
  });
});

describe('escapeAss', () => {
  it('neutralises braces, which would open an override block', () => {
    const escaped = escapeAss('a {b} c');

    expect(escaped).not.toContain('{');
    expect(escaped).not.toContain('}');
  });

  it('removes backslashes, which would be read as override codes', () => {
    expect(escapeAss('a\\Nb')).not.toContain('\\');
  });

  it('flattens a real newline, which would end the event early', () => {
    expect(escapeAss('a\nb')).toBe('a b');
    expect(escapeAss('a\r\nb')).toBe('a b');
  });

  it('leaves ordinary punctuation alone', () => {
    // Commas are safe: only the first nine dialogue fields are comma-split.
    expect(escapeAss('Time: 10%, and — this.')).toBe('Time: 10%, and — this.');
  });
});

describe('assTimestamp', () => {
  it('formats as H:MM:SS.cc', () => {
    expect(assTimestamp(0)).toBe('0:00:00.00');
    expect(assTimestamp(5.25)).toBe('0:00:05.25');
    expect(assTimestamp(65.5)).toBe('0:01:05.50');
    expect(assTimestamp(3661.1)).toBe('1:01:01.10');
  });

  it('carries instead of printing a hundredth of 100', () => {
    expect(assTimestamp(5.999)).toBe('0:00:06.00');
  });

  it('never emits a negative time', () => {
    expect(assTimestamp(-4)).toBe('0:00:00.00');
  });
});

describe('buildAssSubtitles', () => {
  const file = buildAssSubtitles(
    [
      { narration: 'First scene narration here', start: 0, seconds: 4 },
      { narration: 'Second scene narration here', start: 4, seconds: 4 },
    ],
    1080,
    1920,
  );

  it('declares the real frame size so libass does not rescale', () => {
    expect(file).toContain('PlayResX: 1080');
    expect(file).toContain('PlayResY: 1920');
  });

  it('declares exactly as many style fields as the format line names', () => {
    // A mismatch here shifts every value after it and libass draws nothing —
    // which fails silently, as a rendered video with no captions.
    const format = file.split('\n').find((line) => line.startsWith('Format: Name,'))!;
    const style = file.split('\n').find((line) => line.startsWith('Style:'))!;

    expect(style.replace(/^Style:\s*/, '').split(',')).toHaveLength(
      format.replace(/^Format:\s*/, '').split(',').length,
    );
  });

  it('writes a dialogue event for every cue, in order', () => {
    const events = file.split('\n').filter((line) => line.startsWith('Dialogue:'));

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(file).toContain('First scene');
    expect(file).toContain('Second scene');
  });

  it('breaks a two-line cue with the ASS hard break', () => {
    const wrapped = buildAssSubtitles(
      [{ narration: 'A considerably longer line that has to wrap onto two', start: 0, seconds: 5 }],
      1080,
      1920,
    );

    expect(wrapped).toContain('\\N');
  });

  it('produces a header even when there is nothing to say', () => {
    const empty = buildAssSubtitles([], 1080, 1920);

    expect(empty).toContain('[Events]');
    expect(empty.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(0);
  });
});
