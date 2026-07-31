import { NextResponse } from 'next/server';
import { checkDatabase } from '@/server/db/client';
import { renderCapability } from '@/server/video/capability';
import { describeProviders } from '@/server/ai/registry';
import { isWorkers } from '@/server/cloudflare/env';
import { config } from '@/server/config';

export const dynamic = 'force-dynamic';

/**
 * Health and readiness.
 *
 * Reports each dependency separately rather than collapsing to one boolean:
 * the app is genuinely usable without rendering (everything except export) and
 * without AI keys (mock providers), so a single "unhealthy" would be wrong.
 * Only the database is load-bearing enough to fail the check.
 */
export async function GET(): Promise<Response> {
  const started = Date.now();

  const [database, render] = await Promise.all([checkDatabase(), renderCapability()]);

  const body = {
    status: database ? 'ok' : 'degraded',
    runtime: isWorkers() ? 'cloudflare-workers' : 'node',
    uptimeSec: isWorkers() ? null : Math.round(process.uptime()),
    checkDurationMs: Date.now() - started,
    environment: config.NODE_ENV,
    dependencies: {
      database: database ? 'ok' : 'unreachable',
      rendering: render.available ? `ok (${render.via})` : 'unavailable',
      renderingDetail: render.detail,
      storage: config.STORAGE_DRIVER,
    },
    ai: describeProviders(),
  };

  return NextResponse.json(body, {
    status: database ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
