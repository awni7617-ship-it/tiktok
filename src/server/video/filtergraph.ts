import type {
  AudioPlan,
  CaptionStyle,
  CropKeyframe,
  EditPlan,
  ExportPreset,
  MotionCue,
  ReframePlan,
  VideoEnhancePlan,
} from '@/lib/types';
import { round } from '@/lib/time';

/**
 * ffmpeg filter-graph compiler.
 *
 * Turns an `EditPlan` into the filter chain and argument list that renders it.
 * Kept entirely separate from process execution so the graph can be unit-tested
 * — filter graphs are notoriously easy to break and notoriously hard to debug
 * from a render failure three minutes into a job.
 *
 * Conventions:
 *   - labels are `[v0]`, `[a0]`, … and always consumed exactly once
 *   - every numeric value is rounded before interpolation; ffmpeg rejects
 *     `1e-7` style exponent notation in several filters
 */

/** Escape a value used inside a filter argument (`:` and `\` are separators). */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/**
 * Escape a path for filters that take a filename (subtitles, movie).
 * These parse their argument twice, so separators need double escaping.
 */
export function escapeFilterPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/:/g, '\\\\:')
    .replace(/'/g, "\\\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

export interface FilterNode {
  filter: string;
  args?: Record<string, string | number | boolean | undefined>;
  inputs: string[];
  outputs: string[];
}

export function renderNode(node: FilterNode): string {
  const inputs = node.inputs.map((label) => `[${label}]`).join('');
  const outputs = node.outputs.map((label) => `[${label}]`).join('');

  const args = node.args
    ? Object.entries(node.args)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) =>
          typeof value === 'number' ? `${key}=${round(value, 6)}` : `${key}=${value}`,
        )
        .join(':')
    : '';

  return `${inputs}${node.filter}${args ? `=${args}` : ''}${outputs}`;
}

export function renderGraph(nodes: FilterNode[]): string {
  return nodes.map(renderNode).join(';');
}

/** Incrementing label allocator so chains never collide. */
export class LabelAllocator {
  private counter = 0;

  next(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }
}

// ---------------------------------------------------------------------------
// Trim & concat
// ---------------------------------------------------------------------------

/**
 * Build the trim/concat section that applies the cut plan.
 *
 * Each kept segment becomes a `trim` + `setpts` pair (and `atrim` + `asetpts`
 * for audio), then all segments are concatenated. Retimed segments get
 * `setpts`/`atempo` factors applied here so pacing survives the concat.
 *
 * `atempo` only accepts 0.5–2.0, so out-of-range factors are decomposed into a
 * chain — required for correctness even though our pacing caps stay well inside
 * the range, because manual speed edits do not.
 */
