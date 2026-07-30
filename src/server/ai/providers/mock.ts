import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContentNiche, RegionOfInterest, Transcript, TranscriptSegment, TranscriptWord } from '@/lib/types';
import { estimateSpeechDuration, sentences } from '@/lib/text';
import { round } from '@/lib/time';
import { shortHash } from '@/lib/id';
import {
  type AsrProvider,
  type AsrRequest,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
  type LlmJsonRequest,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
  type RoiDetector,
  type StockAsset,
  type StockProvider,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
  type Voice,
} from '../types';

/**
 * Deterministic offline providers.
 *
 * These are not stubs that throw "not implemented" — they produce real,
 * structurally valid output: parseable scripts, a genuine WAV file, a genuine
 * PNG. That means the full pipeline (generate → narrate → render → publish
 * preview) runs with no API keys, which is what makes local development, CI
 * and the demo mode work.
 *
 * Everything is seeded from a hash of the input, so the same prompt always
 * produces the same output and tests can assert on it.
 */

// ---------------------------------------------------------------------------
// Seeded pseudo-randomness
// ---------------------------------------------------------------------------

/** Mulberry32 — small, fast, and good enough for deterministic content picks. */
export function seededRandom(seed: string): () => number {
  let state = Number.parseInt(shortHash(seed), 36) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? items[0]!;
}

// ---------------------------------------------------------------------------
// Mock LLM
// ---------------------------------------------------------------------------

interface NicheTemplate {
  hooks: string[];
  openers: string[];
  beats: string[];
  closers: string[];
  ctas: string[];
  hashtags: string[];
  visuals: string[];
}

