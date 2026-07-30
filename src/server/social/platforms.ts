import type { PlatformCapabilities, PlatformId } from '@/lib/types';

/**
 * Platform registry.
 *
 * Capabilities are declared as data so the UI can validate a post *before* the
 * user schedules it — a 3-minute video destined for a 60-second surface should
 * be caught in the composer, not by a 500 from the platform an hour later.
 *
 * Limits reflect each platform's published guidance for video posts via their
 * content APIs. They are configuration, not guesses baked into logic, so they
 * can be corrected in one place when a platform changes them.
 */

export interface PlatformDefinition {
  id: PlatformId;
  name: string;
  /** Brand colour used for badges and charts. */
  color: string;
  capabilities: PlatformCapabilities;
  oauth: {
    authorizeUrl: string;
    tokenUrl: string;
    scopes: string[];
    /** Whether the provider requires PKCE (S256). */
    usePkce: boolean;
    /** Environment variable names holding the app credentials. */
    clientIdEnv: string;
    clientSecretEnv: string;
    /** Extra parameters some providers require on the authorize request. */
    extraAuthParams?: Record<string, string>;
  };
  /** Documentation link shown in the connect dialog. */
  docsUrl: string;
  /** What the user is agreeing to when they connect. */
  permissionSummary: string;
}

