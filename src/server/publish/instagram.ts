import { composeCaption, describeError, PublishError } from './types';
import type { OAuthApp, PlatformAdapter, PublishRequest, PublishResult } from './types';
import type { SocialAccount } from '@/lib/types';

/**
 * Instagram Reels via the Graph API.
 *
 * The awkward part, stated plainly: Instagram will not accept an uploaded
 * file. It takes a **public URL** and fetches the video itself. A tool running
 * on your laptop has no such URL, so `PUBLIC_BASE_URL` must point at somewhere
 * this app is reachable from the internet — a tunnel, a small VPS, whatever —
 * or Instagram publishing cannot work at all. TikTok and YouTube take the
 * bytes directly and have no such requirement.
 *
 * Publishing is then two calls: create a media container, poll until Instagram
 * has finished ingesting it, then publish the container.
 */

const AUTH = 'https://www.facebook.com/v21.0/dialog/oauth';
const TOKEN = 'https://graph.facebook.com/v21.0/oauth/access_token';
const API = 'https://graph.facebook.com/v21.0';

/** How long to wait for Instagram to ingest the video before giving up. */
const INGEST_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5_000;

function publicUrlFor(file: string): string {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  if (!base) {
    throw new PublishError(
      'Instagram fetches the video over HTTP, so PUBLIC_BASE_URL must point at a publicly reachable address for this app',
    );
  }
  // `file` is the video id; the media route serves the mp4 unauthenticated
  // only while a publish is in flight.
  return `${base.replace(/\/+$/, '')}${file}`;
}

export const instagram: PlatformAdapter = {
  id: 'instagram',
  name: 'Instagram',
  scopes: [
    'instagram_basic',
    'instagram_content_publish',
    'pages_show_list',
    'pages_read_engagement',
    'business_management',
  ],

  authorizeUrl(app: OAuthApp, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      scope: this.scopes.join(','),
      response_type: 'code',
      state,
    });
    return `${AUTH}?${params.toString()}`;
  },

  async exchangeCode(app: OAuthApp, code: string, redirectUri: string): Promise<SocialAccount> {
    const params = new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: redirectUri,
      code,
    });

    const response = await fetch(`${TOKEN}?${params.toString()}`);
    if (!response.ok) {
      throw new PublishError(`Instagram rejected the token request: ${await describeError(response)}`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new PublishError('Instagram returned no access token');

    const account: SocialAccount = {
      platform: 'instagram',
      displayName: 'Instagram account',
      accessToken: body.access_token,
      refreshToken: null,
      expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : null,
      remoteUserId: null,
      connectedAt: new Date().toISOString(),
    };

    // Publishing targets an IG *business* account reached through a Facebook
    // Page, so the page has to be resolved before anything can be posted.
    const pages = await fetch(
      `${API}/me/accounts?fields=instagram_business_account{id,username}&access_token=${encodeURIComponent(body.access_token)}`,
    );
    if (pages.ok) {
      const pageBody = (await pages.json()) as {
        data?: { instagram_business_account?: { id?: string; username?: string } }[];
      };
      const linked = pageBody.data?.find((page) => page.instagram_business_account?.id);
      const ig = linked?.instagram_business_account;
      if (ig?.id) {
        account.remoteUserId = ig.id;
        if (ig.username) account.displayName = `@${ig.username}`;
      }
    }

    if (!account.remoteUserId) {
      throw new PublishError(
        'No Instagram business account is linked to that login. Reels can only be published to a business or creator account connected to a Facebook Page.',
      );
    }

    return account;
  },

  async refresh(_app: OAuthApp, _account: SocialAccount): Promise<SocialAccount> {
    // Long-lived page tokens are exchanged, not refreshed, and the exchange
    // needs the short-lived token which is long gone by now.
    throw new PublishError('Instagram tokens cannot be refreshed automatically — reconnect the account');
  },

  async publish(request: PublishRequest): Promise<PublishResult> {
    const igUserId = request.account.remoteUserId;
    if (!igUserId) throw new PublishError('This Instagram connection is missing its account id');

    const caption = composeCaption(request.caption || request.title, request.hashtags).slice(0, 2200);
    const videoUrl = publicUrlFor(request.file);

    const create = await fetch(`${API}/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        access_token: request.account.accessToken,
      }),
    });

    if (!create.ok) {
      throw new PublishError(
        `Instagram would not create the reel: ${await describeError(create)}`,
        create.status >= 500,
      );
    }

    const container = ((await create.json()) as { id?: string }).id;
    if (!container) throw new PublishError('Instagram returned no media container id');

    // Publishing before ingestion finishes fails, so poll until it is ready.
    const deadline = Date.now() + INGEST_TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) {
        throw new PublishError('Instagram did not finish processing the video in time', true);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const status = await fetch(
        `${API}/${container}?fields=status_code,status&access_token=${encodeURIComponent(request.account.accessToken)}`,
      );
      if (!status.ok) continue;

      const body = (await status.json()) as { status_code?: string; status?: string };
      if (body.status_code === 'FINISHED') break;
      if (body.status_code === 'ERROR') {
        throw new PublishError(`Instagram failed to process the video: ${body.status ?? 'unknown error'}`);
      }
    }

    const publish = await fetch(`${API}/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: container,
        access_token: request.account.accessToken,
      }),
    });

    if (!publish.ok) {
      throw new PublishError(
        `Instagram would not publish the reel: ${await describeError(publish)}`,
        publish.status >= 500,
      );
    }

    const id = ((await publish.json()) as { id?: string }).id;
    if (!id) throw new PublishError('Instagram returned no post id');

    return { remoteId: id, url: null };
  },
};
