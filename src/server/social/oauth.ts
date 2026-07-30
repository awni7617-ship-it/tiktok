import type { PlatformId } from '@/lib/types';
import { config } from '@/server/config';
import { prisma } from '@/server/db/client';
import { newId } from '@/lib/id';
import { createPkcePair, decryptSecret, encryptSecret, generateToken, safeEqual } from '@/server/security/crypto';
import { logger } from '@/server/obs/logger';
import { getPlatform, type PlatformDefinition } from './platforms';

const log = logger.child({ module: 'social:oauth' });

/**
 * OAuth 2.0 authorization-code flow with PKCE.
 *
 * Two invariants the rest of the system depends on:
 *   1. No account is ever connected without the user completing this flow.
 *      There is no path that writes a `SocialAccount` from anything but a
 *      successful callback the user initiated.
 *   2. Tokens are encrypted before they touch the database and are decrypted
 *      only inside the publishing worker, never in a response body.
 */

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly platform: string,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * Pending authorization state.
 *
 * Held in memory with a short TTL: it exists for the seconds between redirect
 * and callback, and losing it on a restart simply means the user retries. A
 * multi-instance deployment should back this with Redis — the interface is
 * async for exactly that reason.
 */
interface PendingAuth {
  platform: PlatformId;
  workspaceId: string;
  userId: string;
  codeVerifier: string | null;
  redirectUri: string;
  returnTo: string;
  expiresAt: number;
}

const pending = new Map<string, PendingAuth>();
const STATE_TTL_MS = 10 * 60 * 1000;

function sweepPending(): void {
  const now = Date.now();
  for (const [state, entry] of pending) {
    if (entry.expiresAt < now) pending.delete(state);
  }
}

export function credentialsFor(platform: PlatformDefinition): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = process.env[platform.oauth.clientIdEnv];
  const clientSecret = process.env[platform.oauth.clientSecretEnv];

  if (!clientId || !clientSecret) {
    throw new OAuthError(
      `${platform.name} is not configured on this deployment. Set ${platform.oauth.clientIdEnv} and ${platform.oauth.clientSecretEnv}.`,
      platform.id,
      false,
    );
  }

  return { clientId, clientSecret };
}

export function redirectUriFor(platformId: PlatformId): string {
  return `${config.APP_URL.replace(/\/$/, '')}/api/social/${platformId}/callback`;
}

/**
 * Begin the connect flow.
 *
 * The `state` parameter is a random token bound to the initiating user and
 * workspace; the callback refuses any state it did not issue, which is what
 * prevents an attacker from grafting their own account onto someone's
 * workspace via a forged callback.
 */
export async function beginAuthorization(options: {
  platformId: PlatformId;
  workspaceId: string;
  userId: string;
  returnTo?: string;
}): Promise<{ url: string; state: string }> {
  sweepPending();

  const platform = getPlatform(options.platformId);
  if (!platform) throw new OAuthError(`Unknown platform: ${options.platformId}`, options.platformId, false);

  const { clientId } = credentialsFor(platform);
  const redirectUri = redirectUriFor(options.platformId);
  const state = generateToken(24);

  const pkce = platform.oauth.usePkce ? createPkcePair() : null;

  pending.set(state, {
    platform: options.platformId,
    workspaceId: options.workspaceId,
    userId: options.userId,
    codeVerifier: pkce?.verifier ?? null,
    redirectUri,
    returnTo: options.returnTo ?? '/settings/accounts',
    expiresAt: Date.now() + STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: platform.oauth.scopes.join(platform.id === 'tiktok' ? ',' : ' '),
    state,
    ...(platform.oauth.extraAuthParams ?? {}),
  });

  if (pkce) {
    params.set('code_challenge', pkce.challenge);
    params.set('code_challenge_method', 'S256');
  }

  // TikTok names the parameter `client_key` rather than `client_id`.
  if (platform.id === 'tiktok') {
    params.delete('client_id');
    params.set('client_key', clientId);
  }

  log.info('authorization started', {
    platform: platform.id,
    workspaceId: options.workspaceId,
  });

  return { url: `${platform.oauth.authorizeUrl}?${params.toString()}`, state };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number | null;
  scopes: string[];
  /** Provider-specific extras, e.g. the TikTok `open_id`. */
  raw: Record<string, unknown>;
}

