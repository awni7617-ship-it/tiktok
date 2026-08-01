import { describe, expect, it } from 'vitest';
import { extractJson, parseScript, stripFence } from '@/server/ai/schema';

const valid = {
  hook: 'A hook line',
  scenes: [
    { narration: 'First line of narration', visual: 'a quiet room' },
    { narration: 'Second line', visual: 'a wide landscape' },
  ],
  caption: 'A caption',
  hashtags: ['history', 'facts'],
};

describe('stripFence', () => {
  it('removes a json code fence', () => {
    expect(stripFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('removes a bare fence', () => {
    expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('leaves unfenced text alone', () => {
    expect(stripFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('extractJson', () => {
  it('finds the object after a preamble', () => {
    expect(extractJson('Here is the script: {"a":1} — enjoy')).toBe('{"a":1}');
  });

  it('matches the outermost braces, not the first close', () => {
    expect(extractJson('{"a":{"b":2},"c":3}')).toBe('{"a":{"b":2},"c":3}');
  });

  it('is not fooled by braces inside strings', () => {
    const raw = '{"a":"a } brace","b":1}';
    expect(extractJson(raw)).toBe(raw);
  });

  it('is not fooled by an escaped quote', () => {
    const raw = '{"a":"say \\" }","b":1}';
    expect(extractJson(raw)).toBe(raw);
  });
});

describe('parseScript', () => {
  it('parses a well-formed script', () => {
    const script = parseScript(JSON.stringify(valid));

    expect(script.hook).toBe('A hook line');
    expect(script.scenes).toHaveLength(2);
    expect(script.hashtags).toEqual(['history', 'facts']);
  });

  it('parses a fenced script with a preamble', () => {
    const script = parseScript(`Sure! Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
    expect(script.scenes).toHaveLength(2);
  });

  it('strips leading hashes from hashtags', () => {
    const script = parseScript(JSON.stringify({ ...valid, hashtags: ['#one', '##two'] }));
    expect(script.hashtags).toEqual(['one', 'two']);
  });

  it('falls back to the hook when the caption is empty', () => {
    const script = parseScript(JSON.stringify({ ...valid, caption: '' }));
    expect(script.caption).toBe('A hook line');
  });

  it('defaults missing optional fields', () => {
    const script = parseScript(JSON.stringify({ hook: 'H', scenes: valid.scenes }));

    expect(script.hashtags).toEqual([]);
    expect(script.caption).toBe('H');
  });

  it('rejects text that is not JSON at all', () => {
    expect(() => parseScript('I cannot help with that.')).toThrow(/valid JSON/i);
  });

  it('rejects a script with no scenes, which would render an empty video', () => {
    expect(() => parseScript(JSON.stringify({ ...valid, scenes: [] }))).toThrow(/unusable/i);
  });

  it('rejects a scene missing its visual', () => {
    const broken = { ...valid, scenes: [{ narration: 'words' }] };
    expect(() => parseScript(JSON.stringify(broken))).toThrow(/unusable/i);
  });

  it('names the offending field so the failure is diagnosable', () => {
    const broken = { ...valid, hook: '' };
    expect(() => parseScript(JSON.stringify(broken))).toThrow(/hook/);
  });
});
