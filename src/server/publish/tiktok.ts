import fs from 'node:fs/promises';
import { composeCaption, describeError, PublishError } from './types';
import type { OAuthApp, PlatformAdapter, PublishRequest, PublishResult } from './types';
import type { SocialAccount } from '@/lib/types';

/**
 * TikTok Content Posting API.
 *
 * Two things about this API are worth knowing before it fails on you:
 *
 * 1. Until your app passes TikTok's audit, posts land as **private drafts** in
 *    the creator's account regardless of what you send. That is TikTok's
 *    sandbox rule, not a bug here.
 * 2. Uploading is a three-step dance — init, PUT the bytes to the returned
 *    URL, then poll for status. The publish id comes back immediately but the
 *    post does not exist until processing finishes.
 */

const AUTH = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';
const API = 'https://open.tiktokapis.com/v2';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  open_id?: string;
  error?: string;
  error_description?: string;
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await response.json()) as TokenResponse;
  if (!response.ok || json.error) {
    throw new PublishError(
      `TikTok rejected the token request: ${json.error_description ?? json.error ?? response.status}`,
    );
  }
  return json;
}

function accountFrom(token: TokenResponse, previous?: SocialAccount): SocialAccount {
  if (!token.access_token) throw new PublishError('TikTok returned no access token');
  return {
    platform: 'tiktok',
    displayName: previous?.displayName ?? 'TikTok account',
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    remoteUserId: token.open_id ?? previous?.remoteUserId ?? null,
    connectedAt: previous?.connectedAt ?? new Date().toISOString(),
  };
}

export const tiktok: PlatformAdapter = {
  id: 'tiktok',
  name: 'TikTok',
  scopes: ['user.info.basic', 'video.publish', 'video.upload'],

  authorizeUrl(app: OAuthApp, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_key: app.clientId,
      scope: this.scopes.join(','),
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });
    return `${AUTH}?${params.toString()}`;
  },

  async exchangeCode(app: OAuthApp, code: string, redirectUri: string): Promise<SocialAccount> {
    const token = await requestToken(
      new URLSearchParams({
        client_key: app.clientId,
        client_secret: app.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    );

    const account = accountFrom(token);

    // Best effort: a display name makes the settings screen readable, but
    // failing to fetch one must not fail the connection.
    try {
      const profile = await fetch(`${API}/user/info/?fields=display_name`, {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      });
      if (profile.ok) {
        const body = (await profile.json()) as { data?: { user?: { display_name?: string } } };
        const name = body.data?.user?.display_name;
        if (name) account.displayName = name;
      }
    } catch {
      // Keep the default name.
    }

    return account;
  },

  async refresh(app: OAuthApp, account: SocialAccount): Promise<SocialAccount> {
    if (!account.refreshToken) throw new PublishError('This TikTok connection has no refresh token');
    const token = await requestToken(
      new URLSearchParams({
        client_key: app.clientId,
        client_secret: app.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: account.refreshToken,
      }),
    );
    return accountFrom(token, account);
  },

  async publish(request: PublishRequest): Promise<PublishResult> {
    const video = await fs.readFile(request.file);
    const title = composeCaption(request.caption || request.title, request.hashtags).slice(0, 2200);

    const init = await fetch(`${API}/post/publish/video/init/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.account.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        post_info: {
          title,
          privacy_level: 'SELF_ONLY',
          disable_comment: false,
          disable_duet: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: video.byteLength,
          // One chunk. TikTok requires chunking above 64MB; a vertical short
          // at CRF 20 does not get near that.
          chunk_size: video.byteLength,
          total_chunk_count: 1,
        },
      }),
    });

    if (!init.ok) {
      throw new PublishError(`TikTok upload could not start: ${await describeError(init)}`, init.status >= 500);
    }

    const initBody = (await init.json()) as {
      data?: { publish_id?: string; upload_url?: string };
    };
    const publishId = initBody.data?.publish_id;
    const uploadUrl = initBody.data?.upload_url;
    if (!publishId || !uploadUrl) {
      throw new PublishError('TikTok did not return an upload URL');
    }

    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(video.byteLength),
        'Content-Range': `bytes 0-${video.byteLength - 1}/${video.byteLength}`,
      },
      body: new Uint8Array(video),
    });

    if (!upload.ok) {
      throw new PublishError(`TikTok rejected the upload (HTTP ${upload.status})`, upload.status >= 500);
    }

    return { remoteId: publishId, url: null };
  },
};
