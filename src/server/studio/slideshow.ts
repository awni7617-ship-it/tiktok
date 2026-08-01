import type { CaptionCue, CaptionStyle } from '@/lib/types';
import { round } from '@/lib/time';

/**
 * The faceless video compiler.
 *
 * Turns a set of generated scenes — one still image and one narration clip
 * each — into a complete ffmpeg invocation that produces a finished vertical
 * video. This is what makes the studio produce a file rather than a plan.
 *
 * Pure, like the rest of the video layer: no filesystem, no process. The
 * command it returns is asserted in tests and can be shown in the UI, which
 * is the only practical way to debug a 40-node filter graph.
 */

export interface SlideshowScene {
  /** Still image to display for this scene. */
  imagePath: string;
  /** Narration clip. Scenes without narration hold on the image in silence. */
  audioPath: string | null;
  durationSec: number;
}

export interface SlideshowRequest {
  scenes: SlideshowScene[];
  outputPath: string;
  width: number;
  height: number;
  fps: number;
  /** Burned-in captions. */
  subtitlePath?: string;
  fontsDir?: string;
  /** Music bed, ducked under the narration. */
  musicPath?: string;
  musicGainDb?: number;
  /** Crossfade between scenes. Zero produces hard cuts. */
  transitionSec?: number;
  /** Slow push-in on each still, which is what stops a slideshow looking dead. */
  kenBurns?: boolean;
  crf?: number;
  preset?: string;
}

export interface SlideshowCommand {
  args: string[];
  filterGraph: string;
  durationSec: number;
}

/** Escape a path for use inside a filter argument. */
function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Build the per-scene video chain.
 *
 * Each still is scaled to cover the frame, cropped to it, and — with Ken
 * Burns on — pushed in slowly. `zoompan` works in frames rather than seconds,
 * so the zoom rate is derived from the scene duration and fps; a fixed rate
 * would make short scenes lurch and long ones drift off the subject.
 */
function sceneVideoChain(
  scene: SlideshowScene,
  index: number,
  request: SlideshowRequest,
): { label: string; filter: string } {
  const { width, height, fps } = request;
  const frames = Math.max(1, Math.round(scene.durationSec * fps));
  const label = `v${index}`;

  // Oversample before zoompan: it samples at output resolution, so zooming a
  // 1080-wide image directly produces visible stair-stepping on the pan.
  //
  // 1.4x, not 2x: the zoom only ever reaches 1.08, so 2x buys no visible
  // quality while making every frame a 2160x3840 rescale — that alone took
  // the render several times longer than the video it produced.
  const sourceWidth = Math.round(width * 1.4);
  const sourceHeight = Math.round(height * 1.4);
  const parts = [
    `scale=${sourceWidth}:${sourceHeight}:force_original_aspect_ratio=increase`,
    `crop=${sourceWidth}:${sourceHeight}`,
  ];

  if (request.kenBurns !== false) {
    // 8% over the scene, alternating direction so consecutive scenes do not
    // feel like one continuous move.
    const zoomEnd = 1.08;
    const step = round((zoomEnd - 1) / frames, 6);
    const zoomExpression = `min(zoom+${step},${zoomEnd})`;
    // `zoompan` defines `on` (the output frame index) but not `n`; referring
    // to an undefined variable fails the whole graph with "Error
    // reinitializing filters", so the frame count is substituted literally.
    const drift =
      index % 2 === 0
        ? 'iw/2-(iw/zoom/2)'
        : `iw/2-(iw/zoom/2)+((iw/12)*(on/${frames}-0.5))`;
    parts.push(
      `zoompan=z='${zoomExpression}':x='${drift}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps}`,
    );
  } else {
    parts.push(`scale=${width}:${height}`, `fps=${fps}`);
  }

  parts.push('setsar=1', 'format=yuv420p');

  return { label, filter: `[${index}:v]${parts.join(',')}[${label}]` };
}

