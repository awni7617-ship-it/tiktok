import { assertProductionSecrets, config } from '@/server/config';
import { logger } from '@/server/obs/logger';
import { Worker } from './worker';

/**
 * Worker entrypoint (`npm run worker`).
 *
 * Kept separate from the Worker class so the class stays testable without a
 * process lifecycle attached to it.
 */

const log = logger.child({ module: 'worker-entry' });

async function main(): Promise<void> {
  assertProductionSecrets();

  const worker = new Worker({ concurrency: config.WORKER_CONCURRENCY });

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    void worker.stop().then(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crashed worker that keeps running is worse than one that restarts:
  // its jobs stay leased until the timeout, delaying everything behind them.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection; exiting', { reason });
    void worker.stop(10_000).then(() => process.exit(1));
  });

  await worker.start();
}

main().catch((error) => {
  log.error('worker failed to start', { error });
  process.exit(1);
});