const NICHE_TEMPLATES: Record<ContentNiche, NicheTemplate> = {
  'scary-story': {
    hooks: [
      'They found the tape three weeks after she disappeared.',
      'The house had thirteen rooms. The blueprints only showed twelve.',
      'Every night at 3:07 the baby monitor picked up a second voice.',
    ],
    openers: ['It started the night we moved in.', 'Nobody believed me at first.'],
    beats: [
      'The first sign was small enough to ignore.',
      'Then the sounds started coming from inside the walls.',
      'I checked the footage frame by frame.',
      'That was when I realised I had never been alone.',
    ],
    closers: ['I still hear it, most nights.', 'They never did find the twelfth room.'],
    ctas: ['Follow for part two.', 'Comment if you would have stayed.'],
    hashtags: ['scarystories', 'horror', 'creepy', 'truestory', 'nightmare'],
    visuals: ['dim hallway lit by one bulb', 'static on an old monitor', 'empty room at night'],
  },
  mystery: {
    hooks: [
      'The plane landed. All 92 passengers were accounted for. Nobody could explain the 93rd seatbelt.',
      'She mailed herself a letter every week for forty years. It always came back unopened.',
    ],
    openers: ['The case file is eleven pages long.', 'It should have been routine.'],
    beats: [
      'The timeline does not add up.',
      'Investigators found one detail that changed everything.',
      'Three separate witnesses described the same impossible thing.',
    ],
    closers: ['The file is still open.', 'No one has explained it since.'],
    ctas: ['What do you think happened? Comment below.', 'Follow for more unsolved cases.'],
    hashtags: ['unsolved', 'mystery', 'truecrime', 'coldcase'],
    visuals: ['archive documents on a desk', 'grainy security footage', 'map with pins'],
  },
  'reddit-story': {
    hooks: [
      'AITA for refusing to pay for my sister’s wedding after what she said?',
      'My roommate charged me rent for a room I own.',
    ],
    openers: ['So this happened last month.', 'Throwaway because she follows my main.'],
    beats: [
      'For context, we had agreed on this a year ago.',
      'That is when she dropped the bombshell.',
      'The comments were brutal, and honestly, fair.',
    ],
    closers: ['Update: she finally apologised.', 'I still do not know if I was wrong.'],
    ctas: ['Am I the one in the wrong here?', 'Follow for the update.'],
    hashtags: ['reddit', 'redditstories', 'aita', 'storytime'],
    visuals: ['phone screen scrolling a thread', 'text overlay on gameplay footage'],
  },
  educational: {
    hooks: [
      'You have been taught this backwards your whole life.',
      'Here is the one idea that makes the rest of it click.',
    ],
    openers: ['Let me show you in thirty seconds.', 'Start with the part everyone skips.'],
    beats: [
      'First, the thing that is actually happening.',
      'Second, why the usual explanation is misleading.',
      'Third, how to use this tomorrow.',
    ],
    closers: ['That is the whole idea.', 'Once you see it, you cannot unsee it.'],
    ctas: ['Follow for more explainers.', 'Save this for later.'],
    hashtags: ['learnontiktok', 'education', 'explained', 'didyouknow'],
    visuals: ['clean animated diagram', 'hand-drawn whiteboard sketch', 'side-by-side comparison'],
  },
  motivational: {
    hooks: [
      'Nobody is coming to save you. That is the good news.',
      'You are not behind. You are just comparing your day one to someone’s year ten.',
    ],
    openers: ['Two years ago I had nothing to show.', 'Here is what actually changed things.'],
    beats: [
      'Discipline is just remembering what you want.',
      'The work is boring. That is why it is rare.',
      'Small, repeated, unglamorous. That is the entire secret.',
    ],
    closers: ['Start today. Badly. Just start.', 'Future you is watching.'],
    ctas: ['Follow for daily reminders.', 'Send this to someone who needs it.'],
    hashtags: ['motivation', 'discipline', 'mindset', 'growth'],
    visuals: ['sunrise over a city', 'athlete training alone', 'slow push on a determined face'],
  },
  gaming: {
    hooks: [
      'This clip took 400 attempts and I still cannot believe it.',
      'He had one bullet left.',
    ],
    openers: ['Watch the bottom left of the screen.', 'Full send, no plan.'],
    beats: ['The setup looks impossible.', 'Then the timing lines up perfectly.', 'Chat lost it.'],
    closers: ['Best clip of the season.', 'Still not sure how that landed.'],
    ctas: ['Follow for more clips.', 'Rate it out of ten in the comments.'],
    hashtags: ['gaming', 'clips', 'gameplay', 'highlights'],
    visuals: ['gameplay capture', 'slow motion replay', 'kill feed close-up'],
  },
  football: {
    hooks: [
      'This touch should not be physically possible.',
      'Ninety-fourth minute. One chance left.',
    ],
    openers: ['Watch the defender’s hips.', 'The whole stadium stood up.'],
    beats: [
      'The first touch buys half a yard.',
      'The second sells the defender completely.',
      'And then there is only the finish.',
    ],
    closers: ['Pure technique.', 'They are still talking about it.'],
    ctas: ['Best goal of the season? Comment.', 'Follow for daily edits.'],
    hashtags: ['football', 'soccer', 'edit', 'skills', 'goals'],
    visuals: ['slow motion dribble', 'crowd reaction', 'stadium floodlights'],
  },
  history: {
    hooks: [
      'In 1518, hundreds of people danced until they died. Nobody knows why.',
      'The most successful pirate in history was a woman who retired rich.',
    ],
    openers: ['It began in July.', 'The records are surprisingly detailed.'],
    beats: [
      'Within a month the numbers had grown beyond control.',
      'Authorities tried the worst possible solution.',
      'Historians still argue about the cause.',
    ],
    closers: ['It has never happened again.', 'History is stranger than fiction.'],
    ctas: ['Follow for more forgotten history.', 'Which one should I cover next?'],
    hashtags: ['history', 'historytok', 'facts', 'thepast'],
    visuals: ['archival engraving', 'old map panning', 'museum artifact close-up'],
  },
  finance: {
    hooks: [
      'You are losing money to a fee you have never seen.',
      'Compound interest is boring right up until it is not.',
    ],
    openers: ['Here are the numbers.', 'Run this with your own figures.'],
    beats: [
      'A one percent fee sounds like nothing.',
      'Over thirty years it takes a quarter of your returns.',
      'Here is what to check this week.',
    ],
    closers: ['Same money. Very different outcome.', 'Boring wins.'],
    ctas: ['Not financial advice — follow for more.', 'Save this before you forget.'],
    hashtags: ['finance', 'money', 'investing', 'personalfinance'],
    visuals: ['animated compounding chart', 'phone showing a brokerage app', 'coins stacking'],
  },
  business: {
    hooks: [
      'This company made $40 million selling something people throw away.',
      'The pitch was rejected sixty times. Then it was worth a billion.',
    ],
    openers: ['The model is simpler than you think.', 'Three moving parts, that is all.'],
    beats: [
      'They found a cost nobody else was measuring.',
      'Then they made it the entire product.',
      'Margins did the rest.',
    ],
    closers: ['Simple, not easy.', 'That is the whole business.'],
    ctas: ['Follow for more breakdowns.', 'Which company next?'],
    hashtags: ['business', 'startup', 'entrepreneur', 'casestudy'],
    visuals: ['clean product shot', 'animated flow diagram', 'warehouse timelapse'],
  },
  technology: {
    hooks: [
      'Your phone does this ten thousand times a second and you never notice.',
      'This bug cost half a billion dollars and it was one missing character.',
    ],
    openers: ['Here is what is actually happening.', 'Strip away the jargon.'],
    beats: [
      'The hardware makes a promise it cannot always keep.',
      'So the software quietly lies to cover it.',
      'And that trade-off is everywhere.',
    ],
    closers: ['Abstraction is a beautiful lie.', 'Now you will notice it too.'],
    ctas: ['Follow for more tech deep dives.', 'Comment what to explain next.'],
    hashtags: ['tech', 'technology', 'engineering', 'coding'],
    visuals: ['circuit board macro', 'terminal with scrolling logs', 'animated data flow'],
  },
  science: {
    hooks: [
      'There is a material so light it can rest on a soap bubble.',
      'Your body replaced most of itself while you watched this.',
    ],
    openers: ['The mechanism is elegant.', 'It comes down to one property.'],
    beats: [
      'At small scales the usual rules stop applying.',
      'Which lets you do something that looks impossible.',
      'And we are only starting to use it.',
    ],
    closers: ['Nature got there first.', 'Science is quietly wild.'],
    ctas: ['Follow for more science.', 'Questions in the comments.'],
    hashtags: ['science', 'physics', 'biology', 'stem'],
    visuals: ['microscope footage', 'lab experiment close-up', 'animated molecular model'],
  },
  documentary: {
    hooks: [
      'For eleven years, one man kept the lighthouse running alone.',
      'The town voted to disappear. Then it did.',
    ],
    openers: ['This is how it happened.', 'The footage survived by accident.'],
    beats: [
      'At first it was a job like any other.',
      'Then the supply ships stopped coming.',
      'What he did next kept everyone alive.',
    ],
    closers: ['He never spoke about it again.', 'The light is still on.'],
    ctas: ['Follow for part two.', 'Full story on the channel.'],
    hashtags: ['documentary', 'truestory', 'archive', 'history'],
    visuals: ['16mm archival footage', 'slow drone over the coast', 'weathered photograph'],
  },
  'product-review': {
    hooks: [
      'I used this every day for a month so you do not have to.',
      'It is half the price and it beat the one everyone recommends.',
    ],
    openers: ['Three things matter here.', 'Straight to the results.'],
    beats: [
      'Build quality is better than the price suggests.',
      'Battery life is the one real compromise.',
      'For most people, that trade is worth it.',
    ],
    closers: ['Would I buy it again? Yes.', 'Worth it, with one caveat.'],
    ctas: ['Full review linked in bio.', 'What should I test next?'],
    hashtags: ['review', 'tech', 'gadgets', 'unboxing'],
    visuals: ['product on a clean desk', 'hands using the device', 'spec comparison overlay'],
  },
  'news-summary': {
    hooks: [
      'Three things happened today that will affect your bills.',
      'Here is the story everyone is getting slightly wrong.',
    ],
    openers: ['Sixty seconds, no spin.', 'Here are the facts as reported.'],
    beats: [
      'First, what was actually announced.',
      'Second, what changes in practice.',
      'Third, what to watch next week.',
    ],
    closers: ['That is where it stands tonight.', 'More as it develops.'],
    ctas: ['Follow for daily summaries.', 'Sources in the comments.'],
    hashtags: ['news', 'newsupdate', 'explained', 'today'],
    visuals: ['clean lower-third graphics', 'map with highlighted region', 'stock chart overlay'],
  },
  storytelling: {
    hooks: [
      'She left the note on the counter and never came back for it.',
      'The best decision of my life took four seconds.',
    ],
    openers: ['It was an ordinary Tuesday.', 'Nothing about it felt important at the time.'],
    beats: [
      'One small choice changed the shape of the day.',
      'And then the day changed the shape of the year.',
      'Looking back, the signs were everywhere.',
    ],
    closers: ['I think about it constantly.', 'Some doors only open once.'],
    ctas: ['Follow for part two.', 'Tell me yours in the comments.'],
    hashtags: ['storytime', 'story', 'reallife', 'truestory'],
    visuals: ['handheld shot walking a street', 'close-up on hands', 'window with rain'],
  },
};

