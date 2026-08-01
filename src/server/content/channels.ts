import { z } from 'zod';
import { ART_STYLES, MUSIC_BEDS, NICHES, PLATFORMS, VOICES } from '@/lib/catalog';
import { newId } from '@/lib/id';
import { putVideo } from '../store/db';
import { enqueue } from '../jobs/queue';
import type { Channel, PlatformId, Video } from '@/lib/types';

/**
 * Channel creation and validation.
 *
 * Every enum is validated against the catalog rather than a duplicated list,
 * so adding a niche cannot leave the API rejecting it.
 */

const ids = <T extends { id: string }>(items: readonly T[]) =>
  items.map((item) => item.id) as [string, ...string[]];

/**
 * Platform ids validate against the catalog but must keep their narrow type —
 * `z.enum` over a widened `string[]` would infer `string`, and a partial
 * channel patch then no longer fits `Channel`.
 */
const platformId = z.enum(ids(PLATFORMS)).transform((value) => value as PlatformId);

export const channelInput = z.object({
  name: z.string().trim().min(1).max(60),
  nicheId: z.enum(ids(NICHES)),
  styleId: z.enum(ids(ART_STYLES)),
  voiceId: z.enum(ids(VOICES)),
  musicId: z.enum(ids(MUSIC_BEDS)).nullable().default(null),
  cadence: z.enum(['three-per-week', 'daily', 'twice-daily', 'manual']),
  postingHours: z.array(z.number().int().min(0).max(23)).min(1).max(2).default([9]),
  platforms: z.array(platformId).default([]),
  targetSeconds: z.number().int().min(15).max(180).default(45),
  active: z.boolean().default(true),
});

export type ChannelInput = z.infer<typeof channelInput>;

export function buildChannel(input: ChannelInput): Channel {
  const now = new Date().toISOString();
  return {
    id: newId('ch'),
    name: input.name,
    nicheId: input.nicheId,
    styleId: input.styleId,
    voiceId: input.voiceId,
    musicId: input.musicId,
    cadence: input.cadence,
    postingHours: input.postingHours,
    platforms: input.platforms,
    active: input.active,
    targetSeconds: input.targetSeconds,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Queue one video immediately, outside the cadence.
 *
 * `scheduledFor` is null rather than now: a manual video is not part of the
 * schedule, and giving it a slot would make autopilot count it against the
 * queue depth.
 */
export async function generateNow(channel: Channel, idea: string | null): Promise<Video> {
  const now = new Date().toISOString();
  const video: Video = {
    id: newId('vid'),
    channelId: channel.id,
    status: 'queued',
    idea,
    title: idea ?? 'Writing…',
    script: null,
    file: null,
    durationSeconds: null,
    error: null,
    scheduledFor: null,
    publishedAt: null,
    posts: channel.platforms.map((platform) => ({
      platform,
      status: 'pending' as const,
      remoteId: null,
      url: null,
      error: null,
      postedAt: null,
    })),
    createdAt: now,
    updatedAt: now,
  };

  await putVideo(video);
  await enqueue('produce', video.id);
  return video;
}
