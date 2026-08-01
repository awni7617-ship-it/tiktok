import { z } from 'zod';
import type { Script } from '@/lib/types';

/**
 * Validation for model output.
 *
 * A language model returning JSON is still untrusted input: fields go missing,
 * arrays come back empty, and a model that was asked for prose occasionally
 * returns a fenced block. Everything downstream — the renderer especially —
 * assumes a well-formed script, so it gets checked once, here.
 */
const sceneSchema = z.object({
  narration: z.string().trim().min(1).max(600),
  visual: z.string().trim().min(1).max(600),
});

export const scriptSchema = z.object({
  hook: z.string().trim().min(1).max(200),
  scenes: z.array(sceneSchema).min(1).max(20),
  caption: z.string().trim().max(300).default(''),
  hashtags: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});

/** Strip a ```json fence if the model added one despite being told not to. */
export function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/**
 * Pull the outermost JSON object out of a response.
 *
 * Models sometimes prepend "Here is the script:" no matter how firmly they
 * were told not to. Finding the first `{` and its matching `}` recovers those
 * rather than failing the whole render over a preamble.
 */
export function extractJson(raw: string): string {
  const text = stripFence(raw);
  const start = text.indexOf('{');
  if (start === -1) return text;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

export function parseScript(raw: string): Script {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    throw new Error('The script model did not return valid JSON');
  }

  const result = scriptSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join('.') || 'response';
    throw new Error(`The script model returned an unusable script (${where}: ${issue?.message})`);
  }

  const { hook, scenes, caption, hashtags } = result.data;
  return {
    hook,
    scenes: scenes.map((s) => ({ narration: s.narration, visual: s.visual })),
    caption: caption || hook,
    // Normalise: models return "#tag" about half the time despite the brief.
    hashtags: hashtags.map((t) => t.replace(/^#+/, '')).filter(Boolean),
  };
}
