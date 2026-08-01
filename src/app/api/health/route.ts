import { listJobs } from '@/server/jobs/queue';
import { providerNames } from '@/server/ai/registry';
import { hasFfmpeg } from '@/server/video/ffmpeg';
import { dataDir } from '@/server/store/paths';
import { json } from '@/server/http';

/**
 * Each dependency is reported separately, because the app is genuinely usable
 * with pieces missing: without keys it runs the offline providers, and without
 * social credentials it still makes videos. Only a data directory it cannot
 * write to is actually fatal.
 */
export async function GET() {
  const [ffmpeg, providers] = await Promise.all([hasFfmpeg(), providerNames()]);

  let store = true;
  let queued = 0;
  try {
    queued = (await listJobs()).length;
  } catch {
    store = false;
  }

  return json(
    {
      status: store ? 'ok' : 'unhealthy',
      dataDir: dataDir(),
      store,
      ffmpeg,
      providers,
      queued,
    },
    store ? 200 : 503,
  );
}
