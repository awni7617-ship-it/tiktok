import { instagram } from './instagram';
import { tiktok } from './tiktok';
import { youtube } from './youtube';
import { getSettings, updateSettings } from '../store/db';
import { PublishError } from './types';
import type { OAuthApp, PlatformAdapter } from './types';
import type { PlatformId, SocialAccount } from '@/lib/types';

/**
 * The platform registry, plus credential and token handling.
 *
 * Every adapter is fully implemented, but none of them can do anything until
 * you register an app with the platform and put its credentials in the
 * environment. That is unavoidable: all three require a reviewed app before
 * they will accept a post, and there is no credential this project could ship
 * that would change it.
 */

export const ADAPTERS: Record<PlatformId, PlatformAdapter> = {
  tiktok,
  instagram,
  youtube,
};

export function adapter(platform: PlatformId): PlatformAdapter {
  return ADAPTERS[platform];
}

const ENV_KEYS: Record<PlatformId, { id: string; secret: string }> = {
  tiktok: { id: 'TIKTOK_CLIENT_KEY', secret: 'TIKTOK_CLIENT_SECRET' },
  instagram: { id: 'INSTAGRAM_CLIENT_ID', secret: 'INSTAGRAM_CLIENT_SECRET' },
  youtube: { id: 'YOUTUBE_CLIENT_ID', secret: 'YOUTUBE_CLIENT_SECRET' },
};

/** The OAuth app credentials for a platform, or null when unconfigured. */
export function oauthApp(platform: PlatformId): OAuthApp | null {
  const keys = ENV_KEYS[platform];
  const clientId = process.env[keys.id]?.trim();
  const clientSecret = process.env[keys.secret]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Platforms whose credentials are present, so the UI can offer Connect. */
export function configurablePlatforms(): PlatformId[] {
  return (Object.keys(ENV_KEYS) as PlatformId[]).filter((p) => oauthApp(p) !== null);
}

export function requiredEnvFor(platform: PlatformId): { id: string; secret: string } {
  return ENV_KEYS[platform];
}

export function redirectUri(platform: PlatformId): string {
  const base = process.env.PUBLIC_BASE_URL?.trim() || 'http://localhost:3000';
  return `${base.replace(/\/+$/, '')}/api/social/${platform}/callback`;
}

export async function getAccount(platform: PlatformId): Promise<SocialAccount | null> {
  const settings = await getSettings();
  return settings.accounts.find((a) => a.platform === platform) ?? null;
}

export async function saveAccount(account: SocialAccount): Promise<void> {
  const settings = await getSettings();
  const accounts = settings.accounts.filter((a) => a.platform !== account.platform);
  accounts.push(account);
  await updateSettings({ accounts });
}

export async function removeAccount(platform: PlatformId): Promise<void> {
  const settings = await getSettings();
  await updateSettings({ accounts: settings.accounts.filter((a) => a.platform !== platform) });
}

/** Tokens are refreshed a minute early, so one does not expire mid-upload. */
const REFRESH_MARGIN_MS = 60_000;

export function isExpired(account: SocialAccount): boolean {
  return account.expiresAt !== null && account.expiresAt - REFRESH_MARGIN_MS <= Date.now();
}

/**
 * A usable access token for a platform, refreshing first if needed.
 *
 * Refresh failures are surfaced rather than swallowed: a silently dead
 * connection that reports success is how a channel goes a week without
 * posting and nobody notices.
 */
export async function readyAccount(platform: PlatformId): Promise<SocialAccount> {
  const account = await getAccount(platform);
  if (!account) throw new PublishError(`No ${platform} account is connected`);
  if (!isExpired(account)) return account;

  const app = oauthApp(platform);
  if (!app) {
    throw new PublishError(
      `The ${platform} token expired and cannot be refreshed — ${ENV_KEYS[platform].id} is not set`,
    );
  }

  const refreshed = await adapter(platform).refresh(app, account);
  await saveAccount(refreshed);
  return refreshed;
}

export { PublishError };
