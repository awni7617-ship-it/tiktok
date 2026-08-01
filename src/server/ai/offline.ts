import { createHash } from 'node:crypto';
import path from 'node:path';
import { ensureDir } from '../store/paths';
import { probeDuration, runFfmpeg } from '../video/ffmpeg';
import { FRAME_HEIGHT, FRAME_WIDTH } from './types';
import type {
  ImageProvider,
  ImageRequest,
  ScriptProvider,
  ScriptRequest,
  VoiceProvider,
  VoiceRequest,
} from './types';
import type { Script } from '@/lib/types';

/**
 * The no-key providers.
 *
 * These are stand-ins, not imitations: the script is a real structured script,
 * the audio is a real audio file of the right length, and the image is a real
 * PNG. Everything downstream behaves exactly as it will with keys configured,
 * which means the pipeline is exercised for real before anyone pays anyone.
 *
 * They are deterministic — same idea in, same output out — so tests can assert
 * on them and a user can tell a stand-in from a model at a glance.
 */

function seedOf(input: string): number {
  const hash = createHash('sha256').update(input).digest();
  return hash.readUInt32BE(0);
}

/** Small deterministic PRNG, so output is stable across runs and machines. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length]!;
}

const OPENERS = [
  'Here is something that sounds made up.',
  'This turns out to be stranger than it looks.',
  'Most people have this backwards.',
  'The details here are worth slowing down for.',
  'There is a reason this keeps coming up.',
];

const CONNECTORS = [
  'The part that gets left out is simple.',
  'What follows from that is less obvious.',
  'It goes further than that.',
  'The mechanism underneath is the interesting bit.',
  'That raises an obvious question.',
];

const CLOSERS = [
  'Which is why it is still worth knowing.',
  'Once you see it, it is hard to unsee.',
  'That is the whole of it.',
  'Small thing, but it holds up.',
];

const SETTINGS = [
  'a quiet interior lit by a single window, dust visible in the light',
  'a wide landscape under heavy overcast, low horizon',
  'a cluttered wooden desk seen from above, warm lamplight',
  'an empty corridor with hard shadows and a distant doorway',
  'a close study of weathered material, shallow focus',
  'a figure seen from behind, small against a large space',
];

export class OfflineScriptProvider implements ScriptProvider {
  readonly name = 'offline';

  async write(request: ScriptRequest): Promise<Script> {
    const random = rng(seedOf(`${request.idea}|${request.targetSeconds}`));
    const sceneCount = Math.max(3, Math.min(10, Math.round(request.targetSeconds / 6)));

    const topic = request.idea.trim().replace(/\.$/, '');
    const hook = `${topic.charAt(0).toUpperCase()}${topic.slice(1)}`;

    const scenes = Array.from({ length: sceneCount }, (_, index) => {
      const first = index === 0;
      const last = index === sceneCount - 1;
      const lead = first ? pick(OPENERS, random) : last ? pick(CLOSERS, random) : pick(CONNECTORS, random);

      return {
        narration: first
          ? `${lead} ${topic}.`
          : last
            ? `${lead} This is scene ${index + 1} of an offline preview, standing in for the narration a script model would write.`
            : `${lead} This is scene ${index + 1} of an offline preview for ${topic}.`,
        visual: `${pick(SETTINGS, random)}, relating to ${topic}`,
      };
    });

    return {
      hook,
      scenes,
      caption: `${hook} — generated offline. Add an Anthropic key in Settings for a real script.`,
      hashtags: ['offlinepreview', 'autoreel'],
    };
  }
}

/**
 * Offline narration.
 *
 * There is no speech here — synthesising intelligible speech without a model
 * is not something a stand-in can honestly fake. What it does produce is an
 * audio file of the *correct duration* for the text, which is what the rest of
 * the pipeline actually depends on: scene timing, caption timing and the final
 * cut all key off measured audio length. The result is a silent video with
 * correctly timed captions, which is unmistakably a preview rather than
 * something that looks finished and is not.
 */
export class OfflineVoiceProvider implements VoiceProvider {
  readonly name = 'offline';

  async speak(request: VoiceRequest): Promise<number> {
    await ensureDir(path.dirname(request.outFile));

    const words = request.text.trim().split(/\s+/).filter(Boolean).length;
    // 2.6 words/second is a typical narration pace; the floor keeps very short
    // lines from producing a scene too brief to read.
    const seconds = Math.max(1.6, words / 2.6);

    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      `anullsrc=r=44100:cl=mono:d=${seconds.toFixed(3)}`,
      '-c:a',
      'pcm_s16le',
      request.outFile,
    ]);

    return probeDuration(request.outFile);
  }
}

/**
 * Offline visuals: a deterministic gradient in the channel's art-style colours.
 *
 * Generated by ffmpeg rather than a hand-rolled PNG encoder, because ffmpeg is
 * already a hard dependency of rendering and a second image-writing code path
 * is a second thing to get wrong.
 */
export class OfflineImageProvider implements ImageProvider {
  readonly name = 'offline';

  constructor(private readonly colours: [string, string]) {}

  async draw(request: ImageRequest): Promise<void> {
    await ensureDir(path.dirname(request.outFile));

    const random = rng(request.seed);
    const [from, to] = this.colours;

    // The gradient's direction is the line from (x0,y0) to (x1,y1) — this
    // filter has no angle option, so the angle is expressed as two points.
    // Varying them per scene stops a video being the same frame ten times.
    const x0 = Math.floor(random() * FRAME_WIDTH);
    const y0 = Math.floor(random() * FRAME_HEIGHT);
    const x1 = FRAME_WIDTH - x0;
    const y1 = FRAME_HEIGHT - y0;
    const type = random() < 0.5 ? 'linear' : 'radial';

    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      `gradients=s=${FRAME_WIDTH}x${FRAME_HEIGHT}:c0=${from}:c1=${to}:x0=${x0}:y0=${y0}:x1=${x1}:y1=${y1}:nb_colors=2:type=${type}:seed=${request.seed}`,
      '-frames:v',
      '1',
      request.outFile,
    ]);
  }
}
