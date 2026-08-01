import { z } from 'zod';
import { getChannel } from '@/server/store/db';
import { generateNow } from '@/server/content/channels';
import { body, handle, notFound } from '@/server/http';

const input = z.object({
  idea: z.string().trim().min(1).max(300).nullable().default(null),
});

/** Make one video now, outside the channel's cadence. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const channel = await getChannel((await params).id);
    if (!channel) throw notFound('No such channel');

    const { idea } = await body(request, input);
    return { video: await generateNow(channel, idea) };
  });
}