/**
 * Template-driven language model.
 *
 * Produces schema-valid `GeneratedContent` for any niche without a network
 * call. The output is deliberately coherent rather than lorem ipsum, so the
 * editor, timeline and preview all look right in demo mode.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const prompt = request.messages.map((m) => m.content).join('\n');
    const random = seededRandom(prompt);
    const niche = detectNiche(prompt);
    const template = NICHE_TEMPLATES[niche];

    const text = [
      pick(template.hooks, random),
      pick(template.openers, random),
      ...template.beats,
      pick(template.closers, random),
    ].join(' ');

    return {
      text,
      usage: estimateUsage(prompt, text),
      model: 'mock-1',
      refused: false,
    };
  }

  async completeJson<T>(request: LlmJsonRequest<T>): Promise<{ value: T; usage: LlmUsage }> {
    const prompt = request.messages.map((m) => m.content).join('\n');
    const payload = buildMockPayload(prompt, request.schema);
    return { value: request.parse(payload), usage: estimateUsage(prompt, JSON.stringify(payload)) };
  }

  async stream(request: LlmRequest, onDelta: (text: string) => void): Promise<LlmResponse> {
    const response = await this.complete(request);
    // Emit word by word so streaming UIs behave identically to production.
    for (const word of response.text.split(' ')) {
      onDelta(`${word} `);
    }
    return response;
  }
}

function estimateUsage(prompt: string, output: string): LlmUsage {
  return {
    inputTokens: Math.ceil(prompt.length / 4),
    outputTokens: Math.ceil(output.length / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export function detectNiche(prompt: string): ContentNiche {
  const lower = prompt.toLowerCase();
  const matchers: [ContentNiche, RegExp][] = [
    ['scary-story', /scary|horror|creepy|ghost|haunt/],
    ['mystery', /mystery|unsolved|disappear|cold case/],
    ['reddit-story', /reddit|aita|am i the/],
    ['football', /football|soccer|goal|premier league/],
    ['gaming', /gaming|gameplay|clip|fps|speedrun/],
    ['finance', /finance|money|invest|stock|budget/],
    ['business', /business|startup|company|revenue|margin/],
    ['technology', /tech|software|computer|ai |code|engineering/],
    ['science', /science|physics|biology|chemistry|space/],
    ['history', /history|historical|ancient|century|war/],
    ['documentary', /documentary|archive|true story/],
    ['product-review', /review|unboxing|tested|worth it/],
    ['news-summary', /news|headline|breaking|today/],
    ['motivational', /motivat|discipline|mindset|grind/],
    ['educational', /explain|how to|learn|teach|tutorial/],
  ];

  for (const [niche, pattern] of matchers) {
    if (pattern.test(lower)) return niche;
  }
  return 'storytelling';
}

/**
 * Build an object satisfying the requested schema.
 *
 * Recognises the content-generation schema and produces a real script; for any
 * other schema it falls back to generating a structurally valid skeleton from
 * the JSON Schema itself, so new structured calls never crash in mock mode.
 */
