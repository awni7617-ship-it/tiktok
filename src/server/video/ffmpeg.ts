import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import type { MediaProbe } from '@/lib/types';
import { logger } from '@/server/obs/logger';

/**
 * Thin, well-behaved wrapper around the ffmpeg/ffprobe binaries.
 *
 * Deliberately does not shell out through a string: arguments are passed as an
 * array so a filename containing a quote or a semicolon can never become a
 * command injection. Progress is parsed from ffmpeg's `-progress pipe:1`
 * stream so the UI can show a real percentage rather than a spinner.
 */

const log = logger.child({ module: 'ffmpeg' });

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

export function resolvePaths(): FfmpegPaths {
  return {
    ffmpeg: process.env['FFMPEG_PATH'] || 'ffmpeg',
    ffprobe: process.env['FFPROBE_PATH'] || 'ffprobe',
  };
}

/** True when both binaries are present and executable. */
export async function isFfmpegAvailable(): Promise<boolean> {
  const paths = resolvePaths();
  const results = await Promise.all(
    [paths.ffmpeg, paths.ffprobe].map(async (binary) => {
      if (binary.includes('/')) {
        try {
          await access(binary, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      }
      return runOk(binary, ['-version']);
    }),
  );
  return results.every(Boolean);
}

async function runOk(command: string, args: string[]): Promise<boolean> {
  try {
    const result = await run(command, args, { timeoutMs: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  /** Called with a 0-1 fraction as ffmpeg reports progress. */
  onProgress?: (fraction: number, raw: Record<string, string>) => void;
  /** Total duration in seconds, needed to turn `out_time` into a fraction. */
  totalDurationSec?: number;
  signal?: AbortSignal;
}

/**
 * Run a process to completion, capturing output.
 *
 * stderr is capped at 512KB: ffmpeg is chatty and a long render can otherwise
 * accumulate tens of megabytes of frame logs in memory for no benefit.
 */
export function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { timeoutMs = 0, onProgress, totalDurationSec, signal } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const maxBuffer = 512 * 1024;
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill('SIGKILL');
            if (!settled) {
              settled = true;
              reject(new Error(`${command} timed out after ${timeoutMs}ms`));
            }
          }, timeoutMs)
        : null;

    const onAbort = () => {
      child.kill('SIGTERM');
      // Give ffmpeg a moment to flush the output file before forcing it.
      setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (onProgress) {
        const parsed = parseProgress(text);
        if (parsed) {
          const outTime = Number.parseFloat(parsed['out_time_ms'] ?? '0') / 1_000_000;
          if (totalDurationSec && totalDurationSec > 0) {
            onProgress(Math.min(1, outTime / totalDurationSec), parsed);
          }
        }
      }
      if (stdout.length < maxBuffer) stdout += text;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}

/** Parse one `-progress pipe:1` block into key/value pairs. */
export function parseProgress(chunk: string): Record<string, string> | null {
  const entries = chunk
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)] as const;
    });

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/** Run ffmpeg, throwing a rich error on non-zero exit. */
export async function ffmpeg(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { ffmpeg: binary } = resolvePaths();
  log.debug('running ffmpeg', { args: args.join(' ').slice(0, 2000) });

  const result = await run(binary, args, options);
  if (result.code !== 0) {
    throw new FfmpegError(
      `ffmpeg exited with code ${result.code}: ${lastLines(result.stderr, 8)}`,
      result.code,
      result.stderr,
    );
  }
  return result;
}

export async function ffprobe(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { ffprobe: binary } = resolvePaths();
  const result = await run(binary, args, options);
  if (result.code !== 0) {
    throw new FfmpegError(
      `ffprobe exited with code ${result.code}: ${lastLines(result.stderr, 5)}`,
      result.code,
      result.stderr,
    );
  }
  return result;
}

function lastLines(text: string, count: number): string {
  return text.trim().split('\n').slice(-count).join('\n');
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

export function probeArgs(input: string): string[] {
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input,
  ];
}

/**
 * Parse ffprobe JSON into our `MediaProbe`.
 *
 * Frame rate arrives as a rational string (`30000/1001`), duration can live on
 * either the stream or the container, and audio-only files have no video
 * stream at all — all handled here so callers get one predictable shape.
 */
export function parseProbe(json: string): MediaProbe {
  const data = JSON.parse(json) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: Array<Record<string, unknown>>;
  };

  const streams = data.streams ?? [];
  const video = streams.find((s) => s['codec_type'] === 'video');
  const audio = streams.find((s) => s['codec_type'] === 'audio');

  const durationSec =
    toNumber(data.format?.duration) ??
    toNumber(video?.['duration'] as string | undefined) ??
    toNumber(audio?.['duration'] as string | undefined) ??
    0;

  const bitrate = toNumber(data.format?.bit_rate);

  return {
    durationSec: Math.max(0, durationSec),
    width: toNumber(video?.['width']) ?? 0,
    height: toNumber(video?.['height']) ?? 0,
    fps: parseFrameRate((video?.['avg_frame_rate'] as string) || (video?.['r_frame_rate'] as string)),
    hasAudio: Boolean(audio),
    audioChannels: toNumber(audio?.['channels']) ?? 0,
    audioSampleRate: toNumber(audio?.['sample_rate']) ?? 0,
    videoCodec: (video?.['codec_name'] as string) ?? null,
    audioCodec: (audio?.['codec_name'] as string) ?? null,
    bitrateKbps: bitrate !== null ? Math.round(bitrate / 1000) : null,
  };
}

/** `30000/1001` → 29.97. Returns 0 for `0/0`, which ffprobe emits for images. */
export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Probe a file on disk or a URL ffmpeg can read. */
export async function probeMedia(input: string): Promise<MediaProbe> {
  const result = await ffprobe(probeArgs(input), { timeoutMs: 60_000 });
  return parseProbe(result.stdout);
}