/** Look up and consume a pending state. Single-use by construction. */
export function consumeState(state: string): PendingAuth | null {
  sweepPending();

  for (const [key, entry] of pending) {
    // Constant-time compare so the state token cannot be discovered by timing.
    if (safeEqual(key, state)) {
      pending.delete(key);
      return entry.expiresAt >= Date.now() ? entry : null;
    }
  }

  return null;
}

/** Exchange the authorization code for tokens. */
export async function exchangeCode(
  platformId: PlatformId,
  code: string,
  auth: PendingAuth,
): Promise<TokenResponse> {
  const platform = getPlatform(platformId);
  if (!platform) throw new OAuthError(`Unknown platform: ${platformId}`, platformId, false);

  const { clientId, clientSecret } = credentialsFor(platform);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: auth.redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  if (auth.codeVerifier) body.set('code_verifier', auth.codeVerifier);
  if (platformId === 'tiktok') {
    body.delete('client_id');
    body.delete('client_secret');
    body.set('client_key', clientId);
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(platform.oauth.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    throw new OAuthError(
      `${platform.name} rejected the authorization code: ${
        (payload['error_description'] as string) ?? (payload['error'] as string) ?? response.status
      }`,
      platformId,
    );
  }

  return normalizeTokenResponse(payload, platform);
}

/** Refresh an expiring access token. */
export async function refreshAccessToken(
  platformId: PlatformId,
  refreshToken: string,
): Promise<TokenResponse> {
  const platform = getPlatform(platformId);
  if (!platform) throw new OAuthError(`Unknown platform: ${platformId}`, platformId, false);

  const { clientId, clientSecret } = credentialsFor(platform);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  if (platformId === 'tiktok') {
    body.delete('client_id');
    body.set('client_key', clientId);
  }

  const response = await fetch(platform.oauth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    // A rejected refresh token means the user must reconnect; not recoverable.
    throw new OAuthError(
      `${platform.name} refused to refresh the token. The user needs to reconnect.`,
      platformId,
      false,
    );
  }

  return normalizeTokenResponse(payload, platform);
}

/** Providers differ in field names and nesting; flatten to one shape. */
export function normalizeTokenResponse(
  payload: Record<string, unknown>,
  platform: PlatformDefinition,
): TokenResponse {
  // TikTok nests its payload under `data` on some endpoints.
  const source = (payload['data'] as Record<string, unknown> | undefined) ?? payload;

  const accessToken = source['access_token'] as string | undefined;
  if (!accessToken) {
    throw new OAuthError(`${platform.name} returned no access token`, platform.id);
  }

  const scopeRaw = (source['scope'] as string | undefined) ?? '';

  return {
    accessToken,
    refreshToken: (source['refresh_token'] as string | undefined) ?? null,
    expiresInSec:
      typeof source['expires_in'] === 'number'
        ? (source['expires_in'] as number)
        : Number.parseInt(String(source['expires_in'] ?? ''), 10) || null,
    scopes: scopeRaw ? scopeRaw.split(/[,\s]+/).filter(Boolean) : platform.oauth.scopes,
    raw: source,
  };
}

/**
 * Persist a connected account.
 *
 * Upserts on (workspace, platform, external id) so reconnecting an account
 * refreshes its tokens rather than creating a duplicate row.
 */
export async function saveConnection(options: {
  workspaceId: string;
  userId: string;
  platformId: PlatformId;
  tokens: TokenResponse;
  profile: { externalId: string; displayName: string; username?: string; avatarUrl?: string };
  metadata?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const expiresAt = options.tokens.expiresInSec
    ? new Date(Date.now() + options.tokens.expiresInSec * 1000)
    : null;

  const account = await prisma.socialAccount.upsert({
    where: {
      workspaceId_platform_externalId: {
        workspaceId: options.workspaceId,
        platform: options.platformId,
        externalId: options.profile.externalId,
      },
    },
    create: {
      id: newId('sac'),
      workspaceId: options.workspaceId,
      platform: options.platformId,
      externalId: options.profile.externalId,
      displayName: options.profile.displayName,
      username: options.profile.username ?? null,
      avatarUrl: options.profile.avatarUrl ?? null,
      accessToken: encryptSecret(options.tokens.accessToken),
      refreshToken: options.tokens.refreshToken ? encryptSecret(options.tokens.refreshToken) : null,
      tokenExpiresAt: expiresAt,
      scopes: options.tokens.scopes,
      metadata: (options.metadata ?? {}) as object,
      connectedById: options.userId,
    },
    update: {
      displayName: options.profile.displayName,
      username: options.profile.username ?? null,
      avatarUrl: options.profile.avatarUrl ?? null,
      accessToken: encryptSecret(options.tokens.accessToken),
      refreshToken: options.tokens.refreshToken ? encryptSecret(options.tokens.refreshToken) : null,
      tokenExpiresAt: expiresAt,
      scopes: options.tokens.scopes,
      metadata: (options.metadata ?? {}) as object,
      disconnectedAt: null,
      invalidAt: null,
    },
  });

  log.info('account connected', {
    platform: options.platformId,
    workspaceId: options.workspaceId,
    accountId: account.id,
  });

  return { id: account.id };
}

/**
 * Return a usable access token, refreshing it first if it is close to expiry.
 *
 * The 5-minute margin matters: a long upload started with a token expiring in
 * 30 seconds fails partway through, which is far worse than refreshing early.
 */
export async function getValidAccessToken(accountId: string): Promise<string> {
  const account = await prisma.socialAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new OAuthError('Account not found', 'unknown', false);
  if (account.disconnectedAt) throw new OAuthError('This account has been disconnected', account.platform, false);

  const marginMs = 5 * 60 * 1000;
  const needsRefresh =
    account.tokenExpiresAt !== null && account.tokenExpiresAt.getTime() - Date.now() < marginMs;

  if (!needsRefresh) return decryptSecret(account.accessToken);

  if (!account.refreshToken) {
    await markInvalid(accountId);
    throw new OAuthError(
      'The access token expired and there is no refresh token. Reconnect this account.',
      account.platform,
      false,
    );
  }

  try {
    const tokens = await refreshAccessToken(
      account.platform as PlatformId,
      decryptSecret(account.refreshToken),
    );

    await prisma.socialAccount.update({
      where: { id: accountId },
      data: {
        accessToken: encryptSecret(tokens.accessToken),
        refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : account.refreshToken,
        tokenExpiresAt: tokens.expiresInSec
          ? new Date(Date.now() + tokens.expiresInSec * 1000)
          : null,
        invalidAt: null,
      },
    });

    return tokens.accessToken;
  } catch (error) {
    await markInvalid(accountId);
    throw error;
  }
}

async function markInvalid(accountId: string): Promise<void> {
  await prisma.socialAccount.update({
    where: { id: accountId },
    data: { invalidAt: new Date() },
  });
}

/**
 * Disconnect an account.
 *
 * Tokens are overwritten rather than left in place: a disconnected account
 * must not retain a credential that could still be used.
 */
export async function disconnect(accountId: string): Promise<void> {
  await prisma.socialAccount.update({
    where: { id: accountId },
    data: {
      disconnectedAt: new Date(),
      accessToken: encryptSecret(''),
      refreshToken: null,
      tokenExpiresAt: null,
    },
  });

  log.info('account disconnected', { accountId });
}