function buildMockPayload(prompt: string, schema: Record<string, unknown>): unknown {
  const properties = schema['properties'] as Record<string, unknown> | undefined;

  if (properties && 'scenes' in properties && 'hook' in properties) {
    return buildMockContent(prompt);
  }
  if (properties && 'suggestions' in properties) {
    return {
      suggestions: [
        {
          area: 'hook',
          title: 'Tighten the first three seconds',
          detail:
            'The opening line takes 2.4s to reach its point. Lead with the payoff and move the setup to second position.',
          impact: 'high',
          replacement: 'Here is the part nobody tells you.',
        },
        {
          area: 'cta',
          title: 'Add an explicit next step',
          detail: 'The video ends without asking for anything. A single-line CTA lifts follow-through.',
          impact: 'medium',
          replacement: 'Follow for part two.',
        },
      ],
      summary:
        'Strong core idea. The hook and the ending are where the available gains are concentrated.',
    };
  }
  if (properties && 'wins' in properties) {
    return {
      summary:
        'Views are up week over week, driven by two posts that both opened with a question. Retention past three seconds remains the constraint.',
      wins: ['Two posts beat your median by 3x', 'Completion rate improved 6 points'],
      concerns: ['Posting gaps of 3+ days correlate with the weakest posts'],
      actions: ['Lead with a question more often', 'Hold a two-day maximum gap between posts'],
    };
  }

  return skeletonFromSchema(schema);
}

