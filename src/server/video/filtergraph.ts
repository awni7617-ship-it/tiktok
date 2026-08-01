import { FRAME_HEIGHT, FRAME_WIDTH } from '../ai/types';
import type { MusicBed } from '@/lib/catalog';

/**
 * The ffmpeg filter graph, built as a pure function.
 *
 * Nothing here touches the filesystem or spawns a process — it takes a
 * timeline and returns argv. That makes the hardest part of the renderer
 * testable without ffmpeg installed, and it means a broken graph shows up as a
 * failing assertion on a string rather than a corrupt mp4 twenty minutes into
 * a render.
 */

export const FPS = 30;
/** Crossfade length between scenes. Long enough to read as a dissolve. */
export const XFADE = 0.4;

export interface TimelineScene {
  /** Absolute path to the scene's still image. */
  image: string;
  /** Absolute path to the scene's narration audio. */
  audio: string;
  /** Measured narration duration in seconds. */
  seconds: number;
  /** Narration text, burned in as captions. */
  narration: string;
}

export interface TimelineOptions {
  scenes: TimelineScene[];
  /** Null for no music bed. */
  music: MusicBed | null;
  outFile: string;
  /**
   * Path to the generated ASS caption file, or null to render without
   * captions — which is what happens on an ffmpeg built without libass.
   */
  subtitleFile: string | null;
}

/**
 * Each scene holds for its narration plus the crossfade it overlaps with the
 * next one, so no words are lost under a dissolve.
 */
function sceneHold(seconds: number, isLast: boolean): number {
  return isLast ? seconds : seconds + XFADE;
}

/** Where each scene's narration begins on the finished timeline. */
export function sceneStarts(scenes: TimelineScene[]): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    starts.push(cursor);
    cursor += scene.seconds;
  }
  return starts;
}

export function totalDuration(scenes: TimelineScene[]): number {
  return scenes.reduce((sum, scene) => sum + scene.seconds, 0);
}

/** Output frames a scene occupies, which is what fixes its on-screen length. */
export function sceneFrames(hold: number): number {
  return Math.max(2, Math.round(hold * FPS));
}

/**
 * A slow push-in per scene.
 *
 * The image is fed as a *single frame* rather than a looped stream, and
 * `zoompan`'s `d` produces exactly the frames the scene needs. Looping the
 * input instead makes zoompan emit `d` frames per looped frame — orders of
 * magnitude too many — and the trim needed to correct that leaves timestamps
 * xfade will not accept.
 *
 * `zoom` steps once per output frame, so the increment is derived from the
 * frame count to land on the same final zoom however long the scene runs.
 * Without that, short scenes barely move and long ones zoom uncomfortably far.
 *
 * The source is scaled up 2x before zoompan and back down by it: zoompan
 * samples at integer pixel offsets, and at 1x that quantisation shows up as
 * judder on a slow move.
 */
function kenBurns(index: number, hold: number): string {
  const frames = sceneFrames(hold);
  const zoomTo = 1.12;
  const step = ((zoomTo - 1) / frames).toFixed(6);

  // Labels attach directly to the chain; only the filters between them are
  // comma-separated.
  const chain = [
    `scale=${FRAME_WIDTH * 2}:${FRAME_HEIGHT * 2}:force_original_aspect_ratio=increase`,
    `crop=${FRAME_WIDTH * 2}:${FRAME_HEIGHT * 2}`,
    `zoompan=z='min(zoom+${step}\\,${zoomTo})':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${FRAME_WIDTH}x${FRAME_HEIGHT}:fps=${FPS}`,
    'setsar=1',
    'format=yuv420p',
  ].join(',');

  return `[${index}:v]${chain}[v${index}]`;
}

/** Chain the scenes together with crossfades. */
function crossfades(count: number, scenes: TimelineScene[]): { filters: string[]; label: string } {
  if (count === 1) return { filters: [], label: 'v0' };

  const filters: string[] = [];
  let label = 'v0';
  // Offset is measured on the *accumulated* output, which grows by each
  // scene's narration length (the crossfade is overlap, not extra runtime).
  let elapsed = 0;

  for (let i = 1; i < count; i++) {
    elapsed += scenes[i - 1]!.seconds;
    const offset = Math.max(0, elapsed - XFADE);
    const next = i === count - 1 ? 'vchain' : `x${i}`;
    filters.push(
      `[${label}][v${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${next}]`,
    );
    label = next;
  }

  return { filters, label };
}

