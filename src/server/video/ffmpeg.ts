import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

/**
 * ffmpeg and ffprobe access.
 *
 * The binaries ship as npm packages, so rendering works on a fresh clone with
 * nothing installed. A system ffmpeg on `PATH` wins when the bundled one is
 * missing (some platforms have no prebuilt binary), and `FFMPEG_PATH` /
 * `FFPROBE_PATH` override both.
 */

let ffmpegPath: string | null | undefined;
let ffprobePath: string | null | undefined;

/**
 * Point a path at the unpacked copy when it resolves inside an asar archive.
 *
 * Electron packs the app into `app.asar`, which the OS cannot execute a binary
 * out of. electron-builder is configured to leave these two packages unpacked
 * alongside it, so the archive path is rewritten to the real one on disk.
 */
function outsideAsar(filePath: string): string {
  return filePath.includes('app.asar')
    ? filePath.replace('app.asar', 'app.asar.unpacked')
    : filePath;
}

/** Both packages export either the path itself or `{ path }`. */
function binaryPathFrom(mod: unknown): string | null {
  if (typeof mod === 'string') return outsideAsar(mod);
  if (mod && typeof mod === 'object' && 'path' in mod) {
    const p = (mod as { path?: unknown }).path;
    if (typeof p === 'string') return outsideAsar(p);
  }
  return null;
}

/**
 * These two requires must stay *literal*.
 *
 * `require(someVariable)` is not a specifier the bundler can match against
 * `serverExternalPackages`, so it gets rewritten and then throws at runtime —
 * which this function would swallow, leaving a build that silently believes
 * ffmpeg is unavailable and refuses every render. Written out, each one is
 * left external and resolves against the real `node_modules` at runtime.
 *
 * They are also loaded lazily rather than at module scope: resolving a native
 * binary path is not something every importer of this file should pay for.
 */
function loadFfmpeg(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return binaryPathFrom(require('ffmpeg-static'));
  } catch {
    return null;
  }
}

function loadFfprobe(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return binaryPathFrom(require('ffprobe-static'));
  } catch {
    return null;
  }
}

export function ffmpegBinary(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  ffmpegPath = process.env.FFMPEG_PATH?.trim() || loadFfmpeg() || null;
  return ffmpegPath;
}

export function ffprobeBinary(): string | null {
  if (ffprobePath !== undefined) return ffprobePath;
  ffprobePath = process.env.FFPROBE_PATH?.trim() || loadFfprobe() || null;
  return ffprobePath;
}

/** Whether rendering is possible at all. Surfaced in settings and health. */
export async function hasFfmpeg(): Promise<boolean> {
  const bin = ffmpegBinary();
  if (!bin) return false;
  try {
    await fs.access(bin);
    return true;
  } catch {
    // A bare command name like `ffmpeg` is not a path; trust PATH resolution.
    return !bin.includes('/') && !bin.includes('\\');
  }
}

/**
 * Whether this ffmpeg was built with a given filter.
 *
 * Builds vary in what they compile in — the widely used static builds ship
 * without `drawtext` because it needs freetype — so anything optional is
 * checked before it is relied on rather than discovered as a failed render.
 */
const filterCache = new Map<string, boolean>();

export async function hasFilter(name: string): Promise<boolean> {
  const cached = filterCache.get(name);
  if (cached !== undefined) return cached;

  const bin = ffmpegBinary();
  if (!bin) return false;

  const available = await new Promise<boolean>((resolve) => {
    const child = spawn(bin, ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('error', () => resolve(false));
    child.on('close', () => {
      // Lines read `TSC name  A->A  description`, so the name is the second
      // column — matching anywhere would hit descriptions too.
      const names = out
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[1])
        .filter(Boolean);
      resolve(names.includes(name));
    });
  });

  filterCache.set(name, available);
  return available;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/**
 * Run ffmpeg to completion.
 *
 * stderr is captured rather than streamed because ffmpeg writes progress
 * there; only the tail is kept, which is where the actual error lives.
 */
export function runFfmpeg(args: string[], timeoutMs = 10 * 60_000): Promise<void> {
  const bin = ffmpegBinary();
  if (!bin) return Promise.reject(new FfmpegError('ffmpeg is not available', ''));

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new FfmpegError(`ffmpeg timed out after ${Math.round(timeoutMs / 1000)}s`, stderr));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new FfmpegError(`ffmpeg failed to start: ${error.message}`, stderr));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new FfmpegError(`ffmpeg exited with code ${code}`, stderr.trim()));
    });
  });
}

/** Duration of a media file in seconds. */
export async function probeDuration(file: string): Promise<number> {
  const bin = ffprobeBinary();
  if (!bin) throw new Error('ffprobe is not available');

  const args = [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    file,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited with ${code}: ${err.trim()}`));
      const seconds = Number.parseFloat(out.trim());
      if (!Number.isFinite(seconds)) return reject(new Error(`ffprobe gave no duration for ${file}`));
      resolve(seconds);
    });
  });
}