function buildMockContent(prompt: string) {
  const random = seededRandom(prompt);
  const niche = detectNiche(prompt);
  const template = NICHE_TEMPLATES[niche];

  const hook = pick(template.hooks, random);
  const opener = pick(template.openers, random);
  const closer = pick(template.closers, random);
  const lines = [hook, opener, ...template.beats, closer];
  const script = lines.join(' ');

  const scenes = lines.map((line, index) => ({
    index,
    narration: line,
    visual: pick(template.visuals, random),
    brollQueries: [template.hashtags[index % template.hashtags.length] ?? niche],
    estimatedDurationSec: Math.max(1.5, estimateSpeechDuration(line)),
    overlayText: index === 0 ? truncateOverlay(hook) : undefined,
  }));

  const topic = prompt.slice(0, 60).replace(/\s+/g, ' ').trim();

  return {
    title: buildTitle(niche, topic, random),
    titleVariants: [
      `${buildTitle(niche, topic, random)} (you will not guess the ending)`,
      `The truth about ${topic || niche.replace('-', ' ')}`,
    ],
    hook,
    hookVariants: template.hooks.filter((h) => h !== hook).slice(0, 3),
    script,
    scenes,
    description: `${hook} ${closer}`.slice(0, 2000),
    hashtags: template.hashtags.map((tag) => `#${tag}`),
    callToAction: pick(template.ctas, random),
    thumbnailIdeas: [
      `Close-up on ${pick(template.visuals, random)} with three bold words of text`,
      'High-contrast face reaction with a single question overlaid',
    ],
    estimatedDurationSec: round(scenes.reduce((sum, scene) => sum + scene.estimatedDurationSec, 0), 1),
    niche,
  };
}

function buildTitle(niche: ContentNiche, topic: string, random: () => number): string {
  const patterns = [
    `The ${niche.replace('-', ' ')} nobody explains properly`,
    topic ? `What really happened with ${topic}` : 'What really happened',
    topic ? `${topic} — the part everyone misses` : 'The part everyone misses',
  ];
  return pick(patterns, random).slice(0, 120);
}

function truncateOverlay(text: string): string {
  const [first] = sentences(text);
  return (first ?? text).slice(0, 60);
}

