import { getVideo, updateVideo } from '@/server/store/db';
import { getChannel } from '@/server/store/db';
import { enqueue } from '@/server/jobs/queue';
import { badRequest, handle, notFound } from '@/server/http';

/** Publish now, ignoring the schedule. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const video = await getVideo((await params).id);
    if (!video) throw notFound('No such video');
    if (video.status !== 'ready' && video.status !== 'published') {
      throw badRequest('This video is not rendered yet');
    }

    // A video made before the channel had platforms selected has no post
    // records; take the channel's current selection instead of doing nothing.
    let posts = video.posts;
    if (posts.length === 0) {
      const channel = await getChannel(video.channelId);
      if (!channel || channel.platforms.length === 0) {
        throw badRequest('No platforms are selected for this channel');
      }
      posts = channel.platforms.map((platform) => ({
        platform,
        status: 'pending' as const,
        remoteId: null,
        url: null,
        error: null,
        postedAt: null,
      }));
      await updateVideo(video.id, { posts });
    }

    await enqueue('publish', video.id);
    return { ok: true };
  });
}
