import { NextResponse } from 'next/server';
import { cancelProduction, getProduction } from '@/server/studio/jobs';

/** Poll a production's progress. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const job = getProduction(id);

  if (!job) {
    return NextResponse.json({ error: 'No such production' }, { status: 404 });
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    title: job.title,
    durationSec: job.durationSec,
    sceneCount: job.sceneCount,
    error: job.error,
    // Only offered once the file exists, so the player is never pointed at a
    // half-written mp4.
    videoUrl: job.status === 'done' ? `/api/studio/produce/${job.id}/video` : null,
  });
}

/** Stop a running production. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!getProduction(id)) {
    return NextResponse.json({ error: 'No such production' }, { status: 404 });
  }

  const cancelled = cancelProduction(id);
  return NextResponse.json({ cancelled });
}
