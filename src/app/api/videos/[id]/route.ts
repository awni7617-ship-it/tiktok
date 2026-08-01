import { NextResponse } from 'next/server';
import { removeFromLibrary } from '@/server/studio/library';

/** Delete a video and its file. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const removed = await removeFromLibrary(id);

  if (!removed) return NextResponse.json({ error: 'No such video' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
