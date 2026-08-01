/**
 * Server startup hook.
 *
 * The desktop build runs the worker *inside* the Next.js server process rather
 * than as a second process. A packaged app cannot ask its user to open a
 * terminal and run `npm run worker`, and an app where nothing ever renders is
 * indistinguishable from a broken one.
 *
 * From source the worker stays a separate process, because a render that pegs
 * a core should not compete with the dev server's rebuilds.
 */

// Next re-runs `register` on every hot reload in development, and a second
// worker loop would claim jobs the first one already holds.
let started = false;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.AUTOREEL_EMBEDDED_WORKER !== '1') return;
  if (started) return;
  started = true;

  const { runWorker } = await import('./server/jobs/worker');

  // Deliberately not awaited: this loop runs for the life of the process, and
  // awaiting it would stall startup forever.
  void runWorker().catch((error: unknown) => {
    console.error('[worker] embedded worker stopped:', error);
  });
}
