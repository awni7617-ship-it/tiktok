import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '@/server/config';
import { logger } from '@/server/obs/logger';

const log = logger.child({ module: 'settings' });

/**
 * Runtime settings, editable from inside the app.
 *
 * API keys used to come only from environment variables, which is fine on a
 * server and useless in a desktop app: there is no shell to export them in.
 * That single gap is why every video was produced by the offline providers —
 * not because the real ones were missing, but because nobody could reach them.
 *
 * Read synchronously and cached: the provider registry is synchronous, and a
 * settings file of four keys is not worth restructuring it for.
 */

export interface StoredSettings {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  elevenLabsApiKey?: string;
  /** Overrides the default model when set. */
  anthropicModel?: string;
  /** OpenAI voice id for narration. */
  openaiVoice?: string;
}

let cache: StoredSettings | null = null;

function settingsPath(): string {
  const root =
    process.env['PHANTOM_OUTPUT_DIR'] || config.MEDIA_TMP_DIR || path.join(tmpdir(), 'phantom');
  return path.join(root, 'settings.json');
}

export function loadSettings(): StoredSettings {
  if (cache) return cache;

  try {
    const file = settingsPath();
    if (!existsSync(file)) {
      cache = {};
      return cache;
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    cache = parsed && typeof parsed === 'object' ? (parsed as StoredSettings) : {};
  } catch (error) {
    log.warn('could not read settings; continuing with defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
    cache = {};
  }

  return cache;
}

export function saveSettings(update: StoredSettings): StoredSettings {
  const current = loadSettings();

  // An empty string means "clear this key"; an absent field means "leave it
  // alone" — otherwise saving the form would wipe every key it did not show.
  const merged: StoredSettings = { ...current };
  for (const [key, value] of Object.entries(update) as [keyof StoredSettings, string | undefined][]) {
    if (value === undefined) continue;
    if (value === '') delete merged[key];
    else merged[key] = value.trim();
  }

  const file = settingsPath();
  mkdirSync(path.dirname(file), { recursive: true });

  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(merged, null, 2), 'utf8');
  try {
    // These are the user's paid API credentials; other accounts on the
    // machine have no business reading them.
    chmodSync(temporary, 0o600);
  } catch {
    // Windows and some filesystems do not support this. The file is still
    // inside the per-user data directory.
  }
  renameSync(temporary, file);

  cache = merged;
  log.info('settings updated', { keys: Object.keys(merged) });

  return merged;
}

/** Resolve a credential from settings first, then the environment. */
export function credential(name: keyof StoredSettings, fallback?: string): string | undefined {
  const stored = loadSettings()[name];
  return stored && stored.length > 0 ? stored : fallback;
}

/** Never send a key back to the browser — only whether one is set. */
export function describeSettings(): {
  anthropic: { configured: boolean; source: 'settings' | 'environment' | 'none'; model: string };
  openai: { configured: boolean; source: 'settings' | 'environment' | 'none' };
  elevenLabs: { configured: boolean; source: 'settings' | 'environment' | 'none' };
} {
  const stored = loadSettings();

  const source = (key: keyof StoredSettings, env?: string) =>
    stored[key] ? ('settings' as const) : env ? ('environment' as const) : ('none' as const);

  return {
    anthropic: {
      configured: Boolean(stored.anthropicApiKey || config.ANTHROPIC_API_KEY),
      source: source('anthropicApiKey', config.ANTHROPIC_API_KEY),
      model: stored.anthropicModel || config.ANTHROPIC_MODEL,
    },
    openai: {
      configured: Boolean(stored.openaiApiKey || config.OPENAI_API_KEY),
      source: source('openaiApiKey', config.OPENAI_API_KEY),
    },
    elevenLabs: {
      configured: Boolean(stored.elevenLabsApiKey || config.ELEVENLABS_API_KEY),
      source: source('elevenLabsApiKey', config.ELEVENLABS_API_KEY),
    },
  };
}

/** Drop the cache so the next read sees a file written by another process. */
export function resetSettingsCache(): void {
  cache = null;
}
