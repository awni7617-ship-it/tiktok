import { claim, complete, fail } from './queue';
import { runJob, markFailed } from './handlers';
import { publishDue, runAutopilot } from './autopilot';

/**
 * The worker loop.
 *
 * Runs in its own process (`npm run worker`) so a long ffmpeg render cannot
 * block the web server, and so more capacity is a second process rather than a
 * code change.
 */

const IDLE_DELAY_MS = 5_000;
/** Autopilot only needs checking occasionally; jobs are checked constantly. */
const AUTOPILOT_INTERVAL_MS = 60_000;

function log(message: string): void {
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

/**
 * One pass: top up the queue if due, then run at most one job.
 *
 * Returns whether it did any work, so the caller knows whether to sleep.
 * Exported for the tests, which drive it a tick at a time rather than
 * starting a loop.
 */
export async function tick(state: { lastAutopilot: number }): Promise<boolean> {
  const now = Date.now();

  if (now - state.lastAutopilot >= AUTOPILOT_INTERVAL_MS) {
    state.lastAutopilot = now;
    try {
      const created = await runAutopilot();
      if (created.length) log(`autopilot queued ${created.length} video(s)`);
      const due = await publishDue();
      if (due.length) log(`${due.length} video(s) due to publish`);
    } catch (error) {
      // Autopilot failing must not stop the queue from draining.
      log(`autopilot error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const job = await claim();
  if (!job) return false;

  log(`${job.kind} ${job.videoId} (attempt ${job.attempts})`);

  try {
    await runJob(job);
    await complete(job.id);
    log(`${job.kind} ${job.videoId} done`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { willRetry } = await fail(job.id, message);
    log(`${job.kind} ${job.videoId} failed: ${message}${willRetry ? ' (will retry)' : ''}`);
    if (!willRetry) await markFailed(job.videoId, message);
  }

  return true;
}

export async function runWorker(signal?: AbortSignal): Promise<void> {
  log('started');
  // Zero, so the first tick runs autopilot immediately rather than after a
  // minute of looking idle.
  const state = { lastAutopilot: 0 };

  while (!signal?.aborted) {
    let worked = false;
    try {
      worked = await tick(state);
    } catch (error) {
      // The loop itself must survive anything a handler throws.
      log(`tick error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!worked) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_DELAY_MS));
    }
  }

  log('stopped');
}
