import { listChannels, putChannel } from '@/server/store/db';
import { buildChannel, channelInput } from '@/server/content/channels';
import { runAutopilot } from '@/server/jobs/autopilot';
import { body, handle } from '@/server/http';

export async function GET() {
  return handle(async () => ({ channels: await listChannels() }));
}

export async function POST(request: Request) {
  return handle(async () => {
    const input = await body(request, channelInput);
    const channel = await putChannel(buildChannel(input));

    // Fill the queue straight away rather than making the user wait up to a
    // minute for the worker's next autopilot pass to notice a new channel.
    if (channel.active && channel.cadence !== 'manual') {
      await runAutopilot().catch(() => undefined);
    }

    return { channel };
  });
}
