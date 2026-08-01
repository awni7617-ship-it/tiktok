import fs from 'node:fs/promises';
import { composeCaption, describeError, PublishError } from './types';
import type { OAuthApp, PlatformAdapter, PublishRequest, PublishResult } from './types';
import type { SocialAccount } from '@/lib/types';

/**
 * YouTube Shorts via the Data API v3.
 *
 * There is no "Shorts" endpoint — a video is a Short because it is vertical
 * and under three minutes, which everything this app produces already is. It
 * is an ordinary video upload.
 *
 * Uploads are resumable: ask for a session URL, then PUT the bytes to it. The
 * whole file goes in one PUT here, which is fine at these sizes and avoids
 * carrying chunk-retry logic that would almost never run.
 *
 * Until the app passes Google's OAuth verification, uploads from an unverified
 * client are locked to `private`. That is Google's rule for the upload scope,
 * not a setting here.
 */

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API = 'https://www.googleapis.com/youtube/v3';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
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
      `Google rejected the token request: ${json.error_description ?? json.error ?? response.status}`,
    );
  }
  return json;
}

export const youtube: PlatformAdapter = {
  id: 'youtube',
  name: 'YouTube',
  scopes: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
  ],

  authorizeUrl(app: OAuthApp, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      // Without both of these Google returns no refresh token on repeat
      // authorisations, and the connection silently dies in an hour.
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `${AUTH}?${params.toString()}`;
  },

  async exchangeCode(app: OAuthApp, code: string, redirectUri: string): Promise<SocialAccount> {
    const token = await requestToken(
      new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    );

    if (!token.access_token) throw new PublishError('Google returned no access token');

    const account: SocialAccount = {
      platform: 'youtube',
      displayName: 'YouTube channel',
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
      remoteUserId: null,
      connectedAt: new Date().toISOString(),
    };

    try {
      const channels = await fetch(`${API}/channels?part=snippet&mine=true`, {
        headers: { Authorization: `Bearer ${account.accessToken}` },
      });
      if (channels.ok) {
        const body = (await channels.json()) as {
          items?: { id?: string; snippet?: { title?: string } }[];
        };
        const channel = body.items?.[0];
        if (channel?.id) account.remoteUserId = channel.id;
        if (channel?.snippet?.title) account.displayName = channel.snippet.title;
      }
    } catch {
      // Keep the default name.
    }

    return account;
  },

  async refresh(app: OAuthApp, account: SocialAccount): Promise<SocialAccount> {
    if (!account.refreshToken) {
      throw new PublishError('This YouTube connection has no refresh token — reconnect the account');
    }
    const token = await requestToken(
      new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token',
      }),
    );
    if (!token.access_token) throw new PublishError('Google returned no access token on refresh');

    return {
      ...account,
      accessToken: token.access_token,
      // A refresh response usually omits the refresh token; keeping the old
      // one is what makes the connection survive.
      refreshToken: token.refresh_token ?? account.refreshToken,
      expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : null,
    };
  },

  async publish(request: PublishRequest): Promise<PublishResult> {
    const video = await fs.readFile(request.file);

    const metadata = {
      snippet: {
        // YouTube hard-limits titles to 100 characters and rejects the whole
        // upload rather than truncating.
        title: request.title.slice(0, 100),
        description: composeCaption(request.caption, request.hashtags).slice(0, 5000),
        categoryId: '27', // Education
      },
      status: {
        privacyStatus: 'private',
        selfDeclaredMadeForKids: false,
      },
    };

    const start = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.account.accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(video.byteLength),
      },
      body: JSON.stringify(metadata),
    });

    if (!start.ok) {
      throw new PublishError(
        `YouTube would not start the upload: ${await describeError(start)}`,
        start.status >= 500,
      );
    }

    const sessionUrl = start.headers.get('location');
    if (!sessionUrl) throw new PublishError('YouTube returned no upload session URL');

    const upload = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(video.byteLength),
      },
      body: new Uint8Array(video),
    });

    if (!upload.ok) {
      throw new PublishError(
        `YouTube rejected the upload: ${await describeError(upload)}`,
        upload.status >= 500,
      );
    }

    const id = ((await upload.json()) as { id?: string }).id;
    if (!id) throw new PublishError('YouTube returned no video id');

    return { remoteId: id, url: `https://www.youtube.com/watch?v=${id}` };
  },
};
