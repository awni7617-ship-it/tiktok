import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EditPlan, ExportPreset } from '@/lib/types';
import { toAss } from '@/server/edit/captions';
import { ffmpeg, probeMedia } from './ffmpeg';
import {
  LabelAllocator,
  buildAudioFilters,
  buildCaptionFilter,
  buildEncoderArgs,
  buildEnhanceFilters,
  buildMotionFilter,
  buildMusicMix,
  buildReframeFilter,
  buildScaleFilters,
  buildTrimConcat,
  renderGraph,
  type FilterNode,
} from './filtergraph';
import { logger } from '@/server/obs/logger';

const log = logger.child({ module: 'render' });

export interface RenderRequest {
  inputPath: string;
  outputPath: string;
  plan: EditPlan;
  preset: ExportPreset;
  /** Path to a burned-in ASS subtitle file. Generated automatically if omitted. */
  subtitlePath?: string;
  /** Local path to the music bed, when the plan selects one. */
  musicPath?: string;
  fontsDir?: string;
  /** Colour used to pad letterboxed content. */
  padColor?: string;
  hasAudio: boolean;
}

export interface RenderCommand {
  args: string[];
  filterGraph: string;
  /** Expected output duration, used to compute progress. */
  expectedDurationSec: number;
}

/**
 * Compile an edit plan into a complete ffmpeg invocation.
 *
 * Pure: touches no filesystem and spawns no process, so the exact command a
 * render will run can be asserted in tests and shown in the UI's "inspect
 * render" panel. `renderVideo` is the impure counterpart.
 */
export function buildRenderCommand(request: RenderRequest): RenderCommand {
  const { plan, preset } = request;
  const labels = new LabelAllocator();
  const nodes: FilterNode[] = [];

  const inputs: string[] = ['-i', request.inputPath];
  let musicInputIndex: number | null = null;

  if (plan.music && request.musicPath) {
    musicInputIndex = 1;
    // Loop the bed so a short track still covers a long edit.
    inputs.push('-stream_loop', '-1', '-i', request.musicPath);
  }

  // --- Trim & concat ------------------------------------------------------
  const trim = buildTrimConcat(plan, labels, {
    videoInput: '0:v',
    audioInput: '0:a',
    hasAudio: request.hasAudio,
  });
  nodes.push(...trim.nodes);

  let videoCursor = trim.videoOut;
  let audioCursor = trim.audioOut;

  // --- Reframe ------------------------------------------------------------
  if (plan.reframe) {
    const reframe = buildReframeFilter(plan.reframe, labels, videoCursor);
    nodes.push(...reframe.nodes);
    videoCursor = reframe.output;
  }

  // --- Enhancement --------------------------------------------------------
  const enhance = buildEnhanceFilters(plan.video, labels, videoCursor);
  nodes.push(...enhance.nodes);
  videoCursor = enhance.output;

  // --- Scale to the output frame ------------------------------------------
  const scale = buildScaleFilters(preset, labels, videoCursor, request.padColor ?? 'black');
  nodes.push(...scale.nodes);
  videoCursor = scale.output;

  // --- Motion (after scaling, so zoom maths is in output pixels) ----------
  if (plan.motion.length > 0) {
    const motion = buildMotionFilter(plan.motion, preset, labels, videoCursor);
    nodes.push(...motion.nodes);
    videoCursor = motion.output;
  }

  // --- Captions (last, so text is never scaled or cropped) ----------------
  if (request.subtitlePath && plan.captions.length > 0) {
    const captions = buildCaptionFilter(
      request.subtitlePath,
      labels,
      videoCursor,
      request.fontsDir,
    );
    nodes.push(...captions.nodes);
    videoCursor = captions.output;
  }

  // --- Audio --------------------------------------------------------------
  if (audioCursor) {
    const audio = buildAudioFilters(plan.audio, labels, audioCursor);
    nodes.push(...audio.nodes);
    audioCursor = audio.output;

    if (plan.music && musicInputIndex !== null) {
      const mix = buildMusicMix(labels, audioCursor, `${musicInputIndex}:a`, {
        gainDb: plan.music.gainDb,
        duckDb: plan.music.duckDb,
        fadeInSec: plan.music.fadeInSec,
        fadeOutSec: plan.music.fadeOutSec,
        durationSec: plan.cutPlan.outputDurationSec,
      });
      nodes.push(...mix.nodes);
      audioCursor = mix.output;
    }
  }

  const filterGraph = renderGraph(nodes);

  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-y',
    ...inputs,
  ];

  if (filterGraph) {
    args.push('-filter_complex', filterGraph);
  }

  args.push('-map', filterGraph ? `[${videoCursor}]` : '0:v');
  if (audioCursor) {
    args.push('-map', filterGraph ? `[${audioCursor}]` : '0:a');
  } else if (request.hasAudio) {
    args.push('-map', '0:a');
  }

  args.push(...buildEncoderArgs(preset));

  // Music is looped infinitely; stop when the programme ends.
  if (musicInputIndex !== null) {
    args.push('-shortest');
  }

  args.push('-progress', 'pipe:1', '-nostats', request.outputPath);

  return {
    args,
    filterGraph,
    expectedDurationSec: plan.cutPlan.outputDurationSec,
  };
}

