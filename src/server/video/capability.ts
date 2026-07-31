import { config } from '@/server/config';
import { isWorkers } from '@/server/cloudflare/env';

/**
 * Where rendering can happen, without importing the ffmpeg module.
 *
 * This indirection exists for one concrete reason: `video/ffmpeg.ts` imports
 * `node:child_process`, which does not exist in the Workers runtime. Any module
 * the Worker bundle reaches — the health endpoint, for instance — must not
 * import it, even transitively. Keeping the *capability question* separate from
 * the *implementation* is what allows a single codebase to serve both runtimes.
 */

export type RenderCapability =
  | { available: true; via: 'local'; detail: string }
  | { available: true; via: 'container'; detail: string }
  | { available: false; via: 'none'; detail: string };

export async function renderCapability(): Promise<RenderCapability> {
  if (config.RENDER_MODE === 'disabled') {
    return { available: false, via: 'none', detail: 'Rendering is disabled by configuration.' };
  }

  if (config.RENDER_MODE === 'container' || isWorkers()) {
    const { renderContainerConfigured } = await import('@/server/cloudflare/env');
    const configured = await renderContainerConfigured();

    return configured
      ? {
          available: true,
          via: 'container',
          detail: 'Rendering runs in the Cloudflare Container, which ships ffmpeg.',
        }
      : {
          available: false,
          via: 'none',
          detail:
            'No render container is bound. Add the RENDER_CONTAINER binding in wrangler.jsonc, or set RENDER_MODE=disabled.',
        };
  }

  // Local mode: probe for the binary. Imported dynamically so the module —
  // and its `node:child_process` dependency — never enters a Worker bundle.
  const { isFfmpegAvailable } = await import('./ffmpeg');
  const available = await isFfmpegAvailable();

  return available
    ? { available: true, via: 'local', detail: 'ffmpeg is installed and executable.' }
    : {
        available: false,
        via: 'none',
        detail: 'ffmpeg is not installed, so rendering is unavailable. Everything else works.',
      };
}
