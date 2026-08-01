import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The queue and store, exercised against a real temporary data directory.
 *
 * `AUTOREEL_DATA_DIR` is read on every call rather than at import, so pointing
 * it at a fresh directory per test is enough to isolate them — no mocking of
 * the filesystem, which means these tests cover the actual atomic-rename write
 * path that ships.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoreel-test-'));
  process.env.AUTOREEL_DATA_DIR = dir;
});

afterEach(async () => {
  delete process.env.AUTOREEL_DATA_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('store', () => {
  it('reads empty defaults before anything is written', async () => {
    const { listChannels, listVideos, getSettings } = await import('@/server/store/db');

    expect(await listChannels()).toEqual([]);
    expect(await listVideos()).toEqual([]);
    expect((await getSettings()).accounts).toEqual([]);
  });

  it('round-trips a channel', async () => {
    const { putChannel, getChannel } = await import('@/server/store/db');
    const { buildChannel } = await import('@/server/content/channels');

    const channel = buildChannel({
      name: 'Test',
      nicheId: 'space',
      styleId: 'cinematic',
      voiceId: 'neutral',
      musicId: null,
      cadence: 'daily',
      postingHours: [9],
      platforms: [],
      targetSeconds: 45,
      active: true,
    });

    await putChannel(channel);
    expect((await getChannel(channel.id))?.name).toBe('Test');
  });

  it('updates rather than duplicating on a second put', async () => {
    const { putChannel, listChannels, updateChannel } = await import('@/server/store/db');
    const { buildChannel } = await import('@/server/content/channels');

    const channel = buildChannel({
      name: 'First',
      nicheId: 'space',
      styleId: 'cinematic',
      voiceId: 'neutral',
      musicId: null,
      cadence: 'daily',
      postingHours: [9],
      platforms: [],
      targetSeconds: 45,
      active: true,
    });

    await putChannel(channel);
    await updateChannel(channel.id, { name: 'Second' });

    const all = await listChannels();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Second');
  });

  it('returns null when updating something that does not exist', async () => {
    const { updateChannel, updateVideo } = await import('@/server/store/db');

    expect(await updateChannel('nope', { name: 'x' })).toBeNull();
    expect(await updateVideo('nope', { status: 'ready' })).toBeNull();
  });

  it('survives a corrupt file rather than refusing to start', async () => {
    const { listChannels } = await import('@/server/store/db');
    await fs.writeFile(path.join(dir, 'channels.json'), '{ this is not json');

    expect(await listChannels()).toEqual([]);
  });

  it('serialises concurrent writes so none are lost', async () => {
    const { putVideo, listVideos } = await import('@/server/store/db');

    const make = (n: number) => ({
      id: `vid_${String(n).padStart(3, '0')}`,
      channelId: 'ch_1',
      status: 'queued' as const,
      idea: null,
      title: `Video ${n}`,
      script: null,
      file: null,
      durationSeconds: null,
      error: null,
      scheduledFor: null,
      publishedAt: null,
      posts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await Promise.all(Array.from({ length: 20 }, (_, n) => putVideo(make(n))));

    expect(await listVideos()).toHaveLength(20);
  });
});

describe('queue', () => {
  it('claims a job once, then finds nothing', async () => {
    const { enqueue, claim } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1');

    expect((await claim())?.videoId).toBe('vid_1');
    expect(await claim()).toBeNull();
  });

  it('does not enqueue the same work twice', async () => {
    const { enqueue, listJobs } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1');
    await enqueue('produce', 'vid_1');

    expect(await listJobs()).toHaveLength(1);
  });

  it('treats produce and publish for one video as separate jobs', async () => {
    const { enqueue, listJobs } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1');
    await enqueue('publish', 'vid_1');

    expect(await listJobs()).toHaveLength(2);
  });

  it('leaves a future job alone until it is due', async () => {
    const { enqueue, claim } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1', Date.now() + 60_000);

    expect(await claim()).toBeNull();
    expect((await claim(Date.now() + 61_000))?.videoId).toBe('vid_1');
  });

  it('reclaims a job whose lease expired, so a crashed worker loses nothing', async () => {
    const { enqueue, claim } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1');
    await claim();

    // Just past the 30-minute lease.
    const later = Date.now() + 31 * 60_000;
    expect((await claim(later))?.videoId).toBe('vid_1');
  });

  it('retries with backoff, then gives up', async () => {
    const { enqueue, claim, fail, listJobs } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1');

    for (let attempt = 1; attempt <= 2; attempt++) {
      const job = await claim(Date.now() + attempt * 60 * 60_000);
      expect(job).not.toBeNull();
      expect((await fail(job!.id, 'boom')).willRetry).toBe(true);
    }

    const last = await claim(Date.now() + 3 * 60 * 60_000);
    expect((await fail(last!.id, 'boom')).willRetry).toBe(false);
    expect(await listJobs()).toHaveLength(0);
  });

  it('records the failure reason for the next attempt', async () => {
    const { enqueue, claim, fail, listJobs } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1');
    const job = await claim();
    await fail(job!.id, 'provider timed out');

    expect((await listJobs())[0]!.lastError).toBe('provider timed out');
  });

  it('completing removes the job', async () => {
    const { enqueue, claim, complete, listJobs } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1');
    const job = await claim();
    await complete(job!.id);

    expect(await listJobs()).toHaveLength(0);
  });

  it('cancels every job for a deleted video', async () => {
    const { enqueue, cancelFor, listJobs } = await import('@/server/jobs/queue');

    await enqueue('produce', 'vid_1');
    await enqueue('publish', 'vid_1');
    await enqueue('produce', 'vid_2');

    await cancelFor('vid_1');

    const remaining = await listJobs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.videoId).toBe('vid_2');
  });
});