export const PLATFORMS: Record<PlatformId, PlatformDefinition> = {
  tiktok: {
    id: 'tiktok',
    name: 'TikTok',
    color: '#FE2C55',
    capabilities: {
      maxDurationSec: 600,
      minDurationSec: 3,
      maxFileBytes: 4 * 1024 * 1024 * 1024,
      aspectRatios: ['9:16', '1:1', '16:9'],
      maxTitleChars: 150,
      maxDescriptionChars: 2200,
      maxHashtags: 30,
      supportsScheduling: true,
      supportsDrafts: true,
      supportsAnalytics: true,
      containers: ['mp4', 'mov', 'webm'],
    },
    oauth: {
      authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
      tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
      scopes: ['user.info.basic', 'video.publish', 'video.upload', 'video.list'],
      usePkce: true,
      clientIdEnv: 'TIKTOK_CLIENT_KEY',
      clientSecretEnv: 'TIKTOK_CLIENT_SECRET',
      extraAuthParams: { response_type: 'code' },
    },
    docsUrl: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    permissionSummary:
      'Read your profile, upload videos, and read stats for videos posted through Phantom.',
  },

  youtube: {
    id: 'youtube',
    name: 'YouTube',
    color: '#FF0000',
    capabilities: {
      maxDurationSec: 60,
      minDurationSec: 1,
      maxFileBytes: 256 * 1024 * 1024 * 1024,
      aspectRatios: ['9:16', '1:1', '16:9'],
      maxTitleChars: 100,
      maxDescriptionChars: 5000,
      maxHashtags: 15,
      supportsScheduling: true,
      supportsDrafts: true,
      supportsAnalytics: true,
      containers: ['mp4', 'mov', 'webm'],
    },
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: [
        'https://www.googleapis.com/auth/youtube.upload',
        'https://www.googleapis.com/auth/youtube.readonly',
        'https://www.googleapis.com/auth/yt-analytics.readonly',
      ],
      usePkce: true,
      clientIdEnv: 'GOOGLE_CLIENT_ID',
      clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
      // Google only returns a refresh token when both are present.
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    },
    docsUrl: 'https://developers.google.com/youtube/v3/guides/uploading_a_video',
    permissionSummary: 'Upload videos to your channel and read your channel analytics.',
  },

  instagram: {
    id: 'instagram',
    name: 'Instagram',
    color: '#E4405F',
    capabilities: {
      maxDurationSec: 900,
      minDurationSec: 3,
      maxFileBytes: 1024 * 1024 * 1024,
      aspectRatios: ['9:16', '1:1', '4:5'],
      maxTitleChars: null,
      maxDescriptionChars: 2200,
      maxHashtags: 30,
      supportsScheduling: true,
      supportsDrafts: false,
      supportsAnalytics: true,
      containers: ['mp4', 'mov'],
    },
    oauth: {
      authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
      scopes: [
        'instagram_basic',
        'instagram_content_publish',
        'pages_show_list',
        'pages_read_engagement',
      ],
      usePkce: false,
      clientIdEnv: 'META_APP_ID',
      clientSecretEnv: 'META_APP_SECRET',
    },
    docsUrl: 'https://developers.facebook.com/docs/instagram-api/guides/content-publishing',
    permissionSummary:
      'Publish Reels to your connected professional account and read their insights.',
  },

  facebook: {
    id: 'facebook',
    name: 'Facebook',
    color: '#1877F2',
    capabilities: {
      maxDurationSec: 3600,
      minDurationSec: 1,
      maxFileBytes: 10 * 1024 * 1024 * 1024,
      aspectRatios: ['9:16', '1:1', '16:9', '4:5'],
      maxTitleChars: 255,
      maxDescriptionChars: 5000,
      maxHashtags: 30,
      supportsScheduling: true,
      supportsDrafts: true,
      supportsAnalytics: true,
      containers: ['mp4', 'mov'],
    },
    oauth: {
      authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
      scopes: ['pages_manage_posts', 'pages_show_list', 'pages_read_engagement', 'read_insights'],
      usePkce: false,
      clientIdEnv: 'META_APP_ID',
      clientSecretEnv: 'META_APP_SECRET',
    },
    docsUrl: 'https://developers.facebook.com/docs/video-api',
    permissionSummary: 'Publish videos to Pages you manage and read their insights.',
  },

  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn',
    color: '#0A66C2',
    capabilities: {
      maxDurationSec: 600,
      minDurationSec: 3,
      maxFileBytes: 5 * 1024 * 1024 * 1024,
      aspectRatios: ['9:16', '1:1', '16:9'],
      maxTitleChars: 200,
      maxDescriptionChars: 3000,
      maxHashtags: 10,
      supportsScheduling: true,
      supportsDrafts: false,
      supportsAnalytics: true,
      containers: ['mp4'],
    },
    oauth: {
      authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
      tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
      scopes: ['openid', 'profile', 'w_member_social'],
      usePkce: false,
      clientIdEnv: 'LINKEDIN_CLIENT_ID',
      clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
    },
    docsUrl: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api',
    permissionSummary: 'Post videos as you and read engagement on those posts.',
  },

  pinterest: {
    id: 'pinterest',
    name: 'Pinterest',
    color: '#BD081C',
    capabilities: {
      maxDurationSec: 300,
      minDurationSec: 4,
      maxFileBytes: 2 * 1024 * 1024 * 1024,
      aspectRatios: ['9:16', '1:1', '4:5'],
      maxTitleChars: 100,
      maxDescriptionChars: 800,
      maxHashtags: 20,
      supportsScheduling: true,
      supportsDrafts: true,
      supportsAnalytics: true,
      containers: ['mp4', 'mov'],
    },
    oauth: {
      authorizeUrl: 'https://www.pinterest.com/oauth/',
      tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
      scopes: ['pins:read', 'pins:write', 'boards:read', 'user_accounts:read'],
      usePkce: true,
      clientIdEnv: 'PINTEREST_APP_ID',
      clientSecretEnv: 'PINTEREST_APP_SECRET',
    },
    docsUrl: 'https://developers.pinterest.com/docs/api/v5/pins-create/',
    permissionSummary: 'Create Pins on boards you choose and read their analytics.',
  },

  x: {
    id: 'x',
    name: 'X',
    color: '#0F1419',
    capabilities: {
      maxDurationSec: 140,
      minDurationSec: 1,
      maxFileBytes: 512 * 1024 * 1024,
      aspectRatios: ['9:16', '1:1', '16:9'],
      maxTitleChars: null,
      maxDescriptionChars: 280,
      maxHashtags: 5,
      supportsScheduling: false,
      supportsDrafts: false,
      supportsAnalytics: false,
      containers: ['mp4'],
    },
    oauth: {
      authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
      tokenUrl: 'https://api.twitter.com/2/oauth2/token',
      scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'],
      usePkce: true,
      clientIdEnv: 'X_CLIENT_ID',
      clientSecretEnv: 'X_CLIENT_SECRET',
    },
    docsUrl: 'https://docs.x.com/x-api/posts/create-a-post',
    permissionSummary: 'Post on your behalf and read your profile.',
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS) as PlatformId[];

