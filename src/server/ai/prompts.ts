import type { ScriptRequest } from './types';

/**
 * The brief handed to the script model.
 *
 * The important part is telling the model what its words physically become.
 * Without that, a script model writes "cut to a sweeping aerial montage" and
 * ""[dramatic pause]"" — directions this pipeline has no way to render — and
 * the image model bakes lettering into a frame that already has captions
 * burned over it. Every constraint below exists because its absence produced
 * a specific broken video.
 */
export function scriptSystemPrompt(): string {
  return [
    'You write scripts for short vertical narration videos.',
    '',
    'How your script is rendered, exactly:',
    '- Each scene becomes ONE still image with a slow push-in. There is no live',
    '  action, no camera movement you control, and no video footage.',
    '- The narration is read aloud by a text-to-speech voice and the captions are',
    '  burned in from that same text, word for word.',
    '- Scenes are cut together in order with short crossfades, over a quiet music bed.',
    '',
    'Therefore:',
    '- Narration is spoken prose only. No stage directions, no speaker labels, no',
    '  bracketed cues, no emoji, no markdown, no "[pause]".',
    '- Write out numbers, symbols and units as they should be said aloud:',
    '  "ninety per cent", not "90%".',
    '- Each visual prompt describes a SINGLE static image: subject, setting,',
    '  lighting, composition. No motion, no sequences, no "then".',
    '- Visual prompts must never ask for text, letters, numbers, captions, logos',
    '  or watermarks in the image.',
    '- The visual must be something an image model can actually depict. "The',
    '  concept of inflation" cannot be drawn; "a market stall with hand-written',
    '  price tags" can.',
    '',
    'Content rules:',
    '- Open with a concrete hook in the first sentence. No "in this video" and no',
    '  "have you ever wondered".',
    '- Be specific. Names, numbers and places beat adjectives.',
    '- State only things you are confident are true. If you are unsure of a date,',
    '  figure or attribution, write around it rather than guessing. Never invent a',
    '  quotation, study or statistic.',
    '- End on a resolved thought, not a call to subscribe.',
  ].join('\n');
}

export function scriptUserPrompt(request: ScriptRequest): string {
  // Roughly 2.6 words per second at a narration pace, and one scene per
  // ~6 seconds keeps images on screen long enough to read the caption.
  const words = Math.round(request.targetSeconds * 2.6);
  const scenes = Math.max(3, Math.min(12, Math.round(request.targetSeconds / 6)));

  return [
    `Topic: ${request.idea}`,
    '',
    `Channel brief: ${request.brief}`,
    '',
    `Target length: about ${request.targetSeconds} seconds — roughly ${words} words of narration in total, across ${scenes} scenes.`,
    '',
    'Return JSON only, matching this shape exactly:',
    '{',
    '  "hook": "the opening line, also used as the video title",',
    '  "scenes": [{ "narration": "spoken prose", "visual": "one still image" }],',
    '  "caption": "a caption for the post, under 150 characters",',
    '  "hashtags": ["five", "relevant", "tags", "without", "hashes"]',
    '}',
    '',
    'No prose outside the JSON. No code fences.',
  ].join('\n');
}
