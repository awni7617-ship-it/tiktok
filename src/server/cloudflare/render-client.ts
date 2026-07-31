import { logger } from '@/server/obs/logger';
import { getBindings } from './env';

const log = logger.child({ module: 'render-client' });

/**
 * Client for the ffmpeg render container.
 *
 * A Worker cannot execute a binary, so anything that needs ffmpeg is handed to
 * a Cloudflare Container over HTTP. The Worker's role is only to *wake* the
 * container and let it drain the job queue — it never waits for a render to
 * finish, because a render takes minutes and a Worker invocation cannot.
 *
 * That is why this returns as soon as the container acknowledges: job state
 * lives in Postgres, so progress and completion are observed by polling the
 * job row, not by holding a request open.
 *
 * This module imports the containers SDK, which pulls in `cloudflare:workers`
 * — a module only the Workers runtime provides. It must therefore be reached
 * only from the Worker entrypoint, never from a Next.js route. The "is a
 * container bound?" check lives in `env.ts` for exactly that reason.
 */

export interface DrainResult {
  woken: boolean;
  detail: string;
}

/**
 * Ask the container to process pending jobs.
 *
 * `instanceKey` selects which container instance handles the request. A single
 * key means one instance drains the queue serially; sharding the key across N
 * values runs N instances in parallel, and the queue's `SKIP LOCKED` claiming
 * makes that safe without any further coordination.
 */
export async function wakeRenderContainer(instanceKey = 'render-0'): Promise<DrainResult> {
  const bindings = await getBindings();

  if (!bindings?.RENDER_CONTAINER) {
    return { woken: false, detail: 'No RENDER_CONTAINER binding on this deployment.' };
  }

  try {
    const { getContainer } = await import('@cloudflare/containers');
    const instance = getContainer(bindings.RENDER_CONTAINER, instanceKey);

    const response = await instance.fetch(
      new Request('https://render.internal/drain', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The container is only reachable through this binding, but an
          // explicit shared secret means a misrouted request cannot start work.
          ...(bindings.CONTAINER_TOKEN ? { Authorization: `Bearer ${bindings.CONTAINER_TOKEN}` } : {}),
        },
        body: JSON.stringify({ requestedAt: new Date().toISOString() }),
      }),
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => String(response.status));
      log.warn('render container rejected the wake request', { status: response.status, detail });
      return { woken: false, detail: `Container returned ${response.status}: ${detail.slice(0, 200)}` };
    }

    return { woken: true, detail: await response.text() };
  } catch (error) {
    log.error('could not reach the render container', { error });
    return {
      woken: false,
      detail: error instanceof Error ? error.message : 'Unknown container error',
    };
  }
}
