import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

/**
 * Everything the app owns lives in one directory, so "where is my stuff" has
 * a single answer and uninstalling is one `rm -rf`.
 *
 * Override with `AUTOREEL_DATA_DIR` to keep it on another disk — rendering
 * writes a lot of intermediate frames and audio.
 */
export function dataDir(): string {
  const override = process.env.AUTOREEL_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.autoreel');
}

export function videosDir(): string {
  return path.join(dataDir(), 'videos');
}

/** Per-video working directory: script, audio, frames and the final mp4. */
export function videoDir(videoId: string): string {
  return path.join(videosDir(), videoId);
}

/** Resolve a store-relative path (as held in `Video.file`) to an absolute one. */
export function resolveData(relative: string): string {
  const abs = path.resolve(dataDir(), relative);
  // A stored path is only ever produced by us, but it is read back from a
  // JSON file that a user can edit, so it is treated as untrusted input.
  const root = path.resolve(dataDir());
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the data directory: ${relative}`);
  }
  return abs;
}

/** Store-relative form of an absolute path, for persisting in JSON. */
export function relativeToData(absolute: string): string {
  return path.relative(dataDir(), absolute).split(path.sep).join('/');
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
