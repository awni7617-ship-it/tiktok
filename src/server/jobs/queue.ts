import { read, withFile } from '../store/db';
import { newId } from '@/lib/id';
import type { Job } from '@/lib/types';

/**
 * A small durable job queue on top of the JSON store.
 *
 * Leasing rather than deleting-on-claim: a worker that crashes mid-render
 * leaves its lease to expire, and the job is picked up again rather than lost.
 * The lease is deliberately long because a render legitimately takes minutes.
 */

const LEASE_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

/** Exponential backoff, so a provider outage is not hammered. */
function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** (attempts - 1));
}

export async function enqueue(
  kind: Job['kind'],
  videoId: string,
  runAfter: number = Date.now(),
): Promise<Job> {
  return withFile('jobs', (jobs) => {
    // Idempotent: a double-click on Publish should not upload twice.
    const existing = jobs.find((j) => j.kind === kind && j.videoId === videoId);
    if (existing) return [jobs, existing];

    const job: Job = {
      id: newId('job'),
      kind,
      videoId,
      runAfter,
      attempts: 0,
      leasedUntil: null,
      lastError: null,
      createdAt: new Date().toISOString(),
    };
    return [[...jobs, job], job];
  });
}

/** Claim the next due job, or null when there is nothing to do. */
export async function claim(now: number = Date.now()): Promise<Job | null> {
  return withFile('jobs', (jobs) => {
    const index = jobs.findIndex(
      (job) => job.runAfter <= now && (job.leasedUntil === null || job.leasedUntil < now),
    );
    if (index === -1) return [jobs, null];

    const claimed: Job = {
      ...jobs[index]!,
      attempts: jobs[index]!.attempts + 1,
      leasedUntil: now + LEASE_MS,
    };
    const next = [...jobs];
    next[index] = claimed;
    return [next, claimed];
  });
}

export async function complete(jobId: string): Promise<void> {
  await withFile('jobs', (jobs) => [jobs.filter((j) => j.id !== jobId), undefined]);
}

/**
 * Record a failure.
 *
 * Returns whether the job will be retried, so the caller can decide what to
 * write onto the video — a transient failure that will retry should not put a
 * red "failed" badge on the library.
 */
export async function fail(jobId: string, error: string): Promise<{ willRetry: boolean }> {
  return withFile<'jobs', { willRetry: boolean }>('jobs', (jobs) => {
    const index = jobs.findIndex((j) => j.id === jobId);
    if (index === -1) return [jobs, { willRetry: false }];

    const job = jobs[index]!;
    if (job.attempts >= MAX_ATTEMPTS) {
      return [jobs.filter((j) => j.id !== jobId), { willRetry: false }];
    }

    const next = [...jobs];
    next[index] = {
      ...job,
      leasedUntil: null,
      runAfter: Date.now() + backoffMs(job.attempts),
      lastError: error,
    };
    return [next, { willRetry: true }];
  });
}

export async function listJobs(): Promise<Job[]> {
  return read('jobs');
}

export async function cancelFor(videoId: string): Promise<void> {
  await withFile('jobs', (jobs) => [jobs.filter((j) => j.videoId !== videoId), undefined]);
}
