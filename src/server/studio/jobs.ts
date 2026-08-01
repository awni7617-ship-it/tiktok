import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';
import { addToLibrary } from './library';
import { produceVideo, type ProduceOptions, type ProduceProgress } from './produce';

const log = logger.child({ module: 'studio:jobs' });

/**
 * In-process registry for video productions.
 *
 * Deliberately not the Postgres queue: this is the interactive path, where
 * someone is watching a progress bar in front of them. It runs in the same
 * process that serves the request, which is what lets the desktop app produce
 * a video with no database and no worker to install. The durable queue still
 * owns everything that must survive a restart.
 */

export interface StudioJob {
  id: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  progress: ProduceProgress;
  createdAt: number;
  workDir: string;
  title?: string;
  durationSec?: number;
  sceneCount?: number;
  videoPath?: string;
  error?: string;
}

/**
 * Finished jobs are forgotten quickly — their video lives in the library now,
 * so nothing is lost, and their scratch assets (narration clips, stills) are
 * hundreds of megabytes that nobody needs again.
 */
const MAX_RETAINED = 8;

const jobs = new Map<string, StudioJob>();
const controllers = new Map<string, AbortController>();

function outputRoot(): string {
  // The desktop app points this at a writable user directory; a server
  // deployment uses its media temp path.
  return process.env['PHANTOM_OUTPUT_DIR'] || config.MEDIA_TMP_DIR || path.join(tmpdir(), 'phantom');
}

async function evict(): Promise<void> {
  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((a, b) => a.createdAt - b.createdAt);

  while (finished.length > MAX_RETAINED) {
    const victim = finished.shift();
    if (!victim) break;
    jobs.delete(victim.id);
    controllers.delete(victim.id);
    await rm(victim.workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function startProduction(
  options: Omit<ProduceOptions, 'workDir' | 'onProgress' | 'signal'>,
): Promise<StudioJob> {
  const id = randomUUID();

  // `mkdtemp` needs the parent to exist, and on a fresh install it does not.
  const root = outputRoot();
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(path.join(root, 'video-'));
  const controller = new AbortController();

  const job: StudioJob = {
    id,
    status: 'running',
    progress: { stage: 'script', fraction: 0, message: 'Starting' },
    createdAt: Date.now(),
    workDir,
  };

  jobs.set(id, job);
  controllers.set(id, controller);

  // Intentionally not awaited: the route returns immediately and the client
  // polls. An unhandled rejection here would take the server down, so every
  // outcome is recorded on the job instead.
  void produceVideo({ ...options, workDir, signal: controller.signal, onProgress: (progress) => {
      const current = jobs.get(id);
      if (current && current.status === 'running') current.progress = progress;
    } })
    .then(async (result) => {
      const current = jobs.get(id);
      if (!current) return;

      // Into the library before the job is marked done: a video that only
      // exists in a scratch directory disappears on the next cleanup, and
      // "where did my video go" is the worst possible answer.
      const { size } = await stat(result.videoPath);
      const saved = await addToLibrary({
        id,
        title: result.content.title,
        createdAt: new Date().toISOString(),
        durationSec: result.durationSec,
        sceneCount: result.sceneCount,
        width: options.width ?? 1080,
        height: options.height ?? 1920,
        bytes: size,
        prompt: options.prompt,
        sourcePath: result.videoPath,
      });

      current.status = 'done';
      current.videoPath = saved.path;
      current.durationSec = result.durationSec;
      current.sceneCount = result.sceneCount;
      current.title = result.content.title;
      current.progress = { stage: 'done', fraction: 1, message: 'Finished' };
      log.info('production finished', { id, durationSec: result.durationSec });
      await evict();
    })
    .catch(async (error: unknown) => {
      const current = jobs.get(id);
      if (!current) return;
      const aborted = controller.signal.aborted;
      const raw = error instanceof Error ? error.message : String(error);
      current.status = aborted ? 'cancelled' : 'failed';
      current.error = humanizeError(raw);
      log.error('production failed', { id, error: raw });
      await evict();
    });

  return job;
}

/**
 * Turn a provider failure into something a creator can act on.
 *
 * The raw text is accurate and useless: nobody should have to read
 * `{"type":"authentication_error"}` to learn they pasted the wrong key.
 */
export function humanizeError(raw: string): string {
  if (/401|authentication_error|invalid x-api-key|Incorrect API key/i.test(raw)) {
    return 'That API key was rejected. Check it in Settings — or clear it to keep using the offline stand-ins.';
  }
  if (/429|rate.?limit/i.test(raw)) {
    return 'The AI provider is rate-limiting this key. Wait a minute and try again.';
  }
  if (/insufficient_quota|billing|credit balance/i.test(raw)) {
    return 'That account is out of credit with the AI provider. Top it up, or clear the key in Settings to use the offline stand-ins.';
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(raw)) {
    return 'Could not reach the AI provider. Check your internet connection.';
  }
  if (/ffmpeg|filter|Invalid argument/i.test(raw)) {
    return `The render failed. ${raw.slice(0, 200)}`;
  }
  return raw.slice(0, 300);
}

export function getProduction(id: string): StudioJob | undefined {
  return jobs.get(id);
}

export function cancelProduction(id: string): boolean {
  const controller = controllers.get(id);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

export function listProductions(): StudioJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}
