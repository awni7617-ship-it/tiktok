import { Container } from '@cloudflare/containers';

/**
 * Durable Object fronting the ffmpeg render container.
 *
 * Cloudflare exposes containers through a Durable Object, which gives each
 * instance a stable identity and lets the platform start it on demand and stop
 * it when idle. This class is intentionally thin — all it does is describe the
 * container's shape; the actual work happens in the image's own HTTP server
 * (`src/server/jobs/container-entry.ts`).
 */
export class RenderContainer extends Container {
  /** Port the container's HTTP server listens on. */
  override defaultPort = 8787;

  /**
   * Renders take minutes and arrive in bursts. A long idle window means a
   * creator publishing several clips in a row does not pay container cold-start
   * on each one; 15 minutes is long enough to cover a working session without
   * holding capacity all day.
   */
  override sleepAfter = '15m';

  /**
   * Environment for the container process. Bound secrets are forwarded rather
   * than baked into the image, so rotating a key is a `wrangler secret put`
   * and not a rebuild.
   */
  override envVars = {
    RENDER_MODE: 'local',
    LOG_FORMAT: 'json',
  };

  override onStart(): void {
    console.log('render container started');
  }

  override onStop(): void {
    console.log('render container stopped');
  }

  override onError(error: unknown): void {
    console.error('render container error', error);
  }
}
