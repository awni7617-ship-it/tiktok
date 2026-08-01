/**
 * The pickable options: niches, art styles, voices, music beds and cadences.
 *
 * These are plain data so the browser can render the pickers and the server
 * can validate against the same source. Adding a niche is a one-entry edit
 * here and nothing else.
 */

import type { Cadence, PlatformId } from './types';

export interface Niche {
  id: string;
  name: string;
  /** Shown under the name in the picker. */
  blurb: string;
  /** Steers the script model's subject matter and tone. */
  brief: string;
  /** Seeds the idea generator when autopilot needs a fresh topic. */
  seeds: string[];
}

export const NICHES: readonly Niche[] = [
  {
    id: 'strange-history',
    name: 'Strange history',
    blurb: 'Forgotten events, odd footnotes, things that actually happened',
    brief:
      'Little-known historical events and figures. Favour the specific and verifiable over the sensational. Never invent dates, names or quotes.',
    seeds: [
      'a medieval law that sounds invented but was real',
      'an ordinary person who changed an outcome by accident',
      'a building that outlived the country that built it',
      'an invention that was ignored for a century',
    ],
  },
  {
    id: 'space',
    name: 'Space and astronomy',
    blurb: 'Scale, distance, and things that are hard to picture',
    brief:
      'Astronomy and spaceflight. Lean on real numbers and comparisons that make scale intuitive. No speculation dressed as fact.',
    seeds: [
      'a distance that breaks your intuition',
      'what a probe found that nobody expected',
      'a place in the solar system with impossible weather',
      'how we know something we can never visit',
    ],
  },
  {
    id: 'psychology',
    name: 'Psychology',
    blurb: 'Why people do the thing they do',
    brief:
      'Human behaviour and cognition, grounded in named effects and real studies. Avoid pop-psych overreach and never state a study result you are unsure of.',
    seeds: [
      'a bias that changes how you read a room',
      'why a habit resists willpower',
      'a small change that shifts a decision',
      'what memory actually does when you recall something',
    ],
  },
  {
    id: 'money',
    name: 'Money and business',
    blurb: 'How businesses actually make money',
    brief:
      'Business models, pricing and economics explained plainly. Concrete mechanics over hustle-culture advice. No financial advice, no return promises.',
    seeds: [
      'a business that makes money in a surprising way',
      'why a product is priced the way it is',
      'a company that survived by changing what it sold',
      'the real margin behind something everyday',
    ],
  },
  {
    id: 'science',
    name: 'Science explained',
    blurb: 'One idea, made clear in under a minute',
    brief:
      'Physics, chemistry and biology explained for a general audience. One idea per video, built up in order. Accuracy beats drama.',
    seeds: [
      'an everyday thing whose mechanism is strange',
      'a limit nature imposes and why',
      'something two fields explain differently',
      'a question that sounds simple and is not',
    ],
  },
  {
    id: 'nature',
    name: 'Nature and animals',
    blurb: 'Species, behaviour, and the strange edges of biology',
    brief:
      'Animal behaviour and ecology. Favour specific species and documented behaviour over general wildlife narration.',
    seeds: [
      'an animal with an ability that seems impossible',
      'a survival strategy that looks like cruelty',
      'a species that engineers its own habitat',
      'a relationship between two species that benefits both',
    ],
  },
  {
    id: 'tech',
    name: 'Technology',
    blurb: 'How the thing in your pocket actually works',
    brief:
      'How technology works under the hood, and the history of how it got that way. Explain mechanisms, not product news.',
    seeds: [
      'a everyday feature that is harder than it looks',
      'why a standard is the way it is',
      'a technology that was solved decades before it shipped',
      'what happens in the second after you tap something',
    ],
  },
  {
    id: 'mystery',
    name: 'Unsolved mysteries',
    blurb: 'Open questions, presented honestly',
    brief:
      'Genuinely unresolved cases and questions. State clearly what is known, what is contested and what is unknown. Never imply a conclusion the evidence does not support.',
    seeds: [
      'a disappearance with a real paper trail',
      'an artefact nobody can place',
      'a signal or sighting with competing explanations',
      'a case that was reopened by new technique',
    ],
  },
  {
    id: 'self-improvement',
    name: 'Self improvement',
    blurb: 'Small changes with evidence behind them',
    brief:
      'Practical habits and systems, grounded where possible in research. Specific and actionable. No medical claims, no guarantees.',
    seeds: [
      'a small change with outsized effect',
      'why a common productivity rule backfires',
      'a way to make a decision faster',
      'a habit that is easier to keep than it sounds',
    ],
  },
  {
    id: 'food',
    name: 'Food science',
    blurb: 'What is happening in the pan',
    brief:
      'The chemistry and history of food and cooking. Explain why a technique works, not just what to do.',
    seeds: [
      'why a technique works chemically',
      'a food whose origin story is wrong',
      'an ingredient that behaves unexpectedly',
      'a preservation method older than refrigeration',
    ],
  },
  {
    id: 'geography',
    name: 'Geography',
    blurb: 'Places, borders, and why they are where they are',
    brief:
      'Physical and political geography. Why places are where they are, and what follows from that. Neutral on live territorial disputes.',
    seeds: [
      'a border with a strange shape and a real reason',
      'a place that should not be habitable',
      'a city built where nobody would choose',
      'a natural feature that shaped a country',
    ],
  },
  {
    id: 'stoicism',
    name: 'Philosophy',
    blurb: 'Old ideas that still hold up',
    brief:
      'Philosophy made practical — Stoicism and adjacent schools. Attribute ideas to the right thinker and never fabricate a quotation.',
    seeds: [
      'an idea that reframes a daily frustration',
      'what a philosopher actually meant, versus the poster version',
      'a thought experiment worth carrying around',
      'a distinction that clarifies an argument',
    ],
  },
] as const;

