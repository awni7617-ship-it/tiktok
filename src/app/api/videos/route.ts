import { NextResponse } from 'next/server';
import { listLibrary } from '@/server/studio/library';

/**
 * Every video this installation has made.
 *
 * Paths stay on the server: the browser gets an id and a URL, never a
 * filesystem location.
 */
export async function GET(): Promise<Response> {
  const videos = await listLibrary();

  return NextResponse.json({
    videos: videos.map((video) => ({
      id: video.id,
      title: video.title,
      createdAt: video.createdAt,
      durationSec: video.durationSec,
      sceneCount: video.sceneCount,
      width: video.width,
      height: video.height,
      bytes: video.bytes,
      prompt: video.prompt,
      url: `/api/videos/${video.id}/file`,
    })),
  });
}
