import type { ContentNiche } from '@/lib/types';

/**
 * Prompt construction for the studio.
 *
 * The single biggest quality lever here is telling the models what the thing
 * they are writing for actually *is*. A script model that does not know each
 * scene becomes one still image with a burned-in caption writes visual
 * directions no image model can render ("cut to a montage of the 1970s"), and
 * an image model handed a raw scene description produces stock-photo mush
 * with garbled text baked into it.
 */

/** What the production pipeline can actually render, stated plainly. */
export const PIPELINE_BRIEF = `You are writing for a specific production pipeline. Know exactly what it can render:

- The finished video is vertical 9:16, for TikTok, Reels and Shorts.
- Each scene becomes ONE still image, held on screen with a slow push-in, while one line of narration is spoken over it.
- Scenes are joined by a short crossfade. There is no live action, no camera crew, no actors, and no motion within a shot.
- The narration is spoken by a synthetic voice. Write for that voice: no stage directions, no sound effects, no "[pause]", no emoji, no asterisks.
- Captions are burned in automatically from your narration, word for word. Do not write captions, on-screen text, or "text appears" — and never ask for words to appear inside an image, because image models render text badly.
- A scene lasts as long as its narration takes to speak, roughly 2 to 6 seconds. One idea per scene.

Therefore every "visual" you write must be a single photographable still: one subject, one moment, one place. "A montage of ancient civilisations" cannot be rendered. "A cracked stone tablet half-buried in red desert sand, low sun" can.`;

/**
 * Per-niche direction for both the writing and the imagery.
 *
 * Generic prompts produce generic videos: the same neutral voice and the same
 * blue-grey stock imagery whether the subject is a haunted lighthouse or a
 * quarterly earnings report.
 */
const NICHE_DIRECTION: Partial<Record<ContentNiche, { writing: string; look: string }>> = {
  'scary-story': {
    writing:
      'Build dread through specific, ordinary detail rather than gore. Short sentences. The scariest line should be delivered flatly.',
    look: 'desaturated, deep shadows, single cold light source, fog, 35mm grain, unsettling emptiness',
  },
  mystery: {
    writing: 'Withhold. Each scene should answer one question and open another.',
    look: 'moody chiaroscuro, rain-slick surfaces, dim practical lights, muted palette, shallow depth of field',
  },
  'reddit-story': {
    writing:
      'Conversational and specific, like someone telling a friend. Concrete stakes, real dialogue, no narration voice-over clichés.',
    look: 'candid, warm domestic interiors, natural window light, lived-in detail, slightly imperfect framing',
  },
  educational: {
    writing:
      'One clear idea, built from a concrete example before the abstraction. No jargon without an immediate plain-English gloss.',
    look: 'clean, bright, high-key lighting, single clear subject on uncluttered background, documentary clarity',
  },
  motivational: {
    writing: 'Earn the lift with a specific struggle. No platitudes, no "grind" clichés.',
    look: 'golden hour, backlit rim light, wide open spaces, warm highlights, aspirational but grounded',
  },
  gaming: {
    writing: 'Fast, punchy, present tense. Assume the viewer knows the genre.',
    look: 'saturated neon, screen glow, high contrast, dynamic angles, cyber palette',
  },
  football: {
    writing: 'Match-day energy. Specific players, specific moments, real stakes.',
    look: 'stadium floodlights, dramatic low angles, motion-frozen action, rich turf green, crowd bokeh',
  },
  history: {
    writing:
      'Anchor every claim in a place and a date. Never invent quotes, statistics or named sources.',
    look: 'archival texture, aged paper and stone, warm sepia grade, museum lighting, tactile period detail',
  },
  finance: {
    writing:
      'Concrete numbers over vibes, and never a promise of returns. Explain the mechanism, not the hype.',
    look: 'clean modern interiors, glass and steel, cool neutral palette, restrained editorial photography',
  },
  business: {
    writing: 'A real decision with a real trade-off. Name the cost, not just the win.',
    look: 'modern workspace, natural light, calm neutral tones, uncluttered editorial composition',
  },
  technology: {
    writing: 'Explain what changes for the person using it, before how it works.',
    look: 'precise product photography, soft gradient backdrop, cool light, macro detail, minimal',
  },
  science: {
    writing: 'One mechanism, explained through something the viewer can picture.',
    look: 'laboratory clarity, macro detail, clean light, vivid natural colour, scientific photography',
  },
  documentary: {
    writing: 'Observational and specific. Let the detail carry the weight.',
    look: 'natural light, honest reportage framing, muted realistic grade, environmental context',
  },
  'product-review': {
    writing: 'Lead with the flaw you would want to know about. Be specific about who it suits.',
    look: 'clean product shots, soft studio light, neutral backdrop, crisp detail, honest scale',
  },
  'news-summary': {
    writing:
      'What happened, where, and why it matters — in that order. Attribute nothing you are not certain of.',
    look: 'photojournalistic, natural light, real locations, neutral grade, no staged composition',
  },
  storytelling: {
    writing: 'One character, one want, one obstacle. Land the turn before the last scene.',
    look: 'cinematic, shallow depth of field, motivated practical light, filmic colour grade',
  },
};

const DEFAULT_DIRECTION = {
  writing: 'Concrete, specific, and paced for retention.',
  look: 'cinematic, natural light, shallow depth of field, filmic colour grade',
};

export function nicheDirection(niche?: ContentNiche): { writing: string; look: string } {
  return (niche && NICHE_DIRECTION[niche]) || DEFAULT_DIRECTION;
}

/**
 * Turn a scene's visual direction into an image-model prompt.
 *
 * Three things are added that the script model should not have to think
 * about: the vertical framing the pipeline renders, the look the niche calls
 * for, and an explicit ban on text. The text ban matters more than it looks —
 * image models will happily bake misspelled words into a frame that already
 * has burned-in captions over it.
 */
export function buildImagePrompt(options: {
  visual: string;
  niche?: ContentNiche;
  tone?: string;
  /** Used only to vary framing so consecutive scenes do not look identical. */
  index?: number;
}): string {
  const direction = nicheDirection(options.niche);
  const framings = [
    'wide establishing shot',
    'medium shot, subject slightly off-centre',
    'close detail shot',
    'low angle looking up',
  ];
  const framing = framings[(options.index ?? 0) % framings.length];

  const parts = [
    options.visual.trim().replace(/\s+/g, ' '),
    `${framing}, vertical 9:16 composition with the subject in the upper two thirds`,
    direction.look,
    options.tone ? `mood: ${options.tone}` : null,
    'photographic, highly detailed, no text, no letters, no words, no watermark, no logo, no captions, no borders',
  ].filter(Boolean);

  return parts.join('. ');
}

/**
 * Leave the lower third clear.
 *
 * Captions are burned in near the bottom of the frame; a composition with its
 * subject centred low ends up with a face behind the words.
 */
export function captionSafeNote(): string {
  return 'Keep the lower third of the frame simple and free of important detail.';
}
