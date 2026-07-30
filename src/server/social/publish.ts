import type { PlatformId, PostMetrics } from '@/lib/types';
import { logger } from '@/server/obs/logger';
import { getPlatform } from './platforms';
import { getValidAccessToken, OAuthError } from './oauth';

const log = logger.child({ module: 'social:publish' });

/**
 * Platform publishing adapters.
 *
 * Each platform gets an adapter implementing the same three operations, so the
 * publish worker is platform-agnostic. Upload flows differ substantially
 * (TikTok pulls from a URL, YouTube uses resumable uploads, Meta uses a
 * container/publish two-step), which is exactly why they live behind one
 * interface rather than in the worker.
 *
 * Every adapter refuses to act without a token obtained through the OAuth flow
 * the user completed. There is no code path that publishes without one.
 */

export interface PublishRequest {
  accountId: string;
  /** Publicly reachable URL of the rendered video, valid for at least an hour. */
  videoUrl: string;
  /** Local path, for platforms that require a direct byte upload. */
  videoPath?: string;
  title?: string;
  caption: string;
  hashtags: string[];
  /** Platform-specific options from the composer. */
  options?: Record<string, unknown>;
  /** Publish immediately, or hand the platform a future timestamp. */
  scheduledFor?: Date | null;
  /** Save as a draft instead of publishing, where supported. */
  asDraft?: boolean;
}

