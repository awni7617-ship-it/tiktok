import { listChannels, listVideos } from '@/server/store/db';
import { handle } from '@/server/http';

export async function GET(request: Request) {
  return handle(async () => {
    const channelId = new URL(request.url).searchParams.get('channelId');
    const [videos, channels] = await Promise.all([listVideos(), listChannels()]);

    return {
      videos: channelId ? videos.filter((v) => v.channelId === channelId) : videos,
      // Sent alongside so the library can label each video with its channel
      // without a request per row.
      channels: channels.map((c) => ({ id: c.id, name: c.name })),
    };
  });
}
