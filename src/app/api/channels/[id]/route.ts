import { deleteChannel, getChannel, updateChannel } from '@/server/store/db';
import { channelInput } from '@/server/content/channels';
import { runAutopilot } from '@/server/jobs/autopilot';
import { body, handle, notFound } from '@/server/http';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  return handle(async () => {
    const channel = await getChannel((await params).id);
    if (!channel) throw notFound('No such channel');
    return { channel };
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return handle(async () => {
    const { id } = await params;
    const patch = await body(request, channelInput.partial());
    const channel = await updateChannel(id, patch);
    if (!channel) throw notFound('No such channel');

    if (channel.active && channel.cadence !== 'manual') {
      await runAutopilot().catch(() => undefined);
    }

    return { channel };
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return handle(async () => {
    // Videos are deliberately left behind: they are finished files the user
    // may still want, and deleting a channel should not delete their work.
    const removed = await deleteChannel((await params).id);
    if (!removed) throw notFound('No such channel');
    return { ok: true };
  });
}