export interface PublishResult {
  externalId: string;
  url: string | null;
  /** Platforms that transcode asynchronously report `processing`. */
  status: 'published' | 'processing' | 'draft' | 'scheduled';
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  publish(request: PublishRequest): Promise<PublishResult>;
  /** Poll a post that was still processing at publish time. */
  checkStatus(accountId: string, externalId: string): Promise<PublishResult>;
  fetchMetrics(accountId: string, externalId: string): Promise<PostMetrics | null>;
  fetchProfile(accessToken: string): Promise<{
    externalId: string;
    displayName: string;
    username?: string;
    avatarUrl?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export class PublishError extends Error {
  constructor(
    message: string,
    readonly platform: PlatformId,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

/** Compose the final caption, appending hashtags within the platform's budget. */
export function composeCaption(
  platformId: PlatformId,
  caption: string,
  hashtags: string[],
): string {
  const caps = getPlatform(platformId)!.capabilities;
  const tags = hashtags.slice(0, caps.maxHashtags);
  if (tags.length === 0) return caption.slice(0, caps.maxDescriptionChars);

  const suffix = `\n\n${tags.join(' ')}`;
  const room = caps.maxDescriptionChars - suffix.length;

  // Truncating the caption is better than dropping the hashtags, which carry
  // the topical signal the ranker uses.
  return room > 0 ? `${caption.slice(0, room).trimEnd()}${suffix}` : caption.slice(0, caps.maxDescriptionChars);
}

async function apiFetch(
  platform: PlatformId,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const text = await response.text();

  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    payload = { raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    // 429 and 5xx are transient; 4xx generally means the request is wrong and
    // retrying it will fail identically.
    const retryable = response.status === 429 || response.status >= 500;
    throw new PublishError(
      `${platform} API ${response.status}: ${JSON.stringify(payload).slice(0, 400)}`,
      platform,
      retryable,
    );
  }

  return payload;
}

// ---------------------------------------------------------------------------
// TikTok
// ---------------------------------------------------------------------------

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok' as const;

  /**
   * TikTok's Content Posting API pulls the file from a URL we provide, so the
   * render must be reachable by their servers. The domain has to be verified
   * in the developer portal — a common first-run failure worth surfacing
   * clearly rather than as a raw API error.
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = await getValidAccessToken(request.accountId);
    const endpoint = request.asDraft
      ? 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/'
      : 'https://open.tiktokapis.com/v2/post/publish/video/init/';

    const body: Record<string, unknown> = {
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: request.videoUrl,
      },
    };

    if (!request.asDraft) {
      body['post_info'] = {
        title: composeCaption('tiktok', request.caption, request.hashtags),
        privacy_level: (request.options?.['privacyLevel'] as string) ?? 'SELF_ONLY',
        disable_comment: request.options?.['disableComment'] === true,
        disable_duet: request.options?.['disableDuet'] === true,
        disable_stitch: request.options?.['disableStitch'] === true,
      };
    }

    const payload = await apiFetch(this.platform, endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body),
    });

    const data = payload['data'] as Record<string, unknown> | undefined;
    const publishId = data?.['publish_id'] as string | undefined;
    if (!publishId) throw new PublishError('TikTok returned no publish id', this.platform, true);

    return { externalId: publishId, url: null, status: request.asDraft ? 'draft' : 'processing' };
  }

  async checkStatus(accountId: string, externalId: string): Promise<PublishResult> {
    const token = await getValidAccessToken(accountId);

    const payload = await apiFetch(
      this.platform,
      'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ publish_id: externalId }),
      },
    );

    const data = (payload['data'] as Record<string, unknown>) ?? {};
    const status = data['status'] as string | undefined;
    const publiclyIds = data['publicaly_available_post_id'] as string[] | undefined;

    if (status === 'PUBLISH_COMPLETE') {
      const postId = publiclyIds?.[0];
      return {
        externalId: postId ?? externalId,
        url: postId ? `https://www.tiktok.com/video/${postId}` : null,
        status: 'published',
      };
    }
    if (status === 'FAILED') {
      throw new PublishError(
        `TikTok processing failed: ${String(data['fail_reason'] ?? 'unknown')}`,
        this.platform,
        false,
      );
    }

    return { externalId, url: null, status: 'processing' };
  }

  async fetchMetrics(accountId: string, externalId: string): Promise<PostMetrics | null> {
    const token = await getValidAccessToken(accountId);

    const payload = await apiFetch(
      this.platform,
      'https://open.tiktokapis.com/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filters: { video_ids: [externalId] } }),
      },
    );

    const videos = (payload['data'] as Record<string, unknown> | undefined)?.['videos'] as
      | Record<string, number>[]
      | undefined;
    const video = videos?.[0];
    if (!video) return null;

    return emptyMetrics({
      views: video['view_count'] ?? 0,
      likes: video['like_count'] ?? 0,
      comments: video['comment_count'] ?? 0,
      shares: video['share_count'] ?? 0,
    });
  }

  async fetchProfile(accessToken: string) {
    const payload = await apiFetch(
      this.platform,
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username,follower_count',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    const user = ((payload['data'] as Record<string, unknown>)?.['user'] ?? {}) as Record<string, unknown>;

    return {
      externalId: String(user['open_id'] ?? ''),
      displayName: String(user['display_name'] ?? 'TikTok account'),
      username: user['username'] ? String(user['username']) : undefined,
      avatarUrl: user['avatar_url'] ? String(user['avatar_url']) : undefined,
      metadata: { followerCount: user['follower_count'] ?? null },
    };
  }
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube' as const;

  /**
   * Resumable upload: initiate with metadata, then stream the bytes to the
   * returned session URL. Resumable is the right choice even for short videos
   * because it survives a dropped connection mid-upload.
   */
  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = await getValidAccessToken(request.accountId);
    const caption = composeCaption('youtube', request.caption, request.hashtags);

    const metadata = {
      snippet: {
        title: (request.title ?? request.caption).slice(0, 100) || 'Untitled',
        description: caption,
        categoryId: (request.options?.['categoryId'] as string) ?? '22',
      },
      status: {
        privacyStatus: request.scheduledFor
          ? 'private'
          : ((request.options?.['privacyStatus'] as string) ?? 'private'),
        selfDeclaredMadeForKids: request.options?.['madeForKids'] === true,
        ...(request.scheduledFor ? { publishAt: request.scheduledFor.toISOString() } : {}),
      },
    };

    const initResponse = await fetch(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/*',
        },
        body: JSON.stringify(metadata),
      },
    );

    if (!initResponse.ok) {
      const detail = await initResponse.text();
      throw new PublishError(
        `YouTube upload init failed (${initResponse.status}): ${detail.slice(0, 300)}`,
        this.platform,
        initResponse.status >= 500 || initResponse.status === 429,
      );
    }

    const uploadUrl = initResponse.headers.get('location');
    if (!uploadUrl) throw new PublishError('YouTube returned no upload URL', this.platform, true);

    const media = await fetch(request.videoUrl);
    if (!media.ok || !media.body) {
      throw new PublishError('Could not read the rendered video', this.platform, true);
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/*' },
      body: media.body,
      // Required by fetch when streaming a request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text();
      throw new PublishError(
        `YouTube upload failed (${uploadResponse.status}): ${detail.slice(0, 300)}`,
        this.platform,
        uploadResponse.status >= 500,
      );
    }

    const result = (await uploadResponse.json()) as { id?: string };
    if (!result.id) throw new PublishError('YouTube returned no video id', this.platform, true);

    return {
      externalId: result.id,
      url: `https://www.youtube.com/watch?v=${result.id}`,
      status: request.scheduledFor ? 'scheduled' : 'published',
    };
  }

  async checkStatus(accountId: string, externalId: string): Promise<PublishResult> {
    const token = await getValidAccessToken(accountId);
    const payload = await apiFetch(
      this.platform,
      `https://www.googleapis.com/youtube/v3/videos?part=status&id=${externalId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const items = payload['items'] as { status?: { uploadStatus?: string } }[] | undefined;
    const uploadStatus = items?.[0]?.status?.uploadStatus;

    return {
      externalId,
      url: `https://www.youtube.com/watch?v=${externalId}`,
      status: uploadStatus === 'processed' ? 'published' : 'processing',
    };
  }

  async fetchMetrics(accountId: string, externalId: string): Promise<PostMetrics | null> {
    const token = await getValidAccessToken(accountId);
    const payload = await apiFetch(
      this.platform,
      `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${externalId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const items = payload['items'] as { statistics?: Record<string, string> }[] | undefined;
    const stats = items?.[0]?.statistics;
    if (!stats) return null;

    return emptyMetrics({
      views: Number(stats['viewCount'] ?? 0),
      likes: Number(stats['likeCount'] ?? 0),
      comments: Number(stats['commentCount'] ?? 0),
    });
  }

  async fetchProfile(accessToken: string) {
    const payload = await apiFetch(
      this.platform,
      'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    const items = payload['items'] as
      | { id: string; snippet?: Record<string, unknown>; statistics?: Record<string, string> }[]
      | undefined;
    const channel = items?.[0];
    if (!channel) throw new PublishError('No YouTube channel on this account', this.platform, false);

    const snippet = channel.snippet ?? {};
    const thumbnails = snippet['thumbnails'] as Record<string, { url?: string }> | undefined;

    return {
      externalId: channel.id,
      displayName: String(snippet['title'] ?? 'YouTube channel'),
      username: snippet['customUrl'] ? String(snippet['customUrl']) : undefined,
      avatarUrl: thumbnails?.['default']?.url,
      metadata: { subscriberCount: channel.statistics?.['subscriberCount'] ?? null },
    };
  }
}

// ---------------------------------------------------------------------------
// Meta (Instagram & Facebook)
// ---------------------------------------------------------------------------

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Instagram publishes in two steps: create a media container pointing at the
 * video URL, poll until it finishes processing, then publish the container.
 * The poll is required — publishing an unfinished container simply fails.
 */
export class InstagramAdapter implements PlatformAdapter {
  readonly platform = 'instagram' as const;

  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = await getValidAccessToken(request.accountId);
    const igUserId = request.options?.['igUserId'] as string | undefined;
    if (!igUserId) {
      throw new PublishError(
        'No Instagram professional account selected for this connection',
        this.platform,
        false,
      );
    }

    const container = await apiFetch(this.platform, `${GRAPH}/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_type: 'REELS',
        video_url: request.videoUrl,
        caption: composeCaption('instagram', request.caption, request.hashtags),
        share_to_feed: request.options?.['shareToFeed'] !== false,
        access_token: token,
      }),
    });

    const containerId = container['id'] as string | undefined;
    if (!containerId) throw new PublishError('Instagram returned no container id', this.platform, true);

    await this.waitForContainer(containerId, token);

    const published = await apiFetch(this.platform, `${GRAPH}/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: containerId, access_token: token }),
    });

    const mediaId = published['id'] as string | undefined;
    if (!mediaId) throw new PublishError('Instagram returned no media id', this.platform, true);

    return { externalId: mediaId, url: `https://www.instagram.com/reel/${mediaId}`, status: 'published' };
  }

  /** Poll the container until it is ready, with a hard ceiling. */
  private async waitForContainer(containerId: string, token: string): Promise<void> {
    const deadline = Date.now() + 5 * 60 * 1000;

    while (Date.now() < deadline) {
      const status = await apiFetch(
        this.platform,
        `${GRAPH}/${containerId}?fields=status_code,status&access_token=${token}`,
        {},
      );

      const code = status['status_code'] as string | undefined;
      if (code === 'FINISHED') return;
      if (code === 'ERROR') {
        throw new PublishError(
          `Instagram could not process the video: ${String(status['status'] ?? '')}`,
          this.platform,
          false,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new PublishError('Instagram processing timed out', this.platform, true);
  }

  async checkStatus(accountId: string, externalId: string): Promise<PublishResult> {
    return { externalId, url: `https://www.instagram.com/reel/${externalId}`, status: 'published' };
  }

  async fetchMetrics(accountId: string, externalId: string): Promise<PostMetrics | null> {
    const token = await getValidAccessToken(accountId);
    const payload = await apiFetch(
      this.platform,
      `${GRAPH}/${externalId}/insights?metric=plays,likes,comments,shares,saved,total_interactions&access_token=${token}`,
      {},
    );

    const data = payload['data'] as { name: string; values: { value: number }[] }[] | undefined;
    if (!data) return null;

    const value = (name: string) => data.find((m) => m.name === name)?.values[0]?.value ?? 0;

    return emptyMetrics({
      views: value('plays'),
      likes: value('likes'),
      comments: value('comments'),
      shares: value('shares'),
      saves: value('saved'),
    });
  }

  async fetchProfile(accessToken: string) {
    const pages = await apiFetch(
      this.platform,
      `${GRAPH}/me/accounts?fields=id,name,instagram_business_account{id,username,profile_picture_url,followers_count}&access_token=${accessToken}`,
      {},
    );

    const list = pages['data'] as
      | { id: string; name: string; instagram_business_account?: Record<string, unknown> }[]
      | undefined;
    const withIg = list?.find((page) => page.instagram_business_account);

    if (!withIg?.instagram_business_account) {
      throw new PublishError(
        'No Instagram professional account is linked to this Facebook account',
        this.platform,
        false,
      );
    }

    const ig = withIg.instagram_business_account;

    return {
      externalId: String(ig['id']),
      displayName: String(ig['username'] ?? withIg.name),
      username: ig['username'] ? String(ig['username']) : undefined,
      avatarUrl: ig['profile_picture_url'] ? String(ig['profile_picture_url']) : undefined,
      metadata: { igUserId: ig['id'], pageId: withIg.id, followers: ig['followers_count'] ?? null },
    };
  }
}

export class FacebookAdapter implements PlatformAdapter {
  readonly platform = 'facebook' as const;

  async publish(request: PublishRequest): Promise<PublishResult> {
    const token = await getValidAccessToken(request.accountId);
    const pageId = request.options?.['pageId'] as string | undefined;
    if (!pageId) throw new PublishError('No Facebook Page selected', this.platform, false);

    const payload = await apiFetch(this.platform, `${GRAPH}/${pageId}/videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_url: request.videoUrl,
        title: request.title ?? undefined,
        description: composeCaption('facebook', request.caption, request.hashtags),
        access_token: token,
        ...(request.scheduledFor
          ? {
              published: false,
              scheduled_publish_time: Math.floor(request.scheduledFor.getTime() / 1000),
            }
          : {}),
      }),
    });

    const id = payload['id'] as string | undefined;
    if (!id) throw new PublishError('Facebook returned no video id', this.platform, true);

    return {
      externalId: id,
      url: `https://www.facebook.com/${id}`,
      status: request.scheduledFor ? 'scheduled' : 'processing',
    };
  }

  async checkStatus(accountId: string, externalId: string): Promise<PublishResult> {
    return { externalId, url: `https://www.facebook.com/${externalId}`, status: 'published' };
  }

  async fetchMetrics(accountId: string, externalId: string): Promise<PostMetrics | null> {
    const token = await getValidAccessToken(accountId);
    const payload = await apiFetch(
      this.platform,
      `${GRAPH}/${externalId}/video_insights?metric=total_video_views,total_video_impressions,total_video_view_time&access_token=${token}`,
      {},
    );

    const data = payload['data'] as { name: string; values: { value: number }[] }[] | undefined;
    if (!data) return null;

    const value = (name: string) => data.find((m) => m.name === name)?.values[0]?.value ?? 0;

    return emptyMetrics({
      views: value('total_video_views'),
      impressions: value('total_video_impressions'),
      // The Graph API reports view time in milliseconds.
      watchTimeSec: value('total_video_view_time') / 1000,
    });
  }

  async fetchProfile(accessToken: string) {
    const pages = await apiFetch(
      this.platform,
      `${GRAPH}/me/accounts?fields=id,name,picture,fan_count&access_token=${accessToken}`,
      {},
    );

    const list = pages['data'] as
      | { id: string; name: string; picture?: { data?: { url?: string } }; fan_count?: number }[]
      | undefined;
    const page = list?.[0];
    if (!page) throw new PublishError('This account manages no Facebook Pages', this.platform, false);

    return {
      externalId: page.id,
      displayName: page.name,
      avatarUrl: page.picture?.data?.url,
      metadata: { pageId: page.id, fanCount: page.fan_count ?? null, pages: list },
    };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const ADAPTERS: Partial<Record<PlatformId, PlatformAdapter>> = {
  tiktok: new TikTokAdapter(),
  youtube: new YouTubeAdapter(),
  instagram: new InstagramAdapter(),
  facebook: new FacebookAdapter(),
};

export function getAdapter(platform: PlatformId): PlatformAdapter {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    throw new PublishError(
      `Publishing to ${platform} is not implemented yet. You can still render and download the export.`,
      platform,
      false,
    );
  }
  return adapter;
}

export function hasAdapter(platform: PlatformId): boolean {
  return ADAPTERS[platform] !== undefined;
}

/** Publish, translating auth failures into a clear reconnect instruction. */
export async function publish(
  platform: PlatformId,
  request: PublishRequest,
): Promise<PublishResult> {
  const adapter = getAdapter(platform);

  try {
    const result = await adapter.publish(request);
    log.info('published', { platform, externalId: result.externalId, status: result.status });
    return result;
  } catch (error) {
    if (error instanceof OAuthError) {
      throw new PublishError(
        `${platform} authorization is no longer valid. Reconnect the account and try again.`,
        platform,
        false,
      );
    }
    throw error;
  }
}

function emptyMetrics(overrides: Partial<PostMetrics> = {}): PostMetrics {
  return {
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    watchTimeSec: 0,
    averageViewDurationSec: 0,
    completionRate: 0,
    followersGained: 0,
    impressions: 0,
    retentionCurve: [],
    ...overrides,
  };
}
