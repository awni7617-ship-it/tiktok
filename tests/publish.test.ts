import { afterEach, describe, expect, it } from 'vitest';
import { adapter, ADAPTERS, configurablePlatforms, isExpired, oauthApp, redirectUri } from '@/server/publish';
import { composeCaption } from '@/server/publish/types';
import type { SocialAccount } from '@/lib/types';

const ENV_KEYS = [
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'INSTAGRAM_CLIENT_ID',
  'INSTAGRAM_CLIENT_SECRET',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'PUBLIC_BASE_URL',
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function account(over: Partial<SocialAccount> = {}): SocialAccount {
  return {
    platform: 'tiktok',
    displayName: 'Test',
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: null,
    remoteUserId: 'user',
    connectedAt: new Date().toISOString(),
    ...over,
  };
}

describe('composeCaption', () => {
  it('appends hashtags below the caption', () => {
    expect(composeCaption('A caption', ['one', 'two'])).toBe('A caption\n\n#one #two');
  });

  it('leaves a caption alone when there are no hashtags', () => {
    expect(composeCaption('A caption', [])).toBe('A caption');
  });

  it('does not double the hash on tags that already carry one', () => {
    expect(composeCaption('x', ['#one'])).toBe('x\n\n#one');
  });
});

describe('credentials', () => {
  it('reports nothing configurable when no credentials are set', () => {
    expect(configurablePlatforms()).toEqual([]);
    expect(oauthApp('tiktok')).toBeNull();
  });

  it('reports a platform configurable only when both halves are present', () => {
    process.env.TIKTOK_CLIENT_KEY = 'key';
    expect(configurablePlatforms()).toEqual([]);

    process.env.TIKTOK_CLIENT_SECRET = 'secret';
    expect(configurablePlatforms()).toEqual(['tiktok']);
  });

  it('builds the redirect URI from the public base URL', () => {
    process.env.PUBLIC_BASE_URL = 'https://example.com/';
    expect(redirectUri('youtube')).toBe('https://example.com/api/social/youtube/callback');
  });

  it('falls back to localhost when no base URL is set', () => {
    expect(redirectUri('tiktok')).toBe('http://localhost:3000/api/social/tiktok/callback');
  });
});

describe('token expiry', () => {
  it('treats a token with no expiry as usable', () => {
    expect(isExpired(account({ expiresAt: null }))).toBe(false);
  });

  it('treats a past expiry as expired', () => {
    expect(isExpired(account({ expiresAt: Date.now() - 1000 }))).toBe(true);
  });

  it('expires a token slightly early, so one cannot die mid-upload', () => {
    expect(isExpired(account({ expiresAt: Date.now() + 30_000 }))).toBe(true);
    expect(isExpired(account({ expiresAt: Date.now() + 10 * 60_000 }))).toBe(false);
  });
});

describe('authorize URLs', () => {
  const app = { clientId: 'client-123', clientSecret: 'secret' };

  it('sends the state parameter on every platform', () => {
    for (const id of Object.keys(ADAPTERS) as (keyof typeof ADAPTERS)[]) {
      const url = new URL(adapter(id).authorizeUrl(app, 'https://x.test/cb', 'state-abc'));
      expect(url.searchParams.get('state')).toBe('state-abc');
      expect(url.searchParams.get('redirect_uri')).toBe('https://x.test/cb');
    }
  });

  it('uses TikTok’s client_key rather than client_id', () => {
    const url = new URL(adapter('tiktok').authorizeUrl(app, 'https://x.test/cb', 's'));

    expect(url.searchParams.get('client_key')).toBe('client-123');
    expect(url.searchParams.get('client_id')).toBeNull();
    expect(url.searchParams.get('scope')).toContain('video.publish');
  });

  it('asks Google for offline access and forces consent', () => {
    // Without both, a repeat authorisation returns no refresh token and the
    // connection dies an hour later.
    const url = new URL(adapter('youtube').authorizeUrl(app, 'https://x.test/cb', 's'));

    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
  });

  it('asks Instagram for the publishing scope', () => {
    const url = new URL(adapter('instagram').authorizeUrl(app, 'https://x.test/cb', 's'));
    expect(url.searchParams.get('scope')).toContain('instagram_content_publish');
  });
});

describe('instagram publishing preconditions', () => {
  it('refuses to publish without a publicly reachable base URL', async () => {
    // Instagram fetches the file itself, so a laptop-only install cannot post
    // to it. Failing loudly here beats a confusing error from Meta.
    await expect(
      adapter('instagram').publish({
        file: '/api/videos/vid_1/file',
        title: 'T',
        caption: 'C',
        hashtags: [],
        account: account({ platform: 'instagram', remoteUserId: 'ig_1' }),
      }),
    ).rejects.toThrow(/PUBLIC_BASE_URL/);
  });

  it('refuses to publish when the connection has no account id', async () => {
    process.env.PUBLIC_BASE_URL = 'https://example.com';

    await expect(
      adapter('instagram').publish({
        file: '/api/videos/vid_1/file',
        title: 'T',
        caption: 'C',
        hashtags: [],
        account: account({ platform: 'instagram', remoteUserId: null }),
      }),
    ).rejects.toThrow(/account id/i);
  });
});
