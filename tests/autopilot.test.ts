import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelInput } from '@/server/content/channels';

/**
 * Autopilot, against a real temporary store.
 *
 * The property that matters is that running it repeatedly is safe: the worker
 * calls this every minute, and a top-up that queued work each time would
 * render a video a minute forever.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoreel-auto-'));
  process.env.AUTOREEL_DATA_DIR = dir;
});

afterEach(async () => {
  delete process.env.AUTOREEL_DATA_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

const base: ChannelInput = {
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
};

async function channel(over: Partial<ChannelInput> = {}) {
  const { buildChannel } = await import('@/server/content/channels');
  const { putChannel } = await import('@/server/store/db');
  return putChannel(buildChannel({ ...base, ...over }));
}

describe('runAutopilot', () => {
  it('fills a new channel up to its queue depth', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');
    const { queueDepth } = await import('@/server/schedule/cadence');

    await channel();
    const created = await runAutopilot();

    expect(created).toHaveLength(queueDepth('daily'));
    for (const video of created) {
      expect(video.status).toBe('queued');
      expect(video.scheduledFor).not.toBeNull();
    }
  });

  it('queues a produce job for everything it creates', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');
    const { listJobs } = await import('@/server/jobs/queue');

    await channel();
    const created = await runAutopilot();

    const jobs = await listJobs();
    expect(jobs).toHaveLength(created.length);
    expect(jobs.every((job) => job.kind === 'produce')).toBe(true);
  });

  it('is idempotent — a second pass adds nothing', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');
    const { listVideos } = await import('@/server/store/db');

    await channel();
    await runAutopilot();
    const after = (await listVideos()).length;

    expect(await runAutopilot()).toHaveLength(0);
    expect(await listVideos()).toHaveLength(after);
  });

  it('never books two videos into one slot', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');

    await channel({ cadence: 'twice-daily', postingHours: [9, 18] });
    const created = await runAutopilot();

    const slots = created.map((video) => video.scheduledFor);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('skips a paused channel', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');

    await channel({ active: false });
    expect(await runAutopilot()).toHaveLength(0);
  });

  it('skips a manual channel even when it is active', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');

    await channel({ cadence: 'manual' });
    expect(await runAutopilot()).toHaveLength(0);
  });

  it('gives each video a different angle rather than the same one', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');

    await channel({ cadence: 'twice-daily' });
    const created = await runAutopilot();
    const ideas = created.map((video) => video.idea);

    expect(new Set(ideas).size).toBe(ideas.length);
  });

  it('carries the channel platforms onto each video as pending posts', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');

    await channel({ platforms: ['tiktok', 'youtube'] });
    const created = await runAutopilot();

    expect(created[0]!.posts.map((p) => p.platform)).toEqual(['tiktok', 'youtube']);
    expect(created[0]!.posts.every((p) => p.status === 'pending')).toBe(true);
  });

  it('tops up again once a queued video is published', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');
    const { listVideos, updateVideo } = await import('@/server/store/db');

    await channel();
    await runAutopilot();

    // Publishing one drops the channel below its depth.
    const first = (await listVideos())[0]!;
    await updateVideo(first.id, { status: 'published', publishedAt: new Date().toISOString() });

    expect(await runAutopilot()).toHaveLength(1);
  });

  it('does not count a failed video toward the queue', async () => {
    const { runAutopilot } = await import('@/server/jobs/autopilot');
    const { listVideos, updateVideo } = await import('@/server/store/db');

    await channel();
    await runAutopilot();

    const first = (await listVideos())[0]!;
    await updateVideo(first.id, { status: 'failed', error: 'provider down' });

    expect(await runAutopilot()).toHaveLength(1);
  });
});

describe('publishDue', () => {
  it('queues nothing while a rendered video is still ahead of its slot', async () => {
    const { runAutopilot, publishDue } = await import('@/server/jobs/autopilot');
    const { listVideos, updateVideo } = await import('@/server/store/db');

    await channel({ platforms: ['tiktok'] });
    await runAutopilot();

    const video = (await listVideos())[0]!;
    await updateVideo(video.id, { status: 'ready', file: 'videos/x/final.mp4' });

    expect(await publishDue()).toHaveLength(0);
  });

  it('queues a rendered video once its slot has arrived', async () => {
    const { runAutopilot, publishDue } = await import('@/server/jobs/autopilot');
    const { listVideos, updateVideo } = await import('@/server/store/db');
    const { listJobs } = await import('@/server/jobs/queue');

    await channel({ platforms: ['tiktok'] });
    await runAutopilot();

    const video = (await listVideos())[0]!;
    await updateVideo(video.id, {
      status: 'ready',
      file: 'videos/x/final.mp4',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(await publishDue()).toHaveLength(1);
    expect((await listJobs()).some((job) => job.kind === 'publish')).toBe(true);
  });

  it('leaves a video with no platforms alone', async () => {
    const { runAutopilot, publishDue } = await import('@/server/jobs/autopilot');
    const { listVideos, updateVideo } = await import('@/server/store/db');

    await channel({ platforms: [] });
    await runAutopilot();

    const video = (await listVideos())[0]!;
    await updateVideo(video.id, {
      status: 'ready',
      file: 'videos/x/final.mp4',
      scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(await publishDue()).toHaveLength(0);
  });
});