/** Generate a minimal valid instance of an arbitrary JSON Schema. */
function skeletonFromSchema(schema: Record<string, unknown>): unknown {
  const type = schema['type'];

  if (type === 'object') {
    const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
    const required = (schema['required'] as string[]) ?? Object.keys(properties);
    const result: Record<string, unknown> = {};
    for (const key of required) {
      const child = properties[key];
      if (child) result[key] = skeletonFromSchema(child);
    }
    return result;
  }
  if (type === 'array') return [];
  if (type === 'string') {
    const enumValues = schema['enum'] as string[] | undefined;
    return enumValues?.[0] ?? 'placeholder';
  }
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return false;
  return null;
}

// ---------------------------------------------------------------------------
// Mock ASR
// ---------------------------------------------------------------------------

const MOCK_SPEECH = [
  "Okay so, um, here's the thing nobody actually tells you about this.",
  'I spent three months getting this wrong before it clicked.',
  'The first mistake is assuming that more effort fixes it.',
  'It does not. You know, it actually makes it worse.',
  'What changed everything was one small adjustment.',
  'And I mean genuinely one adjustment, not a whole system.',
  'Here is exactly what I did, step by step.',
  'Step one, cut the thing that is not working.',
  'Step two, double down on the part that already works.',
  'Step three, and this is the important one, measure it weekly.',
  'That is it. That is the whole method.',
  'Follow if you want the full breakdown.',
];

/**
 * Produces a realistic transcript with word-level timings, natural pauses and
 * a few filler words, so the silence detector, filler remover and caption
 * builder all have something meaningful to act on offline.
 */
export class MockAsrProvider implements AsrProvider {
  readonly name = 'mock';

  async transcribe(request: AsrRequest): Promise<Transcript> {
    return buildMockTranscript(request.source);
  }
}

export function buildMockTranscript(seed: string, targetDurationSec = 45): Transcript {
  const random = seededRandom(seed);
  const segments: TranscriptSegment[] = [];
  const allWords: TranscriptWord[] = [];
  let cursor = 0.4;

  for (let i = 0; i < MOCK_SPEECH.length && cursor < targetDurationSec; i++) {
    const line = MOCK_SPEECH[i]!;
    const tokens = line.split(' ');
    const words: TranscriptWord[] = [];
    const segmentStart = cursor;

    for (const token of tokens) {
      // Longer words take longer to say; add a little jitter for realism.
      const duration = round(0.12 + token.length * 0.045 + random() * 0.06, 3);
      words.push({
        text: token,
        start: round(cursor),
        end: round(cursor + duration),
        confidence: round(0.82 + random() * 0.17, 3),
      });
      cursor = round(cursor + duration + 0.03 + random() * 0.05);
    }

    const segment: TranscriptSegment = {
      start: round(segmentStart),
      end: round(cursor),
      text: line,
      words,
    };
    segments.push(segment);
    allWords.push(...words);

    // Inter-sentence pause, occasionally a long one the editor should cut.
    cursor = round(cursor + (random() < 0.25 ? 0.9 + random() : 0.28 + random() * 0.2));
  }

  return {
    language: 'en',
    durationSec: round(cursor + 0.5),
    segments,
    words: allWords,
  };
}

// ---------------------------------------------------------------------------
// Mock TTS — writes a real WAV file
// ---------------------------------------------------------------------------

export class MockTtsProvider implements TtsProvider {
  readonly name = 'mock';

  async listVoices(): Promise<Voice[]> {
    return MOCK_VOICES;
  }

  /**
   * Writes a genuine 16-bit PCM WAV of the estimated narration length. Real
   * audio (rather than an empty file) means ffprobe, the loudness analyser and
   * the renderer all behave exactly as they will in production.
   */
  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const durationSec = Math.max(0.5, estimateSpeechDuration(request.text) / Math.max(request.speed, 0.1));
    const sampleRate = 24000;
    const sampleCount = Math.floor(durationSec * sampleRate);

