import { JobStatus, Prisma, type Job } from '@prisma/client';
import { prisma } from '@/server/db/client';
import { newId } from '@/lib/id';
import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';

const log = logger.child({ module: 'queue' });

/**
 * Postgres-backed work queue.
 *
 * Rendering and publishing already require Postgres and are measured in
 * minutes, not milliseconds, so a dedicated broker would add an operational
 * dependency for no benefit. `FOR UPDATE SKIP LOCKED` gives safe concurrent
 * claiming; a lease timestamp lets a crashed worker's jobs be reclaimed rather
 * than stranded.
 */

export type JobType =
  | 'media.probe'
  | 'media.transcribe'
  | 'media.analyze'
  | 'media.proxy'
  | 'edit.plan'
  | 'edit.optimize'
  | 'content.generate'
  | 'content.narrate'
  | 'render.video'
  | 'render.thumbnail'
  | 'social.publish'
  | 'social.refresh-token'
  | 'analytics.sync'
  | 'analytics.insights'
  | 'maintenance.prune';

export interface EnqueueOptions {
  type: JobType;
  payload: Record<string, unknown>;
  workspaceId?: string;
  projectId?: string;
  /** Higher runs first among jobs that are due. */
  priority?: number;
  /** Delay before the job becomes eligible. */
  delayMs?: number;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueue(options: EnqueueOptions): Promise<Job> {
  const runAt = options.runAt ?? new Date(Date.now() + (options.delayMs ?? 0));

  const job = await prisma.job.create({
    data: {
      id: newId('job'),
      type: options.type,
      payload: options.payload as object,
      workspaceId: options.workspaceId ?? null,
      projectId: options.projectId ?? null,
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? config.JOB_MAX_ATTEMPTS,
      runAt,
    },
  });

  log.info('job enqueued', { jobId: job.id, type: job.type, runAt: runAt.toISOString() });
  return job;
}

/** Enqueue several jobs in one round trip. */
export async function enqueueMany(jobs: EnqueueOptions[]): Promise<number> {
  if (jobs.length === 0) return 0;

  const result = await prisma.job.createMany({
    data: jobs.map((options) => ({
      id: newId('job'),
      type: options.type,
      payload: options.payload as object,
      workspaceId: options.workspaceId ?? null,
      projectId: options.projectId ?? null,
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? config.JOB_MAX_ATTEMPTS,
      runAt: options.runAt ?? new Date(Date.now() + (options.delayMs ?? 0)),
    })),
  });

  return result.count;
}

/** Jobs whose lease is older than this are assumed abandoned and reclaimed. */
const LEASE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Atomically claim the next due job.
 *
 * The `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` pattern is a single
 * statement, so two workers polling simultaneously can never claim the same
 * row — the second skips it rather than blocking or double-processing.
 */
export async function claimJob(workerId: string, types?: JobType[]): Promise<Job | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_TIMEOUT_MS);

  const rows = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
    SET
      status = ${JobStatus.RUNNING}::"JobStatus",
      "lockedAt" = ${now},
      "lockedBy" = ${workerId},
      "startedAt" = COALESCE("startedAt", ${now}),
      attempts = attempts + 1,
      "updatedAt" = ${now}
    WHERE id = (
      SELECT j.id
      FROM "Job" j
      WHERE
        j."runAt" <= ${now}
        AND (
          j.status = ${JobStatus.PENDING}::"JobStatus"
          OR (j.status = ${JobStatus.RUNNING}::"JobStatus" AND j."lockedAt" < ${staleBefore})
        )
        ${typeFilter(types)}
      ORDER BY j.priority DESC, j."runAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `;

  return rows[0] ?? null;
}

/**
 * Optional `type IN (...)` fragment. Built with `Prisma.join` rather than
 * string interpolation so the values stay parameterised.
 */
function typeFilter(types?: JobType[]): Prisma.Sql {
  if (!types || types.length === 0) return Prisma.empty;
  return Prisma.sql`AND j.type IN (${Prisma.join(types)})`;
}

export async function completeJob(jobId: string, result?: Record<string, unknown>): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.COMPLETED,
      progress: 1,
      result: (result ?? {}) as object,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

/**
 * Record a failure. Retries use exponential backoff with jitter; once attempts
 * are exhausted the job is marked failed and left in place as a record rather
 * than deleted, so the UI can explain what happened.
 */
export async function failJob(jobId: string, error: unknown, retryable = true): Promise<void> {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;

  const message = error instanceof Error ? error.message : String(error);
  const canRetry = retryable && job.attempts < job.maxAttempts;

  if (!canRetry) {
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.FAILED,
        lastError: message.slice(0, 2000),
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
      },
    });
    log.error('job failed permanently', { jobId, type: job.type, attempts: job.attempts, error: message });
    return;
  }

  const backoffMs = Math.min(
    30 * 60 * 1000,
    2 ** job.attempts * 1000 * (0.75 + Math.random() * 0.5),
  );

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.PENDING,
      lastError: message.slice(0, 2000),
      runAt: new Date(Date.now() + backoffMs),
      lockedAt: null,
      lockedBy: null,
    },
  });

  log.warn('job failed; scheduled for retry', {
    jobId,
    type: job.type,
    attempt: job.attempts,
    retryInMs: Math.round(backoffMs),
    error: message,
  });
}

export async function updateProgress(jobId: string, progress: number): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: {
      progress: Math.max(0, Math.min(1, progress)),
      // Refresh the lease so a long render is not reclaimed mid-flight.
      lockedAt: new Date(),
    },
  });
}

export async function cancelJob(jobId: string): Promise<void> {
  await prisma.job.updateMany({
    where: { id: jobId, status: { in: [JobStatus.PENDING, JobStatus.RUNNING] } },
    data: { status: JobStatus.CANCELLED, completedAt: new Date(), lockedAt: null, lockedBy: null },
  });
}

export interface QueueStats {
  pending: number;
  running: number;
  failed: number;
  completedLastHour: number;
  oldestPendingAgeSec: number | null;
}

/** Queue health, surfaced on the admin dashboard and the metrics endpoint. */
export async function queueStats(): Promise<QueueStats> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [pending, running, failed, completedLastHour, oldest] = await Promise.all([
    prisma.job.count({ where: { status: JobStatus.PENDING } }),
    prisma.job.count({ where: { status: JobStatus.RUNNING } }),
    prisma.job.count({ where: { status: JobStatus.FAILED } }),
    prisma.job.count({ where: { status: JobStatus.COMPLETED, completedAt: { gte: hourAgo } } }),
    prisma.job.findFirst({
      where: { status: JobStatus.PENDING, runAt: { lte: new Date() } },
      orderBy: { runAt: 'asc' },
      select: { runAt: true },
    }),
  ]);

  return {
    pending,
    running,
    failed,
    completedLastHour,
    oldestPendingAgeSec: oldest
      ? Math.round((Date.now() - oldest.runAt.getTime()) / 1000)
      : null,
  };
}

/** Delete old terminal jobs so the table does not grow without bound. */
export async function pruneJobs(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await prisma.job.deleteMany({
    where: {
      status: { in: [JobStatus.COMPLETED, JobStatus.CANCELLED] },
      completedAt: { lt: cutoff },
    },
  });
  return result.count;
}