export interface ArtStyle {
  id: string;
  name: string;
  /** Appended to every image prompt for the channel. */
  prompt: string;
  /** Two hex colours used for the offline gradient stand-in. */
  gradient: [string, string];
}

export const ART_STYLES: readonly ArtStyle[] = [
  {
    id: 'cinematic',
    name: 'Cinematic',
    prompt:
      'cinematic photograph, shallow depth of field, dramatic directional lighting, film grain, muted colour grade, anamorphic',
    gradient: ['#1b2735', '#4a6fa5'],
  },
  {
    id: 'painterly',
    name: 'Painterly',
    prompt:
      'digital oil painting, visible brushwork, rich impasto texture, warm classical palette, soft edges',
    gradient: ['#3b1f2b', '#c46a4b'],
  },
  {
    id: 'anime',
    name: 'Anime',
    prompt:
      'anime illustration, clean cel shading, expressive composition, saturated colour, detailed background art',
    gradient: ['#2a2140', '#7b5cd6'],
  },
  {
    id: 'documentary',
    name: 'Documentary',
    prompt:
      'documentary photograph, natural available light, realistic colour, candid framing, high detail, photojournalistic',
    gradient: ['#23262b', '#6b7a86'],
  },
  {
    id: 'retro-print',
    name: 'Retro print',
    prompt:
      'mid-century screen print, limited ink palette, halftone texture, bold flat shapes, slight registration offset',
    gradient: ['#2d2a1f', '#d9a441'],
  },
  {
    id: 'dark-minimal',
    name: 'Dark minimal',
    prompt:
      'minimalist composition on a near-black background, single strong subject, rim lighting, heavy negative space, high contrast',
    gradient: ['#0d0d12', '#3a3a52'],
  },
  {
    id: 'neon',
    name: 'Neon',
    prompt:
      'neon-lit night scene, magenta and cyan practical lights, wet reflective surfaces, atmospheric haze, high contrast',
    gradient: ['#160b2b', '#d61f9c'],
  },
  {
    id: '3d-render',
    name: '3D render',
    prompt:
      'stylised 3D render, soft global illumination, clay-like matte materials, gentle ambient occlusion, pastel palette',
    gradient: ['#242038', '#8fb8de'],
  },
] as const;

export interface Voice {
  id: string;
  name: string;
  blurb: string;
  /** OpenAI `tts-1-hd` voice name this maps to. */
  openai: string;
}

export const VOICES: readonly Voice[] = [
  { id: 'calm-male', name: 'Calm male', blurb: 'Measured, documentary', openai: 'onyx' },
  { id: 'warm-female', name: 'Warm female', blurb: 'Friendly, conversational', openai: 'nova' },
  { id: 'bright-female', name: 'Bright female', blurb: 'Energetic, upbeat', openai: 'shimmer' },
  { id: 'neutral', name: 'Neutral', blurb: 'Even, unhurried', openai: 'alloy' },
  { id: 'deep-male', name: 'Deep male', blurb: 'Low, weighty', openai: 'echo' },
  { id: 'storyteller', name: 'Storyteller', blurb: 'Expressive, narrative', openai: 'fable' },
] as const;

export interface MusicBed {
  id: string;
  name: string;
  blurb: string;
  /**
   * Synthesised locally by ffmpeg rather than shipped as an audio file — a
   * repository is the wrong place for licensed music, and a generated bed is
   * unambiguously clear for commercial use.
   */
  chord: number[];
  bpm: number;
}

export const MUSIC_BEDS: readonly MusicBed[] = [
  { id: 'tension', name: 'Tension', blurb: 'Low pulse, building', chord: [55, 82.4, 110], bpm: 90 },
  { id: 'uplift', name: 'Uplift', blurb: 'Bright, major', chord: [130.8, 164.8, 196], bpm: 110 },
  { id: 'reflective', name: 'Reflective', blurb: 'Sparse, slow', chord: [98, 123.5, 146.8], bpm: 70 },
  { id: 'drive', name: 'Drive', blurb: 'Steady, forward', chord: [110, 138.6, 164.8], bpm: 120 },
] as const;

export const CADENCES: readonly { id: Cadence; name: string; perWeek: number; blurb: string }[] = [
  { id: 'three-per-week', name: '3 per week', perWeek: 3, blurb: 'Mon, Wed, Fri' },
  { id: 'daily', name: 'Daily', perWeek: 7, blurb: 'One every day' },
  { id: 'twice-daily', name: 'Twice daily', perWeek: 14, blurb: 'Morning and evening' },
  { id: 'manual', name: 'Manual only', perWeek: 0, blurb: 'Nothing is queued automatically' },
] as const;

export const PLATFORMS: readonly { id: PlatformId; name: string }[] = [
  { id: 'tiktok', name: 'TikTok' },
  { id: 'instagram', name: 'Instagram' },
  { id: 'youtube', name: 'YouTube' },
] as const;

export function niche(id: string): Niche | undefined {
  return NICHES.find((n) => n.id === id);
}

export function artStyle(id: string): ArtStyle | undefined {
  return ART_STYLES.find((s) => s.id === id);
}

export function voice(id: string): Voice | undefined {
  return VOICES.find((v) => v.id === id);
}

export function musicBed(id: string): MusicBed | undefined {
  return MUSIC_BEDS.find((m) => m.id === id);
}
