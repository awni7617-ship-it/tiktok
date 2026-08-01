import { NextResponse } from 'next/server';
import { z } from 'zod';
import { describeProviders, resetProviders } from '@/server/ai/registry';
import { renderCapability } from '@/server/video/capability';
import { describeSettings, saveSettings } from '@/server/settings/store';
import { libraryRoot } from '@/server/studio/library';
import { logger } from '@/server/obs/logger';

const log = logger.child({ route: 'settings' });

const bodySchema = z.object({
  // An empty string clears a key; omitting a field leaves it untouched.
  anthropicApiKey: z.string().max(300).optional(),
  openaiApiKey: z.string().max(300).optional(),
  elevenLabsApiKey: z.string().max(300).optional(),
  anthropicModel: z.string().max(100).optional(),
});

/** What is configured — never the keys themselves. */
export async function GET(): Promise<Response> {
  return NextResponse.json({
    keys: describeSettings(),
    providers: describeProviders(),
    rendering: await renderCapability(),
    storageDir: libraryRoot(),
  });
}

/**
 * Save credentials.
 *
 * Providers are rebuilt immediately, so a pasted key takes effect on the next
 * video rather than after a restart — which nobody would think to do.
 */
export async function POST(request: Request): Promise<Response> {
  let parsed;
  try {
    parsed = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError ? (error.issues[0]?.message ?? 'Invalid request') : 'Invalid JSON',
      },
      { status: 400 },
    );
  }

  saveSettings(parsed);
  resetProviders();
  log.info('credentials updated');

  return NextResponse.json({ keys: describeSettings(), providers: describeProviders() });
}
