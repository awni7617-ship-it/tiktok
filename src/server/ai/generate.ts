import type { ContentNiche, GeneratedContent, PlatformId, ScriptScene } from '@/lib/types';
import { dedupeHashtags, estimateSpeechDuration } from '@/lib/text';
import { round } from '@/lib/time';
import { getLlm, withRetry } from './registry';
import { generatedContentSchema, parseGeneratedContent, toJsonSchema } from './schemas';

/**
 * AI content generation: prompt or script in, production-ready package out.
 *
 * The system prompt is a constant so it caches across calls, and it encodes
 * the craft knowledge that makes short-form work — hook-first structure,
 * spoken-not-written narration, concrete visual direction per scene. That
 * detail is what separates a usable script from a paragraph of prose.
 */

const SYSTEM_PROMPT = `You are a senior short-form video writer and producer. You write scripts for vertical video (TikTok, Reels, Shorts) that hold attention from the first frame.

Rules you always follow:
- The hook is one sentence, lands in under two seconds when spoken, and creates a specific open loop. Never open with a greeting, a channel name, or "in this video".
- Write narration for the ear, not the page: short sentences, contractions, concrete nouns, no semicolons, no bullet-point phrasing read aloud.
- Every scene needs a visual that could actually be shot or sourced. "Relevant imagery" is not a visual direction; "hands closing a laptop in a dark office" is.
- Pace for retention: a new idea, image or turn at least every three seconds.
- The call to action is one line, specific, and matches the content. Never stack multiple asks.
- Hashtags are lowercase, relevant, and mix one broad tag with several specific ones.
- Never invent statistics, quotes, studies, or named sources. If a factual claim would strengthen the script and you are not certain of it, write the line so it works without the number.
- Match the requested duration by controlling scene count, not by padding narration.

Return the complete package: title and alternates, hook and alternates, full script, scene breakdown, description, hashtags, CTA and thumbnail concepts.`;

export interface GenerateContentOptions {
  /** The creator's idea, topic or full script. */
  prompt: string;
  niche?: ContentNiche;
  targetDurationSec?: number;
  /** Tone directions such as "deadpan", "urgent", "warm". */
  tone?: string;
  /** Where this will be published; affects length and CTA phrasing. */
  platform?: PlatformId;
  /** Treat `prompt` as a finished script to be structured rather than written. */
  useAsScript?: boolean;
  language?: string;
}

export interface GenerateContentResult {
  content: GeneratedContent;
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
}

export async function generateContent(
  options: GenerateContentOptions,
): Promise<GenerateContentResult> {
  const llm = getLlm();
  const schema = toJsonSchema(generatedContentSchema);

  const result = await withRetry(
    () =>
      llm.completeJson({
        system: SYSTEM_PROMPT,
        cacheSystem: true,
        maxTokens: 8000,
        messages: [{ role: 'user', content: buildUserPrompt(options) }],
        schema,
        parse: parseGeneratedContent,
      }),
    { label: 'generateContent' },
  );

  return {
    content: normalizeContent(result.value, options),
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    provider: llm.name,
  };
}

export function buildUserPrompt(options: GenerateContentOptions): string {
  const parts: string[] = [];

  if (options.useAsScript) {
    parts.push(
      'Structure the following script into a production package. Keep the writer\'s voice and wording wherever it already works; only tighten lines that drag or bury the point.',
      '',
      'SCRIPT:',
      options.prompt,
    );
  } else {
    parts.push('Write a short-form video from this idea:', '', options.prompt);
  }

  parts.push('');
  if (options.niche) parts.push(`Content type: ${options.niche.replace(/-/g, ' ')}`);
  if (options.targetDurationSec) {
    parts.push(
      `Target length: ${options.targetDurationSec} seconds of spoken narration (roughly ${Math.round(
        (options.targetDurationSec / 60) * 150,
      )} words).`,
    );
  }
  if (options.tone) parts.push(`Tone: ${options.tone}`);
  if (options.platform) parts.push(`Primary platform: ${platformGuidance(options.platform)}`);
  if (options.language && options.language !== 'en') {
    parts.push(`Write everything in ${options.language}.`);
  }

  return parts.join('\n');
}

