import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { assertProductionSecrets, config } from '@/server/config';
import { logger } from '@/server/obs/logger';
import { checkDatabase } from '@/server/db/client';
import { queueStats } from './queue';
import { Worker } from './worker';

/**
 * Render container entrypoint.
 *
 * The same worker loop as `worker-entry.ts`, wrapped in a small HTTP server
 * because Cloudflare Containers are reached over HTTP and are started on
 * demand rather than run continuously.
 *
 * The important design point: `POST /drain` returns immediately after
 * *starting* the worker, it does not wait for jobs to finish. A render takes
 * minutes; the Worker that woke us cannot hold a request open that long, and
 * it does not need to — job state lives in Postgres, so the UI polls the job
 * row for progress.
 */

const log = logger.child({ module: 'container' });

let worker: Worker | null = null;
let startedAt: Date | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker({ concurrency: config.WORKER_CONCURRENCY });
  startedAt = new Date();

  // Fire and forget: `start()` only resolves when the worker stops.
  void worker.start().catch((error) => {
    log.error('worker loop exited', { error });
    worker = null;
  });

  return worker;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * Verify the shared secret.
 *
 * The container is only routable through its Durable Object binding, so this
 * is defence in depth rather than the primary control — but a render is
 * expensive enough that an unauthenticated trigger should not be possible even
 * if the network boundary were misconfigured.
 */
function authorized(request: IncomingMessage): boolean {
  const expected = process.env['CONTAINER_TOKEN'];
  if (!expected) return true;

  const header = request.headers.authorization ?? '';
  return header === `Bearer ${expected}`;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://container.internal');

  if (url.pathname === '/health') {
    void checkDatabase().then(async (database) =>
      send(response, database ? 200 : 503, {
        status: database ? 'ok' : 'degraded',
        worker: worker?.status ?? null,
        startedAt: startedAt?.toISOString() ?? null,
        queue: database ? await queueStats().catch(() => null) : null,
      }),
    );
    return;
  }

  if (url.pathname === '/drain' && request.method === 'POST') {
    if (!authorized(request)) {
      send(response, 401, { error: 'Unauthorized' });
      return;
    }

    const instance = ensureWorker();
    send(response, 202, {
      accepted: true,
      worker: instance.status,
      detail: 'Worker is draining the queue. Poll the job rows for progress.',
    });
    return;
  }

  send(response, 404, { error: 'Not found' });
});

async function main(): Promise<void> {
  assertProductionSecrets();

  if (!(await checkDatabase())) {
    log.error('cannot reach the database; check DATABASE_URL and Hyperdrive routing');
    process.exit(1);
  }

  const port = Number(process.env['PORT'] ?? 8787);
  server.listen(port, () => log.info('render container listening', { port }));

  // Start draining immediately rather than waiting for the first wake: the
  // container was started because there is work, so idling would be silly.
  ensureWorker();

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    server.close();
    void (worker?.stop() ?? Promise.resolve()).then(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  log.error('container failed to start', { error });
  process.exit(1);
});
