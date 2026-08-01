import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir, ensureDir } from './paths';
import type { Channel, Job, Settings, Video } from '@/lib/types';

/**
 * Persistence is a handful of JSON files in the data directory.
 *
 * A single-user app that renders a few videos a day does not have a database's
 * problems, and a database is the single biggest obstacle to "download it and
 * run it". The cost is that every write rewrites a file; at the scale this
 * runs at (hundreds of records, not millions) that is measured in microseconds.
 *
 * Two processes do touch these files — the web app and the worker — so writes
 * go through a temp file and `rename`, which is atomic on both POSIX and
 * Windows. A reader therefore sees either the old file or the new one, never
 * a half-written one. Within a process, `withFile` serialises read-modify-write
 * so two concurrent handlers cannot clobber each other.
 */

interface Shape {
  channels: Channel[];
  videos: Video[];
  jobs: Job[];
  settings: Settings;
}

const FILES: { [K in keyof Shape]: string } = {
  channels: 'channels.json',
  videos: 'videos.json',
  jobs: 'jobs.json',
  settings: 'settings.json',
};

const DEFAULTS: Shape = {
  channels: [],
  videos: [],
  jobs: [],
  settings: {
    anthropicApiKey: null,
    openaiApiKey: null,
    outputDir: null,
    accounts: [],
  },
};

function filePath(key: keyof Shape): string {
  return path.join(dataDir(), FILES[key]);
}

export async function read<K extends keyof Shape>(key: K): Promise<Shape[K]> {
  try {
    const raw = await fs.readFile(filePath(key), 'utf8');
    const parsed = JSON.parse(raw) as Shape[K];
    // An empty or truncated file parses to null rather than throwing.
    if (parsed == null) return structuredClone(DEFAULTS[key]);
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return structuredClone(DEFAULTS[key]);
    if (error instanceof SyntaxError) {
      // Refusing to start because one file is corrupt would strand the user
      // with no way in. Losing that file's contents is bad; losing access to
      // the whole app is worse.
      console.error(`[store] ${FILES[key]} is not valid JSON — starting from empty`);
      return structuredClone(DEFAULTS[key]);
    }
    throw error;
  }
}

async function write<K extends keyof Shape>(key: K, value: Shape[K]): Promise<void> {
  await ensureDir(dataDir());
  const target = filePath(key);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temp, target);
}

/** Serialises read-modify-write per file within this process. */
const locks = new Map<keyof Shape, Promise<unknown>>();

export async function withFile<K extends keyof Shape, R>(
  key: K,
  mutate: (current: Shape[K]) => Promise<[Shape[K], R]> | [Shape[K], R],
): Promise<R> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const current = await read(key);
    const [next, result] = await mutate(current);
    await write(key, next);
    return result;
  });
  // Keep the chain alive even when this link rejects, or one failure would
  // deadlock every later writer.
  locks.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

// --- Channels -------------------------------------------------------------

export async function listChannels(): Promise<Channel[]> {
  return read('channels');
}

export async function getChannel(id: string): Promise<Channel | null> {
  const all = await read('channels');
  return all.find((c) => c.id === id) ?? null;
}

export async function putChannel(channel: Channel): Promise<Channel> {
  return withFile('channels', (all) => {
    const index = all.findIndex((c) => c.id === channel.id);
    const next = [...all];
    if (index === -1) next.push(channel);
    else next[index] = channel;
    return [next, channel];
  });
}

export async function updateChannel(
  id: string,
  patch: Partial<Omit<Channel, 'id' | 'createdAt'>>,
): Promise<Channel | null> {
  return withFile('channels', (all) => {
    const index = all.findIndex((c) => c.id === id);
    if (index === -1) return [all, null];
    const existing = all[index]!;
    const updated: Channel = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    const next = [...all];
    next[index] = updated;
    return [next, updated];
  });
}

export async function deleteChannel(id: string): Promise<boolean> {
  return withFile('channels', (all) => {
    const next = all.filter((c) => c.id !== id);
    return [next, next.length !== all.length];
  });
}

// --- Videos ---------------------------------------------------------------

export async function listVideos(): Promise<Video[]> {
  const all = await read('videos');
  // Newest first. Ids are time-sortable, so this needs no date parsing.
  return [...all].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export async function getVideo(id: string): Promise<Video | null> {
  const all = await read('videos');
  return all.find((v) => v.id === id) ?? null;
}

export async function putVideo(video: Video): Promise<Video> {
  return withFile('videos', (all) => {
    const index = all.findIndex((v) => v.id === video.id);
    const next = [...all];
    if (index === -1) next.push(video);
    else next[index] = video;
    return [next, video];
  });
}

export async function updateVideo(
  id: string,
  patch: Partial<Omit<Video, 'id' | 'createdAt'>>,
): Promise<Video | null> {
  return withFile('videos', (all) => {
    const index = all.findIndex((v) => v.id === id);
    if (index === -1) return [all, null];
    const existing = all[index]!;
    const updated: Video = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    const next = [...all];
    next[index] = updated;
    return [next, updated];
  });
}

export async function deleteVideo(id: string): Promise<boolean> {
  return withFile('videos', (all) => {
    const next = all.filter((v) => v.id !== id);
    return [next, next.length !== all.length];
  });
}

// --- Settings -------------------------------------------------------------

export async function getSettings(): Promise<Settings> {
  const stored = await read('settings');
  // Merge over defaults so a file written by an older version is still valid.
  return { ...DEFAULTS.settings, ...stored };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return withFile('settings', (current) => {
    const next: Settings = { ...DEFAULTS.settings, ...current, ...patch };
    return [next, next];
  });
}
