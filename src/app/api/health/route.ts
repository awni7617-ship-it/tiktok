import { NextResponse } from 'next/server';
import { checkDatabase } from '@/server/db/client';
import { isFfmpegAvailable } from '@/server/video/ffmpeg';
import { describeProviders } from '@/server/ai/registry';
import { config } from '@/server/config';

export const dynamic = 'force-dynamic';

/**
 * Health and readiness.
 *
 * Reports each dependency separately rather than collapsing to one boolean:
 * the app is genuinely usable without ffmpeg (everything except rendering) and
 * without AI keys (mock providers), so a single "unhealthy" would be wrong.
 * Only the database is load-bearing enough to fail the check.
 */
export async function GET(): Promise<Response> {
  const started = Date.now();

  const [database, ffmpeg] = await Promise.all([checkDatabase(), isFfmpegAvailable()]);

  const body = {
    status: database ? 'ok' : 'degraded',
    uptimeSec: Math.round(process.uptime()),
    checkDurationMs: Date.now() - started,
    environment: config.NODE_ENV,
    dependencies: {
      database: database ? 'ok' : 'unreachable',
      ffmpeg: ffmpeg ? 'ok' : 'missing — rendering disabled',
      storage: config.STORAGE_DRIVER,
    },
    ai: describeProviders(),
  };

  return NextResponse.json(body, {
    status: database ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
