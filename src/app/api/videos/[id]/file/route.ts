import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import { getVideo } from '@/server/store/db';
import { resolveData } from '@/server/store/paths';
import { slug } from '@/lib/id';

/**
 * Serve the rendered mp4.
 *
 * Streamed rather than buffered, and range-aware, because `<video>` issues a
 * range request for the first bytes and a browser that gets a 200 with the
 * whole file back cannot seek.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const video = await getVideo((await params).id);
  if (!video?.file) {
    return new Response('Not found', { status: 404 });
  }

  let absolute: string;
  try {
    absolute = resolveData(video.file);
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) {
    return new Response('The rendered file is missing', { status: 404 });
  }

  const filename = `${slug(video.title)}.mp4`;
  const range = request.headers.get('range');

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `inline; filename="${filename}"`,
  };

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : info.size - 1;

      if (Number.isFinite(start) && start < info.size && end >= start) {
        const last = Math.min(end, info.size - 1);
        const stream = fs.createReadStream(absolute, { start, end: last });
        return new Response(stream as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...baseHeaders,
            'Content-Range': `bytes ${start}-${last}/${info.size}`,
            'Content-Length': String(last - start + 1),
          },
        });
      }
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${info.size}` },
      });
    }
  }

  const stream = fs.createReadStream(absolute);
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(info.size) },
  });
}
