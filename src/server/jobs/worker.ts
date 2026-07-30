import { hostname } from 'node:os';
import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';
import { checkDatabase } from '@/server/db/client';
import { newId } from '@/lib/id';
import { claimJob, completeJob, enqueue, failJob, updateProgress } from './queue';
import { getHandler } from './handlers';

const log = logger.child({ module: 'worker' });

/**
 * Background worker.
 *
 * Runs as a separate process from the web app so a long render cannot starve
 * request handling, and so render capacity scales independently of traffic.
 * Shutdown is graceful: on SIGTERM the worker stops claiming new work and
 * waits for in-flight jobs, so a deploy never kills a render mid-encode.
 */

export interface WorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  workerId?: string;
  /** Process only these job types; useful for dedicated render workers. */
  types?: Parameters<typeof claimJob>[1];
}

export class Worker {
  private readonly id: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly types: WorkerOptions['types'];

  private running = false;
  private draining = false;
  private active = new Map<string, AbortController>();
  private idleTicks = 0;

  constructor(options: WorkerOptions = {}) {
    this.id = options.workerId ?? `${hostname()}-${newId('wkr')}`;
    this.concurrency = options.concurrency ?? config.WORKER_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? config.WORKER_POLL_INTERVAL_MS;
    this.types = options.types;
  }

  async start(): Promise<void> {
    if (!(await checkDatabase())) {
      throw new Error('Cannot reach the database. Check DATABASE_URL and run migrations.');
    }

    this.running = true;
    log.info('worker started', {
      workerId: this.id,
      concurrency: this.concurrency,
      types: this.types ?? 'all',
    });

    // Recurring maintenance is self-scheduling rather than cron-driven, so a
    // single-container deployment needs no extra infrastructure.
    await this.scheduleRecurring();

    while (this.running) {
      if (this.active.size >= this.concurrency) {
        await sleep(50);
        continue;
      }

      const job = await claimJob(this.id, this.types).catch((error) => {
        log.error('failed to claim a job', { error });
        return null;
      });

      if (!job) {
        // Back off when idle so an empty queue does not spin the database.
        this.idleTicks = Math.min(this.idleTicks + 1, 10);
        await sleep(this.pollIntervalMs * (1 + this.idleTicks * 0.2));
        continue;
      }

      this.idleTicks = 0;
      void this.run(job.id, job.type, job.payload as Record<string, unknown>);
    }

    await this.drain();
  }

  private async run(jobId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    const controller = new AbortController();
    this.active.set(jobId, controller);

    const jobLog = log.child({ jobId, type });
    const started = Date.now();

    try {
      const handler = getHandler(type);
      if (!handler) throw new Error(`No handler registered for job type "${type}"`);

      jobLog.info('job started');

      // Progress writes are throttled: a render reports many times a second
      // and each write is a database round trip.
      let lastProgressWrite = 0;
      const progress = async (fraction: number) => {
        const now = Date.now();
        if (now - lastProgressWrite < 2000 && fraction < 1) return;
        lastProgressWrite = now;
        await updateProgress(jobId, fraction).catch(() => undefined);
      };

      const result = await handler({ jobId, payload, progress, signal: controller.signal });

      await completeJob(jobId, result);
      jobLog.info('job completed', { durationMs: Date.now() - started });
    } catch (error) {
      const retryable = !(error instanceof Error && /not (found|available)|missing|unknown/i.test(error.message));
      await failJob(jobId, error, retryable).catch((failError) => {
        jobLog.error('could not record job failure', { error: failError });
      });
    } finally {
      this.active.delete(jobId);
    }
  }

  /** Stop claiming work and wait for in-flight jobs to finish. */
  async stop(timeoutMs = 60_000): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.running = false;

    log.info('worker stopping', { workerId: this.id, inFlight: this.active.size });

    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await sleep(250);
    }

    if (this.active.size > 0) {
      log.warn('aborting jobs that did not finish in time', { count: this.active.size });
      for (const controller of this.active.values()) controller.abort();
      // Their leases expire, so another worker will pick them up.
      await sleep(1000);
    }

    log.info('worker stopped', { workerId: this.id });
  }

  private async drain(): Promise<void> {
    while (this.active.size > 0) await sleep(100);
  }

  /** Seed the periodic jobs if they are not already queued. */
  private async scheduleRecurring(): Promise<void> {
    const { prisma } = await import('@/server/db/client');

    const recurring: { type: Parameters<typeof enqueue>[0]['type']; delayMs: number }[] = [
      { type: 'maintenance.prune', delayMs: 60_000 },
      { type: 'analytics.sync', delayMs: 5 * 60_000 },
    ];

    for (const entry of recurring) {
      const existing = await prisma.job.count({
        where: { type: entry.type, status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (existing === 0) {
        await enqueue({ type: entry.type, payload: {}, delayMs: entry.delayMs, priority: -5 });
      }
    }
  }

  get status(): { workerId: string; running: boolean; active: number } {
    return { workerId: this.id, running: this.running, active: this.active.size };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