    const data = Buffer.alloc(sampleCount * 2);
    const random = seededRandom(`${request.voiceId}:${request.text}`);

    // Very low-level shaped noise: audible as a soft hiss, keeps loudness
    // analysis meaningful without producing anything unpleasant.
    for (let i = 0; i < sampleCount; i++) {
      const envelope = Math.sin((i / sampleCount) * Math.PI) ** 0.5;
      const sample = Math.round((random() * 2 - 1) * 900 * envelope);
      data.writeInt16LE(sample, i * 2);
    }

    const wav = buildWavFile(data, sampleRate);
    await mkdir(path.dirname(request.outputPath), { recursive: true });
    await writeFile(request.outputPath, wav);

    return {
      path: request.outputPath,
      durationSec: round(durationSec),
      words: distributeWordTimings(request.text, durationSec),
    };
  }
}

/** Prepend a canonical 44-byte RIFF/WAVE header to raw mono PCM. */
export function buildWavFile(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM subchunk size
  header.writeUInt16LE(1, 20); // audio format: PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** Spread words evenly across the synthesised duration, weighted by length. */
export function distributeWordTimings(
  text: string,
  durationSec: number,
): { text: string; start: number; end: number }[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const weights = words.map((word) => word.length + 2);
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let cursor = 0;
  return words.map((word, index) => {
    const share = (weights[index]! / total) * durationSec;
    const entry = { text: word, start: round(cursor), end: round(cursor + share) };
    cursor += share;
    return entry;
  });
}

export const MOCK_VOICES: Voice[] = [
  { id: 'voice_atlas', name: 'Atlas', locale: 'en-US', gender: 'male', style: 'Deep, documentary narrator' },
  { id: 'voice_nova', name: 'Nova', locale: 'en-US', gender: 'female', style: 'Bright, conversational' },
  { id: 'voice_ember', name: 'Ember', locale: 'en-GB', gender: 'female', style: 'Warm, storytelling' },
  { id: 'voice_slate', name: 'Slate', locale: 'en-GB', gender: 'male', style: 'Calm, explainer' },
  { id: 'voice_pulse', name: 'Pulse', locale: 'en-US', gender: 'neutral', style: 'Fast, high-energy' },
  { id: 'voice_hollow', name: 'Hollow', locale: 'en-US', gender: 'male', style: 'Low, unsettling' },
];

// ---------------------------------------------------------------------------
// Mock image generation — writes a real PNG
// ---------------------------------------------------------------------------

export class MockImageProvider implements ImageProvider {
  readonly name = 'mock';

  async generate(request: ImageRequest): Promise<ImageResult> {
    const png = renderGradientPng(request.width, request.height, request.prompt);
    await mkdir(path.dirname(request.outputPath), { recursive: true });
    await writeFile(request.outputPath, png);
    return { path: request.outputPath, width: request.width, height: request.height };
  }
}

/**
 * Encode a deterministic two-colour gradient as a valid PNG.
 *
 * Hand-rolled rather than pulling in an image library: PNG's structure is
 * simple (signature, IHDR, IDAT, IEND) and this keeps the dependency footprint
 * of demo mode at zero.
 */
export function renderGradientPng(width: number, height: number, seed: string): Buffer {
  const random = seededRandom(seed);
  const from = { r: Math.floor(random() * 120), g: Math.floor(random() * 90), b: 120 + Math.floor(random() * 135) };
  const to = { r: 120 + Math.floor(random() * 135), g: Math.floor(random() * 90), b: 160 + Math.floor(random() * 95) };

  // Each scanline is prefixed with a filter-type byte (0 = None).
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let offset = 0;

  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    const t = height > 1 ? y / (height - 1) : 0;
    for (let x = 0; x < width; x++) {
      const u = width > 1 ? x / (width - 1) : 0;
      const mix = (t * 0.7 + u * 0.3);
      raw[offset++] = Math.round(from.r + (to.r - from.r) * mix);
      raw[offset++] = Math.round(from.g + (to.g - from.g) * mix);
      raw[offset++] = Math.round(from.b + (to.b - from.b) * mix);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Mock stock library & ROI detection
// ---------------------------------------------------------------------------

const STOCK_LIBRARY: StockAsset[] = [
  {
    id: 'stk_city_night',
    kind: 'video',
    title: 'City street at night',
    url: 'stock/city-night.mp4',
    thumbnailUrl: 'stock/city-night.jpg',
    durationSec: 12,
    width: 1920,
    height: 1080,
    license: 'CC0-1.0',
    attribution: null,
  },
  {
    id: 'stk_desk_setup',
    kind: 'video',
    title: 'Desk setup timelapse',
    url: 'stock/desk-setup.mp4',
    thumbnailUrl: 'stock/desk-setup.jpg',
    durationSec: 18,
    width: 1920,
    height: 1080,
    license: 'CC0-1.0',
    attribution: null,
  },
  {
    id: 'stk_corridor',
    kind: 'video',
    title: 'Dim corridor',
    url: 'stock/corridor.mp4',
    thumbnailUrl: 'stock/corridor.jpg',
    durationSec: 9,
    width: 1920,
    height: 1080,
    license: 'CC0-1.0',
    attribution: null,
  },
  {
    id: 'stk_stadium',
    kind: 'video',
    title: 'Stadium floodlights',
    url: 'stock/stadium.mp4',
    thumbnailUrl: 'stock/stadium.jpg',
    durationSec: 15,
    width: 3840,
    height: 2160,
    license: 'CC0-1.0',
    attribution: null,
  },
  {
    id: 'stk_chart',
    kind: 'image',
    title: 'Abstract data chart',
    url: 'stock/chart.png',
    thumbnailUrl: 'stock/chart-thumb.png',
    durationSec: null,
    width: 2400,
    height: 1600,
    license: 'CC0-1.0',
    attribution: null,
  },
];

export class MockStockProvider implements StockProvider {
  readonly name = 'mock';

  async search(
    query: string,
    options: { kind?: 'video' | 'image'; limit?: number } = {},
  ): Promise<StockAsset[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const ranked = STOCK_LIBRARY.filter((asset) => !options.kind || asset.kind === options.kind)
      .map((asset) => {
        const haystack = `${asset.title} ${asset.id}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { asset, score };
      })
      .sort((a, b) => b.score - a.score);

    return ranked.slice(0, options.limit ?? 10).map((entry) => entry.asset);
  }
}

/**
 * Synthesises a plausible face track: a subject roughly centred, drifting
 * slowly, occasionally moving to one side. Enough structure for the reframe
 * planner's smoothing and clamping to be exercised end to end.
 */
export class MockRoiDetector implements RoiDetector {
  readonly name = 'mock';

  async detect(
    source: string,
    options: { sampleFps: number; durationSec: number },
  ): Promise<RegionOfInterest[]> {
    const random = seededRandom(source);
    const step = 1 / Math.max(options.sampleFps, 0.5);
    const regions: RegionOfInterest[] = [];

    // A slow sinusoidal drift plus a mid-clip reposition.
    const driftAmplitude = 0.08 + random() * 0.06;
    const repositionAt = options.durationSec * (0.4 + random() * 0.2);
    const repositionTo = random() < 0.5 ? 0.32 : 0.68;

    for (let time = 0; time <= options.durationSec; time += step) {
      const base = time < repositionAt ? 0.5 : repositionTo;
      const x = base + Math.sin(time * 0.6) * driftAmplitude;
      const y = 0.42 + Math.sin(time * 0.4 + 1) * 0.03;
      const size = 0.22 + Math.sin(time * 0.25) * 0.02;

      regions.push({
        time: round(time, 3),
        x: round(x - size / 2, 4),
        y: round(y - size / 2, 4),
        width: round(size, 4),
        height: round(size * 1.25, 4),
        confidence: round(0.86 + random() * 0.12, 3),
        kind: 'face',
        trackId: 'subject-1',
      });
    }

    return regions;
  }
}