function platformGuidance(platform: PlatformId): string {
  switch (platform) {
    case 'tiktok':
      return 'TikTok — conversational, native, no polish-for-polish-sake; the CTA can be a question.';
    case 'youtube':
      return 'YouTube Shorts — slightly more informational framing; the title carries more weight.';
    case 'instagram':
      return 'Instagram Reels — visually led; the on-screen text matters as much as the narration.';
    case 'linkedin':
      return 'LinkedIn — professional register, insight-first, no slang, CTA invites discussion.';
    case 'facebook':
      return 'Facebook — broader audience, assume less context, spell out the stakes early.';
    case 'pinterest':
      return 'Pinterest — how-to and inspiration framing; the first frame must read as a promise.';
    case 'x':
      return 'X — fast, opinionated, front-load the claim.';
    default:
      return platform;
  }
}

/**
 * Post-process the model's output.
 *
 * The schema guarantees shape but not consistency: scene indices can be
 * non-contiguous, durations can drift from the narration length, and hashtags
 * arrive in mixed formats. Normalising here means the rest of the system can
 * trust the values.
 */
export function normalizeContent(
  content: GeneratedContent,
  options: GenerateContentOptions,
): GeneratedContent {
  const scenes: ScriptScene[] = content.scenes.map((scene, index) => {
    const spoken = estimateSpeechDuration(scene.narration);
    return {
      ...scene,
      index,
      // Trust our own estimate over the model's when they disagree materially.
      estimatedDurationSec:
        Math.abs(spoken - scene.estimatedDurationSec) > spoken * 0.4
          ? round(spoken, 2)
          : round(scene.estimatedDurationSec, 2),
      brollQueries: scene.brollQueries.slice(0, 4),
    };
  });

  const total = round(
    scenes.reduce((sum, scene) => sum + scene.estimatedDurationSec, 0),
    1,
  );

  return {
    ...content,
    niche: options.niche ?? content.niche,
    scenes,
    estimatedDurationSec: total,
    hashtags: dedupeHashtags(content.hashtags, 20),
    titleVariants: content.titleVariants.filter((variant) => variant !== content.title).slice(0, 5),
    hookVariants: content.hookVariants.filter((variant) => variant !== content.hook).slice(0, 5),
  };
}

/**
 * Regenerate a single field without rewriting the whole package.
 *
 * Used by the "give me another hook" style controls, which need to keep the
 * rest of the script stable so the user does not lose their edits.
 */
export async function regenerateField(
  content: GeneratedContent,
  field: 'title' | 'hook' | 'description' | 'callToAction' | 'hashtags',
  instruction?: string,
): Promise<string[]> {
  const llm = getLlm();

  const asks: Record<typeof field, string> = {
    title: 'Write 5 alternative titles, each under 90 characters.',
    hook: 'Write 5 alternative opening hooks. Each must land in under two seconds when spoken.',
    description: 'Write 3 alternative descriptions, each under 300 characters.',
    callToAction: 'Write 5 alternative single-line calls to action.',
    hashtags: 'List 15 relevant lowercase hashtags, one per line, no commentary.',
  };

  const response = await withRetry(
    () =>
      llm.complete({
        system: SYSTEM_PROMPT,
        cacheSystem: true,
        maxTokens: 1200,
        messages: [
          {
            role: 'user',
            content: [
              `Here is the current video:`,
              `Title: ${content.title}`,
              `Hook: ${content.hook}`,
              `Script: ${content.script.slice(0, 2000)}`,
              '',
              asks[field],
              instruction ? `Additional direction: ${instruction}` : '',
              'Return one option per line with no numbering and no extra commentary.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        ],
      }),
    { label: `regenerate:${field}` },
  );

  if (response.refused) return [];

  const lines = response.text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

  return field === 'hashtags' ? dedupeHashtags(lines, 20) : lines.slice(0, 5);
}
