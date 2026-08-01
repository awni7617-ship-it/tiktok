import { listChannels, listVideos, putVideo } from '../store/db';
import { nextSlots, queueDepth } from '../schedule/cadence';
import { nextIdea } from '../content/ideas';
import { enqueue } from './queue';
import { newId } from '@/lib/id';
import type { Channel, Video } from '@/lib/types';

/**
 * Keeping the pipeline full.
 *
 * The rule: an active channel should always have `queueDepth` videos with a
 * future scheduled time. Anything short of that gets topped up. Running this
 * repeatedly is safe — it only ever adds up to the shortfall, so a worker
 * ticking every thirty seconds does not produce a video every thirty seconds.
 *
 * Videos are queued ahead of their slot rather than at it, because rendering
 * takes minutes and a video that starts generating at its posting time is
 * already late.
 */

function scheduledAhead(videos: Video[], channelId: string, now: number): Video[] {
  return videos.filter(
    (video) =>
      video.channelId === channelId &&
      video.status !== 'failed' &&
      video.publishedAt === null &&
      video.scheduledFor !== null &&
      new Date(video.scheduledFor).getTime() > now,
  );
}

async function topUp(channel: Channel, videos: Video[], now: Date): Promise<Video[]> {
  const depth = queueDepth(channel.cadence);
  if (depth === 0) return [];

  const pending = scheduledAhead(videos, channel.id, now.getTime());
  const shortfall = depth - pending.length;
  if (shortfall <= 0) return [];

  // Slots already spoken for, so a top-up does not double-book a time.
  const taken = new Set(pending.map((v) => v.scheduledFor));
  const slots = nextSlots(channel.cadence, channel.postingHours, depth + pending.length, now)
    .map((slot) => slot.toISOString())
    .filter((slot) => !taken.has(slot))
    .slice(0, shortfall);

  const created: Video[] = [];
  const channelVideos = videos.filter((v) => v.channelId === channel.id);

  for (const [index, slot] of slots.entries()) {
    const now_ = new Date().toISOString();
    const video: Video = {
      id: newId('vid'),
      channelId: channel.id,
      status: 'queued',
      // Autopilot picks the angle; the script model picks the subject.
      idea: nextIdea(channel.nicheId, [...channelVideos, ...created]),
      title: 'Writing…',
      script: null,
      file: null,
      durationSeconds: null,
      error: null,
      scheduledFor: slot,
      publishedAt: null,
      posts: channel.platforms.map((platform) => ({
        platform,
        status: 'pending' as const,
        remoteId: null,
        url: null,
        error: null,
        postedAt: null,
      })),
      createdAt: now_,
      updatedAt: now_,
    };

    await putVideo(video);
    // Staggered so a top-up of four does not start four renders at once on a
    // machine with one CPU worth of ffmpeg.
    await enqueue('produce', video.id, Date.now() + index * 15_000);
    created.push(video);
  }

  return created;
}

/** Top up every active channel. Returns the videos it created. */
export async function runAutopilot(now: Date = new Date()): Promise<Video[]> {
  const [channels, videos] = await Promise.all([listChannels(), listVideos()]);
  const created: Video[] = [];

  for (const channel of channels) {
    if (!channel.active || channel.cadence === 'manual') continue;
    created.push(...(await topUp(channel, [...videos, ...created], now)));
  }

  return created;
}

/**
 * Queue publish jobs for anything rendered whose slot has arrived.
 *
 * Separate from producing, because a video can be ready hours before it is
 * due, and because a publish failure must not force a re-render.
 */
export async function publishDue(now: Date = new Date()): Promise<Video[]> {
  const videos = await listVideos();
  const due = videos.filter(
    (video) =>
      video.status === 'ready' &&
      video.publishedAt === null &&
      video.posts.length > 0 &&
      video.scheduledFor !== null &&
      new Date(video.scheduledFor).getTime() <= now.getTime(),
  );

  for (const video of due) {
    await enqueue('publish', video.id);
  }

  return due;
}
