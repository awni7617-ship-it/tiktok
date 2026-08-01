import { describe, expect, it } from 'vitest';
import {
  buildRenderCommand,
  escapeFilterPath,
  sceneFrames,
  sceneStarts,
  totalDuration,
  FPS,
  XFADE,
} from '@/server/video/filtergraph';
import { MUSIC_BEDS } from '@/lib/catalog';
import type { TimelineScene } from '@/server/video/filtergraph';

function scene(seconds: number, narration = 'Some narration here'): TimelineScene {
  return { image: `/tmp/img-${seconds}.png`, audio: `/tmp/a-${seconds}.wav`, seconds, narration };
}

const argFor = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

/**
 * `-t` appears both as a per-input hold and as the output duration, so the
 * output side has to be read after the filter graph rather than by first match.
 */
const outputArg = (args: string[], flag: string) => {
  const from = args.indexOf('-filter_complex');
  const index = args.indexOf(flag, from);
  return args[index + 1];
};

describe('timeline arithmetic', () => {
  it('sums scene durations', () => {
    expect(totalDuration([scene(3), scene(4.5), scene(2)])).toBeCloseTo(9.5, 6);
  });

  it('starts each scene where the previous one ended', () => {
    expect(sceneStarts([scene(3), scene(4), scene(2)])).toEqual([0, 3, 7]);
  });
});

describe('buildRenderCommand', () => {
  it('refuses to render nothing', () => {
    expect(() =>
      buildRenderCommand({ scenes: [], music: null, outFile: '/tmp/o.mp4', subtitleFile: null }),
    ).toThrow(/no scenes/i);
  });

  it('declares the output duration as the sum of the narration', () => {
    const { args, duration } = buildRenderCommand({
      scenes: [scene(3), scene(4), scene(2)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    expect(duration).toBeCloseTo(9, 6);
    expect(outputArg(args, '-t')).toBe('9.000');
  });

  it('holds every scene but the last long enough to cover its crossfade', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(3), scene(4)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    // zoompan's `d` is what fixes each scene's length, in frames.
    const holds = [...argFor(args, '-filter_complex')!.matchAll(/zoompan=[^[]*?:d=(\d+)/g)].map(
      (match) => Number(match[1]),
    );

    expect(holds).toEqual([sceneFrames(3 + XFADE), sceneFrames(4)]);
  });

  it('feeds each image as a single frame, so zoompan sets the length', () => {
    // `-loop 1` would make zoompan emit `d` frames per looped input frame,
    // which is orders of magnitude too many for xfade to line up.
    const { args } = buildRenderCommand({
      scenes: [scene(3), scene(4)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    expect(args).not.toContain('-loop');
  });

  it('reaches the same final zoom whatever the scene length', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(2), scene(20)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    const graph = argFor(args, '-filter_complex')!;
    const steps = [...graph.matchAll(/zoom\+([\d.]+)/g)].map((m) => Number(m[1]));
    const frames = [...graph.matchAll(/zoompan=[^[]*?:d=(\d+)/g)].map((m) => Number(m[1]));

    // step × frames lands on the same total zoom for both scenes.
    expect(steps[0]! * frames[0]!).toBeCloseTo(steps[1]! * frames[1]!, 2);
  });

  it('adds one input per image and one per audio track', () => {
    const scenes = [scene(3), scene(4), scene(2)];
    const { args } = buildRenderCommand({
      scenes,
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    for (const s of scenes) {
      expect(args).toContain(s.image);
      expect(args).toContain(s.audio);
    }
  });

  it('renders at the declared frame rate', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(3)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    expect(outputArg(args, '-r')).toBe(String(FPS));
  });

  it('chains a crossfade between each adjacent pair', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(3), scene(4), scene(2)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    const graph = argFor(args, '-filter_complex')!;
    expect(graph.match(/xfade/g)).toHaveLength(2);
    // Offsets are on the accumulated timeline, less the fade overlap.
    expect(graph).toContain(`offset=${(3 - XFADE).toFixed(3)}`);
    expect(graph).toContain(`offset=${(7 - XFADE).toFixed(3)}`);
  });

  it('emits no crossfade for a single scene', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(5)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    expect(argFor(args, '-filter_complex')).not.toContain('xfade');
  });

  it('burns in the caption track when one was written', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(4)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: '/data/captions.ass',
    });

    expect(argFor(args, '-filter_complex')).toContain("subtitles=filename='/data/captions.ass'");
  });

  it('renders without captions rather than failing when there is no track', () => {
    // An ffmpeg built without libass still has to produce a video.
    const { args } = buildRenderCommand({
      scenes: [scene(4)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    const graph = argFor(args, '-filter_complex')!;
    expect(graph).not.toContain('subtitles');
    expect(graph).toContain('null[vout]');
  });

  it('escapes a Windows path so the drive colon does not end the argument', () => {
    expect(escapeFilterPath('C:\\data\\captions.ass')).toBe('C\\:/data/captions.ass');
  });

  it('ducks the music under the narration when a bed is chosen', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(4)],
      music: MUSIC_BEDS[0]!,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    const graph = argFor(args, '-filter_complex')!;
    expect(graph).toContain('sidechaincompress');
    expect(graph).toContain('amix');
    expect(args.join(' ')).toContain('aevalsrc');
  });

  it('leaves the audio unmixed when there is no music', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(4)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    const graph = argFor(args, '-filter_complex')!;
    expect(graph).not.toContain('sidechaincompress');
    expect(graph).not.toContain('amix');
  });

  it('normalises loudness and writes a faststart mp4 last', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(4)],
      music: null,
      outFile: '/tmp/final.mp4',
      subtitleFile: null,
    });

    expect(argFor(args, '-filter_complex')).toContain('loudnorm');
    expect(args).toContain('+faststart');
    expect(args.at(-1)).toBe('/tmp/final.mp4');
  });

  it('concatenates the narration in scene order', () => {
    const { args } = buildRenderCommand({
      scenes: [scene(3), scene(4), scene(2)],
      music: null,
      outFile: '/tmp/out.mp4',
      subtitleFile: null,
    });

    expect(argFor(args, '-filter_complex')).toContain('[s0][s1][s2]concat=n=3:v=0:a=1[speech]');
  });
});
