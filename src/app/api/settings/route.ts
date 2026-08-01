import { z } from 'zod';
import { getSettings, updateSettings } from '@/server/store/db';
import { providerNames } from '@/server/ai/registry';
import { configurablePlatforms, isExpired } from '@/server/publish';
import { hasFfmpeg } from '@/server/video/ffmpeg';
import { dataDir } from '@/server/store/paths';
import { body, handle } from '@/server/http';
import type { SettingsView } from '@/lib/types';

/**
 * Keys are write-only over the API: they go in, and only ever come back as a
 * boolean. Nothing that reaches the browser should be able to read them back
 * out, including this app's own settings screen.
 */
const input = z.object({
  anthropicApiKey: z.string().trim().nullable().optional(),
  openaiApiKey: z.string().trim().nullable().optional(),
  outputDir: z.string().trim().nullable().optional(),
});

async function view(): Promise<SettingsView> {
  const [settings, providers, ffmpeg] = await Promise.all([
    getSettings(),
    providerNames(),
    hasFfmpeg(),
  ]);

  return {
    anthropic: Boolean(settings.anthropicApiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim()),
    openai: Boolean(settings.openaiApiKey?.trim() || process.env.OPENAI_API_KEY?.trim()),
    outputDir: settings.outputDir ?? dataDir(),
    providers,
    accounts: settings.accounts.map((account) => ({
      platform: account.platform,
      displayName: account.displayName,
      expired: isExpired(account),
      connectedAt: account.connectedAt,
    })),
    configurable: configurablePlatforms(),
    ffmpeg,
  };
}

export async function GET() {
  return handle(view);
}

export async function PATCH(request: Request) {
  return handle(async () => {
    const patch = await body(request, input);
    // An empty string means "clear this key", which is different from the
    // field being absent, which means "leave it alone".
    const normalised = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, value === '' ? null : value]),
    );
    await updateSettings(normalised);
    return view();
  });
}