/**
 * Escape a path for use inside a filter argument.
 *
 * A Windows path contains both a drive colon and backslashes, either of which
 * ends the argument early if passed through untouched.
 */
export function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * A synthesised music bed.
 *
 * Generated rather than shipped: a repository is the wrong place to vendor
 * licensed audio, and a locally synthesised bed is unambiguously clear to use
 * commercially. It is a chord with a slow amplitude pulse at the bed's tempo.
 */
function musicExpression(bed: MusicBed, duration: number): string {
  const tones = bed.chord.map((hz) => `sin(2*PI*${hz}*t)`).join('+');
  const pulse = `(0.55+0.45*sin(2*PI*${(bed.bpm / 60).toFixed(3)}*t))`;
  const gain = (0.22 / bed.chord.length).toFixed(4);
  // Fade the last two seconds so the bed resolves rather than being cut off.
  const tail = `min(1\\,max(0\\,(${duration.toFixed(3)}-t)/2))`;
  return `aevalsrc='${gain}*${pulse}*(${tones})*${tail}':s=44100:d=${duration.toFixed(3)}`;
}

export interface BuiltCommand {
  args: string[];
  /** Exposed for tests and for the progress estimate. */
  duration: number;
}

export function buildRenderCommand(options: TimelineOptions): BuiltCommand {
  const { scenes, music, outFile, subtitleFile } = options;
  if (scenes.length === 0) throw new Error('Cannot render a video with no scenes');

  const duration = totalDuration(scenes);
  const args: string[] = [];

  // Image inputs first, so scene N is input N. One frame each — zoompan turns
  // it into the scene's worth of frames.
  for (const scene of scenes) {
    args.push('-i', scene.image);
  }

  // Then the narration audio, offset by the number of image inputs.
  for (const scene of scenes) {
    args.push('-i', scene.audio);
  }

  const audioBase = scenes.length;
  const filters: string[] = [];

  scenes.forEach((scene, index) => {
    filters.push(kenBurns(index, sceneHold(scene.seconds, index === scenes.length - 1)));
  });

  const { filters: fades, label } = crossfades(scenes.length, scenes);
  filters.push(...fades);

  const videoOut = 'vout';
  const caption = subtitleFile ? `subtitles=filename='${escapeFilterPath(subtitleFile)}'` : 'null';
  filters.push(`[${label}]${caption}[${videoOut}]`);

  // Narration: concatenated in order, resampled first so inputs that differ in
  // sample rate (offline WAV versus provider MP3) can be joined at all.
  const speechInputs = scenes
    .map((_, index) => `[${audioBase + index}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono[s${index}]`)
    .join(';');
  filters.push(speechInputs);
  filters.push(
    `${scenes.map((_, i) => `[s${i}]`).join('')}concat=n=${scenes.length}:v=0:a=1[speech]`,
  );

  let audioOut = 'speech';

  if (music) {
    args.push('-f', 'lavfi', '-i', musicExpression(music, duration));
    const musicInput = audioBase + scenes.length;

    filters.push('[speech]asplit=2[sp_main][sp_side]');
    filters.push(
      `[${musicInput}:a]aformat=sample_fmts=fltp:channel_layouts=mono[music_raw]`,
    );
    // Ducking, so narration always sits on top of the bed rather than fighting
    // it. A fixed low volume works until one scene is quiet and the next is
    // loud; the sidechain follows the voice instead.
    filters.push(
      '[music_raw][sp_side]sidechaincompress=threshold=0.02:ratio=12:attack=20:release=400[music_ducked]',
    );
    filters.push('[sp_main][music_ducked]amix=inputs=2:duration=first:normalize=0[mixed]');
    audioOut = 'mixed';
  }

  // A consistent output level. Platforms normalise on ingest anyway, but they
  // normalise *down*, so arriving quiet stays quiet.
  filters.push(`[${audioOut}]loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${videoOut}]`,
    '-map',
    '[aout]',
    '-t',
    duration.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FPS),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    // Puts the index at the front so the file starts playing before it has
    // fully downloaded — which is how every one of these gets watched.
    '-movflags',
    '+faststart',
    outFile,
  );

  return { args, duration };
}
