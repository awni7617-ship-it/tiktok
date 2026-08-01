import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { getLibraryVideo } from '@/server/studio/library';

/**
 * Stream a saved video.
 *
 * Ranged, so scrubbing does not re-download the file. The path comes from the
 * library record, never from the request, so nothing the browser sends can
 * reach the filesystem.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const video = await getLibraryVideo(id);
  if (!video) return NextResponse.json({ error: 'No such video' }, { status: 404 });

  let size: number;
  try {
    size = (await stat(video.path)).size;
  } catch {
    return NextResponse.json({ error: 'The file is missing from disk' }, { status: 410 });
  }

  const filename = `${video.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'video'}.mp4`;
  const download = new URL(request.url).searchParams.has('download');
  const disposition = `${download ? 'attachment' : 'inline'}; filename="${filename}"`;
  const range = request.headers.get('range');

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Number(match[2]) : size - 1;

    if (Number.isNaN(start) || start >= size || end >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }

    return new NextResponse(
      Readable.toWeb(createReadStream(video.path, { start, end })) as unknown as ReadableStream,
      {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': disposition,
        },
      },
    );
  }

  return new NextResponse(
    Readable.toWeb(createReadStream(video.path)) as unknown as ReadableStream,
    {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Content-Disposition': disposition,
      },
    },
  );
}