export interface RenderResult {
  outputPath: string;
  durationSec: number;
  width: number;
  height: number;
  sizeBytes: number;
  command: string;
}

export interface RenderOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Render a plan to a file.
 *
 * Writes the ASS subtitle sidecar first when captions are enabled, since the
 * `subtitles` filter reads from disk. The sidecar lives next to the output so
 * it can be shipped alongside the video as an optional caption file.
 */
export async function renderVideo(
  request: RenderRequest,
  options: RenderOptions = {},
): Promise<RenderResult> {
  await mkdir(path.dirname(request.outputPath), { recursive: true });

  let subtitlePath = request.subtitlePath;
  if (!subtitlePath && request.plan.captions.length > 0) {
    subtitlePath = `${request.outputPath.replace(/\.[^.]+$/, '')}.ass`;
    const ass = toAss(request.plan.captions, request.plan.captionStyle, {
      width: request.preset.width,
      height: request.preset.height,
    });
    await writeFile(subtitlePath, ass, 'utf8');
  }

  const command = buildRenderCommand({ ...request, subtitlePath });

  log.info('starting render', {
    output: request.outputPath,
    preset: request.preset.id,
    segments: request.plan.cutPlan.kept.length,
    durationSec: command.expectedDurationSec,
  });

  const started = Date.now();
  await ffmpeg(command.args, {
    onProgress: options.onProgress
      ? (fraction) => options.onProgress?.(fraction)
      : undefined,
    totalDurationSec: command.expectedDurationSec,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 45 * 60 * 1000,
  });

  const probe = await probeMedia(request.outputPath);
  const { stat } = await import('node:fs/promises');
  const stats = await stat(request.outputPath);

  log.info('render complete', {
    output: request.outputPath,
    elapsedMs: Date.now() - started,
    sizeBytes: stats.size,
  });

  return {
    outputPath: request.outputPath,
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    sizeBytes: stats.size,
    command: `ffmpeg ${command.args.join(' ')}`,
  };
}

/** Extract a still frame, used for thumbnails and timeline scrubbing. */
export function buildThumbnailCommand(
  inputPath: string,
  outputPath: string,
  atSec: number,
  size: { width: number; height: number },
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss', String(Math.max(0, atSec)),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase,crop=${size.width}:${size.height}`,
    '-q:v', '3',
    outputPath,
  ];
}

/**
 * Command that measures loudness and the RMS envelope in a single pass.
 * Both measurements feed the audio planner, and doing them together halves
 * the analysis time on long uploads.
 */
export function buildAnalysisCommand(inputPath: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-i', inputPath,
    '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level,loudnorm=print_format=json',
    '-f', 'null',
    '-',
  ];
}

/** Extract a normalised waveform for the timeline UI. */
export function buildWaveformCommand(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i', inputPath,
    '-filter_complex', 'aformat=channel_layouts=mono,compand,showwavespic=s=1600x120:colors=#7C5CFF',
    '-frames:v', '1',
    outputPath,
  ];
}

/** Downscale a proxy for fast scrubbing in the browser editor. */
export function buildProxyCommand(inputPath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i', inputPath,
    '-vf', 'scale=-2:480',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '28',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    outputPath,
  ];
}