export function buildSlideshowCommand(request: SlideshowRequest): SlideshowCommand {
  if (request.scenes.length === 0) {
    throw new Error('A video needs at least one scene');
  }

  const inputs: string[] = [];
  const filters: string[] = [];
  const audioInputIndex = new Map<number, number>();

  // Image inputs first, so scene N is always input N — the video chains index
  // straight into them without a lookup table.
  for (const scene of request.scenes) {
    inputs.push('-loop', '1', '-t', String(round(scene.durationSec, 3)), '-i', scene.imagePath);
  }

  let nextInput = request.scenes.length;
  for (const [index, scene] of request.scenes.entries()) {
    if (scene.audioPath) {
      inputs.push('-i', scene.audioPath);
      audioInputIndex.set(index, nextInput);
      nextInput += 1;
    }
  }

  const musicInputIndex = request.musicPath ? nextInput : null;
  if (request.musicPath) inputs.push('-i', request.musicPath);

  // --- Video ---------------------------------------------------------------
  const sceneLabels: string[] = [];
  for (const [index, scene] of request.scenes.entries()) {
    const chain = sceneVideoChain(scene, index, request);
    filters.push(chain.filter);
    sceneLabels.push(chain.label);
  }

  const transition = request.transitionSec ?? 0;
  let videoLabel: string;
  let totalDuration: number;

  if (transition > 0 && sceneLabels.length > 1) {
    // xfade consumes the overlap from both clips, so each transition shortens
    // the timeline — the offsets have to account for every earlier fade or
    // the last scenes drift out of sync with the narration.
    let current = sceneLabels[0] as string;
    let elapsed = request.scenes[0]?.durationSec ?? 0;

    for (let index = 1; index < sceneLabels.length; index += 1) {
      const next = sceneLabels[index] as string;
      const output = index === sceneLabels.length - 1 ? 'vout' : `vx${index}`;
      const offset = round(elapsed - transition, 3);
      filters.push(
        `[${current}][${next}]xfade=transition=fade:duration=${transition}:offset=${offset}[${output}]`,
      );
      current = output;
      elapsed = round(elapsed - transition + (request.scenes[index]?.durationSec ?? 0), 3);
    }

    videoLabel = current;
    totalDuration = elapsed;
  } else {
    filters.push(`${sceneLabels.map((label) => `[${label}]`).join('')}concat=n=${sceneLabels.length}:v=1:a=0[vcat]`);
    videoLabel = 'vcat';
    totalDuration = round(
      request.scenes.reduce((sum, scene) => sum + scene.durationSec, 0),
      3,
    );
  }

  if (request.subtitlePath) {
    const fonts = request.fontsDir ? `:fontsdir='${escapeFilterPath(request.fontsDir)}'` : '';
    filters.push(
      `[${videoLabel}]subtitles='${escapeFilterPath(request.subtitlePath)}'${fonts}[vsub]`,
    );
    videoLabel = 'vsub';
  }

  // --- Audio ---------------------------------------------------------------
  // Narration is placed at its scene's start rather than concatenated, so a
  // clip that is fractionally shorter than its scene cannot shift every
  // later line earlier — drift compounds and by scene eight the captions are
  // visibly wrong.
  const narrationLabels: string[] = [];
  let offset = 0;

  for (const [index, scene] of request.scenes.entries()) {
    const input = audioInputIndex.get(index);
    if (input !== undefined) {
      const delayMs = Math.round(offset * 1000);
      const label = `a${index}`;
      filters.push(
        `[${input}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delayMs}|${delayMs}[${label}]`,
      );
      narrationLabels.push(label);
    }
    const advance = transition > 0 && index > 0 ? scene.durationSec - transition : scene.durationSec;
    offset = round(offset + advance, 3);
  }

  let audioLabel: string | null = null;

  if (narrationLabels.length === 1) {
    audioLabel = narrationLabels[0] as string;
  } else if (narrationLabels.length > 1) {
    filters.push(
      `${narrationLabels.map((label) => `[${label}]`).join('')}amix=inputs=${narrationLabels.length}:duration=longest:normalize=0[anarr]`,
    );
    audioLabel = 'anarr';
  }

  if (musicInputIndex !== null) {
    const gain = request.musicGainDb ?? -18;
    filters.push(
      `[${musicInputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${gain}dB,aloop=loop=-1:size=2e+09,atrim=0:${totalDuration},afade=t=out:st=${round(Math.max(totalDuration - 1.5, 0), 3)}:d=1.5[amusic]`,
    );

    if (audioLabel) {
      // Duck the bed under the voice rather than trusting a fixed level: a
      // static mix either buries the narration or leaves the music inaudible.
      filters.push(
        `[amusic][${audioLabel}]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[aduck]`,
        `[aduck][${audioLabel}]amix=inputs=2:duration=first:normalize=0[amixed]`,
      );
      audioLabel = 'amixed';
    } else {
      audioLabel = 'amusic';
    }
  }

  if (audioLabel) {
    // Broadcast-ish loudness, so a video does not arrive on TikTok 8 LU
    // quieter than everything around it.
    filters.push(`[${audioLabel}]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
    audioLabel = 'aout';
  }

  const filterGraph = filters.join(';');

  const args = [
    '-y',
    ...inputs,
    '-filter_complex',
    filterGraph,
    '-map',
    `[${videoLabel}]`,
  ];

  if (audioLabel) args.push('-map', `[${audioLabel}]`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  else args.push('-an');

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    request.preset ?? 'medium',
    '-crf',
    String(request.crf ?? 20),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(request.fps),
    '-movflags',
    '+faststart',
    '-t',
    String(totalDuration),
    // Machine-readable progress on stdout. Without it the UI shows a bar
    // frozen at the start of the render — the longest stage by far.
    '-progress',
    'pipe:1',
    '-nostats',
    request.outputPath,
  );

  return { args, filterGraph, durationSec: totalDuration };
}

/**
 * Lay narration clips out on a timeline and cut captions to match.
 *
 * Caption timing comes from the measured duration of each narration clip, not
 * from an estimate of reading speed — the whole point of generating the audio
 * first is that its real length is known.
 */
export function planSceneTiming(
  scenes: { text: string; narrationSec: number | null; minSec?: number }[],
  options: { holdSec?: number; maxCueChars?: number } = {},
): { durations: number[]; cues: CaptionCue[] } {
  const hold = options.holdSec ?? 0.35;
  const maxChars = options.maxCueChars ?? 42;

  const durations: number[] = [];
  const cues: CaptionCue[] = [];
  let clock = 0;
  let index = 0;

  for (const scene of scenes) {
    const spoken = scene.narrationSec ?? Math.max(scene.text.length / 14, 1.5);
    const duration = round(Math.max(spoken + hold, scene.minSec ?? 2), 3);

    // Split the line into cue-sized chunks and share the spoken time between
    // them by character count, which tracks speech far better than an even
    // split when one chunk is three words and the next is twelve.
    const chunks = chunkText(scene.text, maxChars);
    const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1;
    let cueStart = clock;

    for (const chunk of chunks) {
      const share = (chunk.length / totalChars) * spoken;
      const start = round(cueStart, 3);
      const end = round(Math.min(cueStart + share, clock + duration), 3);

      cues.push({
        index,
        start,
        end,
        text: chunk,
        tokens: [{ text: chunk, start, end, highlight: false }],
      });

      index += 1;
      cueStart = end;
    }

    durations.push(duration);
    clock = round(clock + duration, 3);
  }

  return { durations, cues };
}

/** Split a line into readable cue-sized pieces on word boundaries. */
export function chunkText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'DejaVu Sans',
  fontSizePx: 64,
  primaryColor: '#ffffff',
  highlightColor: '#ffd400',
  outlineColor: '#000000',
  outlineWidth: 4,
  shadow: 2,
  bold: true,
  uppercase: false,
  positionY: 0.78,
  animation: 'pop',
  maxCharsPerLine: 24,
  maxLines: 2,
};
