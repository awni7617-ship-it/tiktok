import { getVideo, updateVideo } from '../store/db';
import { resolveData } from '../store/paths';
import { produceVideo } from '../content/produce';
import { adapter, readyAccount } from '../publish';
import { PublishError } from '../publish/types';
import { enqueue } from './queue';
import type { Job, PostRecord, Video } from '@/lib/types';

/**
 * What a worker actually does with a claimed job.
 *
 * Handlers throw on failure and let the queue decide about retries. The one
 * thing they must never do is leave a video in a working status after
 * returning — a video stuck at "rendering" with no job behind it looks like a
 * hang and is unrecoverable from the UI.
 */

async function handleProduce(video: Video): Promise<void> {
  await produceVideo(video);

  // Queue publishing immediately when the slot has already passed, which is
  // the normal case for a video made on demand rather than by autopilot.
  const refreshed = await getVideo(video.id);
  if (!refreshed || refreshed.posts.length === 0) return;

  const due = refreshed.scheduledFor === null || new Date(refreshed.scheduledFor).getTime() <= Date.now();
  if (due) await enqueue('publish', video.id);
}

/**
 * Publish to every platform the video is targeting.
 *
 * One platform failing must not block the others, so each is attempted and
 * recorded independently. The job only fails — and therefore only retries —
 * if something is left in a state where retrying could help.
 */
async function handlePublish(video: Video): Promise<void> {
  if (!video.file) throw new Error('This video has no rendered file to publish');

  const file = resolveData(video.file);
  const script = video.script;
  await updateVideo(video.id, { status: 'publishing' });

  const posts: PostRecord[] = [];
  let retryable = false;

  for (const post of video.posts) {
    if (post.status === 'posted') {
      posts.push(post);
      continue;
    }

    try {
      const account = await readyAccount(post.platform);
      const result = await adapter(post.platform).publish({
        file: post.platform === 'instagram' ? `/api/videos/${video.id}/file` : file,
        title: video.title,
        caption: script?.caption ?? video.title,
        hashtags: script?.hashtags ?? [],
        account,
      });

      posts.push({
        platform: post.platform,
        status: 'posted',
        remoteId: result.remoteId,
        url: result.url,
        error: null,
        postedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PublishError && error.retryable) retryable = true;
      posts.push({ ...post, status: 'failed', error: message });
    }
  }

  const anyPosted = posts.some((p) => p.status === 'posted');
  const allDone = posts.every((p) => p.status === 'posted');

  await updateVideo(video.id, {
    posts,
    status: anyPosted ? 'published' : 'ready',
    publishedAt: anyPosted ? new Date().toISOString() : null,
    error: allDone ? null : posts.find((p) => p.error)?.error ?? null,
  });

  // Retry only when a retry could plausibly change the outcome. A missing
  // account or a rejected caption will fail identically forever.
  if (!allDone && retryable) {
    throw new Error(posts.find((p) => p.error)?.error ?? 'Publishing failed');
  }
}

export async function runJob(job: Job): Promise<void> {
  const video = await getVideo(job.videoId);
  if (!video) return; // Deleted while queued. Nothing to do, and not an error.

  if (job.kind === 'produce') return handleProduce(video);
  return handlePublish(video);
}

/** Called when a job has failed for the last time. */
export async function markFailed(videoId: string, error: string): Promise<void> {
  const video = await getVideo(videoId);
  if (!video) return;
  // A video that published to at least one platform is not "failed", even if
  // the job that touched it last was.
  if (video.status === 'published') {
    await updateVideo(videoId, { error });
    return;
  }
  await updateVideo(videoId, { status: 'failed', error });
}