export function buildTrimConcat(
  plan: EditPlan,
  labels: LabelAllocator,
  options: { videoInput: string; audioInput: string; hasAudio: boolean },
): { nodes: FilterNode[]; videoOut: string; audioOut: string | null } {
  const segments = plan.cutPlan.kept;
  const nodes: FilterNode[] = [];

  if (segments.length === 0) {
    return { nodes, videoOut: options.videoInput, audioOut: options.hasAudio ? options.audioInput : null };
  }

  // A single full-length 1x segment needs no trimming at all.
  const isPassthrough =
    segments.length === 1 &&
    segments[0]!.sourceStart <= 0.001 &&
    Math.abs(segments[0]!.sourceEnd - plan.sourceDurationSec) < 0.05 &&
    Math.abs(segments[0]!.speed - 1) < 0.001;

  if (isPassthrough) {
    return { nodes, videoOut: options.videoInput, audioOut: options.hasAudio ? options.audioInput : null };
  }

  const videoLabels: string[] = [];
  const audioLabels: string[] = [];

  for (const segment of segments) {
    const trimmed = labels.next('vtrim');
    const vLabel = labels.next('vseg');
    const isRetimed = Math.abs(segment.speed - 1) >= 0.001;

    nodes.push({
      filter: 'trim',
      args: { start: round(segment.sourceStart, 3), end: round(segment.sourceEnd, 3) },
      inputs: [options.videoInput],
      outputs: [trimmed],
    });

    // setpts takes a bare expression rather than key=value pairs, so it is
    // emitted as a pre-formatted filter string with no args.
    nodes.push({
      filter: isRetimed
        ? `setpts=(PTS-STARTPTS)/${round(segment.speed, 4)}`
        : 'setpts=PTS-STARTPTS',
      inputs: [trimmed],
      outputs: [vLabel],
    });

    videoLabels.push(vLabel);

    if (options.hasAudio) {
      const aTrimmed = labels.next('atrim');
      const aReset = labels.next('areset');
      const aLabel = labels.next('aseg');

      nodes.push({
        filter: 'atrim',
        args: { start: round(segment.sourceStart, 3), end: round(segment.sourceEnd, 3) },
        inputs: [options.audioInput],
        outputs: [aTrimmed],
      });
      nodes.push({
        filter: 'asetpts=PTS-STARTPTS',
        inputs: [aTrimmed],
        outputs: [aReset],
      });

      const tempoChain = decomposeTempo(segment.speed);
      let cursor = aReset;

      tempoChain.forEach((factor, index) => {
        const out = index === tempoChain.length - 1 ? aLabel : labels.next('atempo');
        nodes.push({
          filter: `atempo=${round(factor, 4)}`,
          inputs: [cursor],
          outputs: [out],
        });
        cursor = out;
      });

      if (tempoChain.length === 0) {
        // Speed is 1x: pass through so the segment still owns a stable label.
        nodes.push({ filter: 'anull', inputs: [cursor], outputs: [aLabel] });
      }

      audioLabels.push(aLabel);
    }
  }

  const videoOut = labels.next('vcat');
  const audioOut = options.hasAudio ? labels.next('acat') : null;

  if (options.hasAudio && audioOut) {
    const interleaved: string[] = [];
    for (let i = 0; i < videoLabels.length; i++) {
      interleaved.push(videoLabels[i]!, audioLabels[i]!);
    }
    nodes.push({
      filter: 'concat',
      args: { n: segments.length, v: 1, a: 1 },
      inputs: interleaved,
      outputs: [videoOut, audioOut],
    });
  } else {
    nodes.push({
      filter: 'concat',
      args: { n: segments.length, v: 1, a: 0 },
      inputs: videoLabels,
      outputs: [videoOut],
    });
  }

  return { nodes, videoOut, audioOut };
}

/**
 * `atempo` is limited to [0.5, 2.0]. Decompose an arbitrary factor into a chain
 * of in-range factors whose product equals the target. Returns `[]` for 1x.
 */
