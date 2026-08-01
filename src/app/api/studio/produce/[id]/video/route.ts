import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { getProduction } from '@/server/studio/jobs';

/**
 * Serve a finished video.
 *
 * Ranged, because a `<video>` element seeking in a 200 MB file over a
 * non-ranged response re-downloads the whole thing on every scrub.
 *
 * The path comes from the job record rather than the request, so no input
 * from the browser ever reaches the filesystem.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const job = getProduction(id);

  if (!job || job.status !== 'done' || !job.videoPath) {
    return NextResponse.json({ error: 'No finished video for that production' }, { status: 404 });
  }

  let size: number;
  try {
    size = (await stat(job.videoPath)).size;
  } catch {
    return NextResponse.json({ error: 'The video file is no longer available' }, { status: 410 });
  }

  const filename = `${(job.title ?? 'phantom-video').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.mp4`;
  const range = request.headers.get('range');

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Number(match[2]) : size - 1;

    if (Number.isNaN(start) || start >= size || end >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }

    const stream = Readable.toWeb(
      createReadStream(job.videoPath, { start, end }),
    ) as unknown as ReadableStream;

    return new NextResponse(stream, {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `inline; filename="${filename}"`,
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(job.videoPath)) as unknown as ReadableStream;

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="${filename}"`,
    },
  });
}
