import fs from 'node:fs/promises';
import { deleteVideo, getVideo } from '@/server/store/db';
import { videoDir } from '@/server/store/paths';
import { cancelFor } from '@/server/jobs/queue';
import { handle, notFound } from '@/server/http';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const video = await getVideo((await params).id);
    if (!video) throw notFound('No such video');
    return { video };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const video = await getVideo(id);
    if (!video) throw notFound('No such video');

    // Cancel first: a worker that claims the job after the record is gone
    // would do a whole render for a video nobody can see.
    await cancelFor(id);
    await deleteVideo(id);
    // The working directory holds the frames and audio too, not just the mp4.
    await fs.rm(videoDir(id), { recursive: true, force: true }).catch(() => undefined);

    return { ok: true };
  });
}
