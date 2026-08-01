import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';

const log = logger.child({ module: 'studio:library' });

/**
 * The videos a creator has made.
 *
 * Backed by a JSON file next to the videos themselves rather than a database:
 * the app has to work on a laptop with nothing installed, and a finished video
 * that vanishes when the app restarts is worse than no library at all.
 *
 * The file is small (one record per video) and rewritten atomically, so a
 * crash mid-write cannot leave a half-written index that loses every video.
 */

export interface LibraryVideo {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  sceneCount: number;
  width: number;
  height: number;
  bytes: number;
  /** Absolute path on disk. Never sent to the browser. */
  path: string;
  prompt: string;
}

export function libraryRoot(): string {
  return process.env['PHANTOM_OUTPUT_DIR'] || config.MEDIA_TMP_DIR || path.join(tmpdir(), 'phantom');
}

function videosDir(): string {
  return path.join(libraryRoot(), 'videos');
}

function indexPath(): string {
  return path.join(videosDir(), 'library.json');
}

async function readIndex(): Promise<LibraryVideo[]> {
  try {
    const raw = await readFile(indexPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LibraryVideo[]) : [];
  } catch {
    // Missing or corrupt: an empty library is the right answer either way,
    // and the next write repairs the file.
    return [];
  }
}

async function writeIndex(entries: LibraryVideo[]): Promise<void> {
  await mkdir(videosDir(), { recursive: true });
  const temporary = `${indexPath()}.tmp`;
  await writeFile(temporary, JSON.stringify(entries, null, 2), 'utf8');
  await rename(temporary, indexPath());
}

/**
 * Move a finished render into the library.
 *
 * Rendered files live in a scratch directory that gets cleaned up; keeping a
 * video means moving it somewhere permanent first. `rename` falls back to a
 * copy because the scratch space and the library can be on different volumes.
 */
export async function addToLibrary(
  entry: Omit<LibraryVideo, 'path' | 'bytes'> & { sourcePath: string; bytes: number },
): Promise<LibraryVideo> {
  await mkdir(videosDir(), { recursive: true });
  const destination = path.join(videosDir(), `${entry.id}.mp4`);

  try {
    await rename(entry.sourcePath, destination);
  } catch {
    const { copyFile } = await import('node:fs/promises');
    await copyFile(entry.sourcePath, destination);
  }

  const record: LibraryVideo = {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    durationSec: entry.durationSec,
    sceneCount: entry.sceneCount,
    width: entry.width,
    height: entry.height,
    bytes: entry.bytes,
    prompt: entry.prompt,
    path: destination,
  };

  const entries = await readIndex();
  await writeIndex([record, ...entries.filter((existing) => existing.id !== record.id)]);
  log.info('video saved to library', { id: record.id, durationSec: record.durationSec });

  return record;
}

export async function listLibrary(): Promise<LibraryVideo[]> {
  return readIndex();
}

export async function getLibraryVideo(id: string): Promise<LibraryVideo | undefined> {
  return (await readIndex()).find((entry) => entry.id === id);
}

export async function removeFromLibrary(id: string): Promise<boolean> {
  const entries = await readIndex();
  const victim = entries.find((entry) => entry.id === id);
  if (!victim) return false;

  await writeIndex(entries.filter((entry) => entry.id !== id));
  await rm(victim.path, { force: true }).catch(() => undefined);
  return true;
}