export function decomposeTempo(speed: number): number[] {
  if (!Number.isFinite(speed) || speed <= 0) return [];
  if (Math.abs(speed - 1) < 0.001) return [];

  const factors: number[] = [];
  let remaining = speed;

  while (remaining > 2.0) {
    factors.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(round(remaining, 4));
  return factors;
}

// ---------------------------------------------------------------------------
// Reframe
// ---------------------------------------------------------------------------

/**
 * Compile the crop keyframes into an animated `crop` filter.
 *
 * ffmpeg has no keyframe primitive, so the animation is expressed as a nested
 * `if(lt(t,...))` expression that linearly interpolates between keyframes.
 * Static plans collapse to constants, which is both faster and far easier to
 * read in a render log.
 */
export function buildReframeFilter(
  reframe: ReframePlan,
  labels: LabelAllocator,
  input: string,
): { nodes: FilterNode[]; output: string } {
  const output = labels.next('vcrop');
  const frames = reframe.keyframes;
  const first = frames[0];

  if (!first) {
    return { nodes: [], output: input };
  }

  if (frames.length === 1 || reframe.isStaticFallback) {
    return {
      nodes: [
        {
          filter: 'crop',
          args: { w: first.width, h: first.height, x: first.x, y: first.y },
          inputs: [input],
          outputs: [output],
        },
      ],
      output,
    };
  }

  const xExpr = buildKeyframeExpression(frames, (frame) => frame.x);
  const yExpr = buildKeyframeExpression(frames, (frame) => frame.y);

  return {
    nodes: [
      {
        filter: 'crop',
        args: {
          w: first.width,
          h: first.height,
          x: `'${xExpr}'`,
          y: `'${yExpr}'`,
        },
        inputs: [input],
        outputs: [output],
      },
    ],
    output,
  };
}

/**
 * Build a piecewise-linear ffmpeg expression over keyframes.
 *
 * Produces `if(lt(t,T1), A + (B-A)*(t-T0)/(T1-T0), if(lt(t,T2), …))`. Nesting
 * depth equals the keyframe count, so `dropRedundantKeyframes` upstream is what
 * keeps this expression a sane length.
 */
export function buildKeyframeExpression(
  frames: CropKeyframe[],
  pick: (frame: CropKeyframe) => number,
): string {
  if (frames.length === 0) return '0';
  if (frames.length === 1) return String(pick(frames[0]!));

  let expression = String(pick(frames[frames.length - 1]!));

  for (let i = frames.length - 2; i >= 0; i--) {
    const current = frames[i]!;
    const next = frames[i + 1]!;
    const from = pick(current);
    const to = pick(next);
    const span = round(next.time - current.time, 4);

    const segment =
      span <= 0 || from === to
        ? String(from)
        : `(${from}+(${to - from})*(t-${round(current.time, 4)})/${span})`;

    expression = `if(lt(t,${round(next.time, 4)}),${segment},${expression})`;
  }

  return expression;
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * Apply motion cues as a single animated `scale`+`crop` pair.
 *
 * `zoompan` is the obvious choice but it is frame-count driven and interacts
 * badly with variable frame rates after a concat. Scaling up and cropping back
 * to the output size gives the same visual result with time-based expressions.
 */
export function buildMotionFilter(
  cues: MotionCue[],
  preset: ExportPreset,
  labels: LabelAllocator,
  input: string,
): { nodes: FilterNode[]; output: string } {
  if (cues.length === 0) return { nodes: [], output: input };

  const zoomExpr = buildZoomExpression(cues);
  const scaled = labels.next('vzoom');
  const output = labels.next('vmotion');

  return {
    nodes: [
      {
        filter: 'scale',
        args: {
          w: `'trunc(${preset.width}*(${zoomExpr})/2)*2'`,
          h: `'trunc(${preset.height}*(${zoomExpr})/2)*2'`,
          eval: 'frame',
        },
        inputs: [input],
        outputs: [scaled],
      },
      {
        filter: 'crop',
        args: {
          w: preset.width,
          h: preset.height,
          x: '(iw-ow)/2',
          y: '(ih-oh)/2',
        },
        inputs: [scaled],
        outputs: [output],
      },
    ],
    output,
  };
}

/** Piecewise zoom factor over time; 1.0 outside any cue. */
export function buildZoomExpression(cues: MotionCue[]): string {
  let expression = '1';

  for (const cue of [...cues].reverse()) {
    const span = round(cue.end - cue.start, 4);
    if (span <= 0) continue;

    const progress = `((t-${round(cue.start, 4)})/${span})`;
    let factor: string;

    switch (cue.kind) {
      case 'zoom-in':
      case 'push':
        factor = `(1+${round(cue.intensity - 1, 4)}*${progress})`;
        break;
      case 'zoom-out':
        factor = `(${round(cue.intensity, 4)}-${round(cue.intensity - 1, 4)}*${progress})`;
        break;
      case 'ken-burns':
        // Ease in and out so the move settles rather than stopping dead.
        factor = `(1+${round(cue.intensity - 1, 4)}*sin(${progress}*PI))`;
        break;
      case 'shake':
        factor = `(1+${round((cue.intensity - 1) * 0.5, 4)}*sin(t*24))`;
        break;
      case 'none':
      default:
        continue;
    }

    expression = `if(between(t,${round(cue.start, 4)},${round(cue.end, 4)}),${factor},${expression})`;
  }

  return expression;
}

// ---------------------------------------------------------------------------
// Enhancement, scaling, captions
// ---------------------------------------------------------------------------

/** Denoise / sharpen / colour, in the order that produces the fewest artifacts. */
export function buildEnhanceFilters(
  enhance: VideoEnhancePlan,
  labels: LabelAllocator,
  input: string,
): { nodes: FilterNode[]; output: string } {
  const nodes: FilterNode[] = [];
  let cursor = input;

  // Denoise before sharpening, or sharpening amplifies the noise it removes.
  if (enhance.denoise) {
    const out = labels.next('vdn');
    nodes.push({
      filter: 'hqdn3d',
      args: { luma_spatial: 2, chroma_spatial: 1.5, luma_tmp: 3, chroma_tmp: 2.25 },
      inputs: [cursor],
      outputs: [out],
    });
    cursor = out;
  }

  if (enhance.sharpen > 0) {
    const out = labels.next('vsh');
    nodes.push({
      filter: 'unsharp',
      args: {
        luma_msize_x: 5,
        luma_msize_y: 5,
        luma_amount: round(enhance.sharpen, 2),
        chroma_amount: 0,
      },
      inputs: [cursor],
      outputs: [out],
    });
    cursor = out;
  }

  const needsColor =
    Math.abs(enhance.saturation - 1) > 0.001 ||
    Math.abs(enhance.contrast - 1) > 0.001 ||
    Math.abs(enhance.brightness) > 0.001;

  if (needsColor) {
    const out = labels.next('veq');
    nodes.push({
      filter: 'eq',
      args: {
        saturation: round(enhance.saturation, 3),
        contrast: round(enhance.contrast, 3),
        brightness: round(enhance.brightness, 3),
      },
      inputs: [cursor],
      outputs: [out],
    });
    cursor = out;
  }

  return { nodes, output: cursor };
}

/**
 * Scale and pad to the exact output frame.
 *
 * `force_original_aspect_ratio=decrease` + `pad` guarantees no distortion: the
 * image fits inside the frame and any remainder becomes bars. After an
 * auto-reframe crop the aspect already matches, so the pad is a no-op.
 */
export function buildScaleFilters(
  preset: ExportPreset,
  labels: LabelAllocator,
  input: string,
  padColor = 'black',
): { nodes: FilterNode[]; output: string } {
  const scaled = labels.next('vscale');
  const padded = labels.next('vpad');

  return {
    nodes: [
      {
        filter: 'scale',
        args: {
          w: preset.width,
          h: preset.height,
          force_original_aspect_ratio: 'decrease',
          flags: 'lanczos',
        },
        inputs: [input],
        outputs: [scaled],
      },
      {
        filter: 'pad',
        args: {
          w: preset.width,
          h: preset.height,
          x: '(ow-iw)/2',
          y: '(oh-ih)/2',
          color: padColor,
        },
        inputs: [scaled],
        outputs: [padded],
      },
    ],
    output: padded,
  };
}

/** Burn an ASS subtitle file into the frame. */
export function buildCaptionFilter(
  assPath: string,
  labels: LabelAllocator,
  input: string,
  fontsDir?: string,
): { nodes: FilterNode[]; output: string } {
  const output = labels.next('vsub');
  return {
    nodes: [
      {
        filter: 'subtitles',
        args: {
          filename: escapeFilterPath(assPath),
          fontsdir: fontsDir ? escapeFilterPath(fontsDir) : undefined,
        },
        inputs: [input],
        outputs: [output],
      },
    ],
    output,
  };
}

// ---------------------------------------------------------------------------
// Audio chain
// ---------------------------------------------------------------------------

/**
 * Build the audio processing chain.
 *
 * Order is the standard broadcast chain: high-pass → denoise → de-ess →
 * compress → loudness normalise → limit. Normalising before compressing would
 * make the compressor's threshold meaningless.
 */
export function buildAudioFilters(
  audio: AudioPlan,
  labels: LabelAllocator,
  input: string,
): { nodes: FilterNode[]; output: string } {
  const nodes: FilterNode[] = [];
  let cursor = input;

  if (audio.highPassHz) {
    const out = labels.next('ahp');
    nodes.push({
      filter: 'highpass',
      args: { f: audio.highPassHz },
      inputs: [cursor],
      outputs: [out],
    });
    cursor = out;
  }

  if (audio.denoise && audio.denoiseStrength > 0) {
    const out = labels.next('adn');
    nodes.push({
      filter: 'afftdn',
      args: { nr: round(audio.denoiseStrength, 1), nf: -25, tn: 1 },
      inputs: [cursor],
      outputs: [out],
    });
    cursor = out;
  }

  if (audio.deEss) {
    const out = labels.next('ade');
    nodes.push({
      filter: 'deesser',
      args: { i: 0.4, m: 0.5, f: 0.5, s: 'o' },
      inputs: [cursor],
      outputs: [out],
    });
    cursor = out;
  }

  if (audio.compressorRatio && audio.compressorRatio > 1) {
    const out = labels.next('acomp');
    nodes.push({
      filter: 'acompressor',
      args: {
        threshold: '0.089',
        ratio: round(audio.compressorRatio, 2),
        attack: 20,
        release: 250,
        makeup: 1.5,
      },
      inputs: [cursor],
      outputs: [out],
    });
    cursor = out;
  }

  const normalized = labels.next('anorm');
  nodes.push({
    filter: 'loudnorm',
    args: {
      I: round(audio.targetLufs, 1),
      TP: round(audio.targetTruePeakDb, 1),
      LRA: round(audio.loudnessRangeLu, 1),
    },
    inputs: [cursor],
    outputs: [normalized],
  });
  cursor = normalized;

  // Final safety limiter — loudnorm's own limiter is bypassed in single-pass
  // mode when the measured values are absent.
  const limited = labels.next('alim');
  nodes.push({
    filter: 'alimiter',
    args: { limit: round(dbToLinear(audio.targetTruePeakDb), 4), level: 'disabled' },
    inputs: [cursor],
    outputs: [limited],
  });

  return { nodes, output: limited };
}

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

/**
 * Mix a music bed under the narration with sidechain ducking.
 *
 * `sidechaincompress` keyed on the voice track is what makes music sit *under*
 * speech rather than fighting it — a static gain reduction either buries the
 * music or lets it mask the words.
 */
export function buildMusicMix(
  labels: LabelAllocator,
  voiceInput: string,
  musicInput: string,
  options: { gainDb: number; duckDb: number; fadeInSec: number; fadeOutSec: number; durationSec: number },
): { nodes: FilterNode[]; output: string } {
  const nodes: FilterNode[] = [];

  const leveled = labels.next('mvol');
  nodes.push({
    filter: 'volume',
    args: { volume: `${round(options.gainDb, 2)}dB` },
    inputs: [musicInput],
    outputs: [leveled],
  });

  const faded = labels.next('mfade');
  const fadeOutStart = Math.max(0, options.durationSec - options.fadeOutSec);
  nodes.push({
    filter: 'afade',
    args: { t: 'in', st: 0, d: round(options.fadeInSec, 2) },
    inputs: [leveled],
    outputs: [faded],
  });

  const faded2 = labels.next('mfade');
  nodes.push({
    filter: 'afade',
    args: { t: 'out', st: round(fadeOutStart, 2), d: round(options.fadeOutSec, 2) },
    inputs: [faded],
    outputs: [faded2],
  });

  // Split the voice: one copy drives the sidechain key, one is mixed.
  const voiceA = labels.next('vkey');
  const voiceB = labels.next('vmix');
  nodes.push({
    filter: 'asplit',
    args: undefined,
    inputs: [voiceInput],
    outputs: [voiceA, voiceB],
  });

  const ducked = labels.next('mduck');
  nodes.push({
    filter: 'sidechaincompress',
    args: {
      threshold: 0.03,
      ratio: round(Math.max(2, Math.abs(options.duckDb) / 2), 2),
      attack: 15,
      release: 350,
      makeup: 1,
    },
    inputs: [faded2, voiceA],
    outputs: [ducked],
  });

  const output = labels.next('amix');
  nodes.push({
    filter: 'amix',
    args: { inputs: 2, duration: 'first', dropout_transition: 0, normalize: 0 },
    inputs: [voiceB, ducked],
    outputs: [output],
  });

  return { nodes, output };
}

// ---------------------------------------------------------------------------
// Encoder arguments
// ---------------------------------------------------------------------------

/** Codec, rate-control and container flags for a preset. */
export function buildEncoderArgs(preset: ExportPreset): string[] {
  const args: string[] = [];

  switch (preset.videoCodec) {
    case 'h264':
      args.push(
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', String(preset.crf),
        '-maxrate', `${preset.videoBitrateKbps}k`,
        '-bufsize', `${preset.videoBitrateKbps * 2}k`,
        '-profile:v', 'high',
        '-level', '4.2',
        // yuv420p is the only pixel format every platform and phone decodes.
        '-pix_fmt', 'yuv420p',
      );
      break;
    case 'hevc':
      args.push(
        '-c:v', 'libx265',
        '-preset', 'medium',
        '-crf', String(preset.crf),
        '-tag:v', 'hvc1',
        '-pix_fmt', 'yuv420p',
      );
      break;
    case 'vp9':
      args.push(
        '-c:v', 'libvpx-vp9',
        '-crf', String(preset.crf),
        '-b:v', '0',
        '-row-mt', '1',
        '-pix_fmt', 'yuv420p',
      );
      break;
  }

  args.push('-r', String(preset.fps));
  // Two-second GOP: platforms re-encode, and short GOPs survive that better.
  args.push('-g', String(preset.fps * 2));

  if (preset.container === 'webm') {
    args.push('-c:a', 'libopus', '-b:a', `${preset.audioBitrateKbps}k`);
  } else {
    args.push('-c:a', 'aac', '-b:a', `${preset.audioBitrateKbps}k`, '-ar', '48000', '-ac', '2');
  }

  if (preset.container === 'mp4' || preset.container === 'mov') {
    // Front-load the index so the file starts playing before it fully downloads.
    args.push('-movflags', '+faststart');
  }

  return args;
}