export function getPlatform(id: string): PlatformDefinition | undefined {
  return PLATFORMS[id as PlatformId];
}

/** True when the deployment has credentials configured for this platform. */
export function isPlatformConfigured(id: PlatformId): boolean {
  const definition = PLATFORMS[id];
  return Boolean(
    process.env[definition.oauth.clientIdEnv] && process.env[definition.oauth.clientSecretEnv],
  );
}

export interface ValidationIssue {
  field: 'duration' | 'aspect' | 'size' | 'title' | 'description' | 'hashtags' | 'container' | 'scheduling';
  severity: 'error' | 'warning';
  message: string;
}

/**
 * Validate a post against a platform's limits before it is queued.
 *
 * Errors block publishing; warnings are shown but do not stop the user, since
 * platform limits change and a stale limit here should never be a hard wall.
 */
export function validateForPlatform(
  platformId: PlatformId,
  post: {
    durationSec?: number;
    aspect?: string;
    sizeBytes?: number;
    container?: string;
    title?: string;
    description?: string;
    hashtags?: string[];
    scheduledFor?: Date | null;
  },
): ValidationIssue[] {
  const platform = PLATFORMS[platformId];
  const caps = platform.capabilities;
  const issues: ValidationIssue[] = [];

  if (post.durationSec !== undefined) {
    if (post.durationSec > caps.maxDurationSec) {
      issues.push({
        field: 'duration',
        severity: 'error',
        message: `${platform.name} allows up to ${caps.maxDurationSec}s; this is ${Math.round(
          post.durationSec,
        )}s.`,
      });
    } else if (post.durationSec < caps.minDurationSec) {
      issues.push({
        field: 'duration',
        severity: 'error',
        message: `${platform.name} requires at least ${caps.minDurationSec}s.`,
      });
    }
  }

  if (post.aspect && !caps.aspectRatios.includes(post.aspect as never)) {
    issues.push({
      field: 'aspect',
      severity: 'warning',
      message: `${platform.name} works best with ${caps.aspectRatios.join(', ')}. ${post.aspect} may be letterboxed.`,
    });
  }

  if (post.sizeBytes !== undefined && post.sizeBytes > caps.maxFileBytes) {
    issues.push({
      field: 'size',
      severity: 'error',
      message: `File is ${formatBytes(post.sizeBytes)}; ${platform.name} allows ${formatBytes(
        caps.maxFileBytes,
      )}.`,
    });
  }

  if (post.container && !caps.containers.includes(post.container)) {
    issues.push({
      field: 'container',
      severity: 'error',
      message: `${platform.name} accepts ${caps.containers.join(', ')} files.`,
    });
  }

  if (post.title && caps.maxTitleChars !== null && post.title.length > caps.maxTitleChars) {
    issues.push({
      field: 'title',
      severity: 'error',
      message: `Title is ${post.title.length} characters; the limit is ${caps.maxTitleChars}.`,
    });
  }

  if (post.description && post.description.length > caps.maxDescriptionChars) {
    issues.push({
      field: 'description',
      severity: 'error',
      message: `Caption is ${post.description.length} characters; the limit is ${caps.maxDescriptionChars}.`,
    });
  }

  if (post.hashtags && post.hashtags.length > caps.maxHashtags) {
    issues.push({
      field: 'hashtags',
      severity: 'warning',
      message: `${post.hashtags.length} hashtags; ${platform.name} counts at most ${caps.maxHashtags}.`,
    });
  }

  if (post.scheduledFor && !caps.supportsScheduling) {
    issues.push({
      field: 'scheduling',
      severity: 'warning',
      message: `${platform.name} has no scheduling API. Phantom will hold this in the queue and publish it at the scheduled time.`,
    });
  }

  return issues;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}
