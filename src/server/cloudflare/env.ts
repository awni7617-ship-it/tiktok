/**
 * Cloudflare binding access.
 *
 * The same codebase runs in three places: a Node server, a Cloudflare Worker,
 * and the render container. Bindings only exist in the Worker, so every
 * accessor here returns `null` elsewhere rather than throwing — that is what
 * lets the storage and database layers pick an implementation at runtime
 * instead of forcing two builds.
 */

// Type-only, so the containers SDK is never pulled into a runtime bundle that
// does not already need it.
import type { RenderContainer } from './render-container';

export interface CloudflareBindings {
  /** Media bucket. */
  MEDIA?: R2Bucket;
  /** Pooled Postgres connection, injected by Hyperdrive. */
  HYPERDRIVE?: { connectionString: string };
  /** Durable Object namespace fronting the ffmpeg render container. */
  RENDER_CONTAINER?: DurableObjectNamespace<RenderContainer>;
  /** Shared secret the Worker presents when waking the container. */
  CONTAINER_TOKEN?: string;
  [key: string]: unknown;
}

/** True when executing inside the Workers runtime. */
export function isWorkers(): boolean {
  // `navigator.userAgent` is the documented runtime marker; the WebSocketPair
  // check covers older runtime versions that do not set it.
  return (
    (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') ||
    typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair !== 'undefined'
  );
}

/**
 * Read the current request's bindings.
 *
 * Uses a dynamic import so the OpenNext helper is never pulled into the Node
 * or container bundles, where it does not resolve.
 */
export async function getBindings(): Promise<CloudflareBindings | null> {
  if (!isWorkers()) return null;

  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    return getCloudflareContext().env as unknown as CloudflareBindings;
  } catch {
    // Outside a request context (build-time prerender, for example) there is
    // no context to read; callers fall back to their non-binding path.
    return null;
  }
}

/** Hyperdrive connection string, or null when it is not bound. */
export async function hyperdriveUrl(): Promise<string | null> {
  const bindings = await getBindings();
  return bindings?.HYPERDRIVE?.connectionString ?? null;
}

/**
 * Whether a render container is bound.
 *
 * Lives here rather than in `render-client.ts` on purpose: answering this
 * question needs only the binding, while `render-client` imports the
 * containers SDK, which imports `cloudflare:workers`. That module exists only
 * in the Workers runtime, so any bundle reaching it fails to build. Keeping
 * the check separate lets the health endpoint ask "can we render?" without
 * dragging in a Workers-only dependency.
 */
export async function renderContainerConfigured(): Promise<boolean> {
  const bindings = await getBindings();
  return Boolean(bindings?.RENDER_CONTAINER);
}
