import { runWorker } from './worker';

/**
 * Standalone worker process.
 *
 * Kept separate from the loop so the loop stays importable by the tests and by
 * the dev server without either of them installing signal handlers.
 */

const controller = new AbortController();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[worker] ${signal} received, finishing current job`);
    controller.abort();
  });
}

runWorker(controller.signal)
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[worker] fatal:', error);
    process.exit(1);
  });
