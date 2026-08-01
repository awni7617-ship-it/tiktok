/**
 * Domain types shared by the server and the browser.
 *
 * This module must stay free of Node imports — it is pulled into client
 * components, and anything reaching for `node:fs` here breaks the build.
 */

export type PlatformId = 'tiktok' | 'instagram' | 'youtube';

export type VideoStatus =
  | 'queued' // waiting for a worker
  | 'writing' // script generation
  | 'narrating' // text to speech
  | 'illustrating' // image generation
  | 'rendering' // ffmpeg
  | 'ready' // mp4 on disk, not yet published
  | 'publishing'
  | 'published'
  | 'failed';

/** Statuses where the pipeline is actively working on the video. */
export const WORKING_STATUSES: readonly VideoStatus[] = [
  'writing',
  'narrating',
  'illustrating',
  'rendering',
  'publishing',
];

export type Cadence =
  | 'three-per-week'
  | 'daily'
  | 'twice-daily'
  | 'manual';

/** One AI-written beat of a video: a line of narration over one still image. */
export interface Scene {
  /** Narration read aloud over this scene. Captions are burned from this. */
  narration: string;
  /** Prompt handed to the image model. Never contains text instructions. */
  visual: string;
  /** Measured seconds of narration audio. Filled in after TTS. */
  seconds?: number;
}

export interface Script {
  hook: string;
  scenes: Scene[];
  caption: string;
  hashtags: string[];
}

export interface Video {
  id: string;
  channelId: string;
  status: VideoStatus;
  /** Free-text idea, when the video was made on demand rather than by autopilot. */
  idea: string | null;
  title: string;
  script: Script | null;
  /** Relative to the data directory, e.g. `videos/<id>/final.mp4`. */
  file: string | null;
  durationSeconds: number | null;
  error: string | null;
  /** When autopilot intends this to go out. */
  scheduledFor: string | null;
  publishedAt: string | null;
  /** Per-platform publish outcome, keyed by platform. */
  posts: PostRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface PostRecord {
  platform: PlatformId;
  status: 'pending' | 'posted' | 'failed';
  /** Platform's own id for the post, once it exists. */
  remoteId: string | null;
  url: string | null;
  error: string | null;
  postedAt: string | null;
}

export interface Channel {
  id: string;
  name: string;
  nicheId: string;
  styleId: string;
  voiceId: string;
  /** Music bed: a built-in track id, or null for none. */
  musicId: string | null;
  cadence: Cadence;
  /** Local hour-of-day slots autopilot aims for, e.g. [9, 18]. */
  postingHours: number[];
  /** Platforms autopilot posts to. Only connected ones actually publish. */
  platforms: PlatformId[];
  /** Autopilot only queues work while this is true. */
  active: boolean;
  /** Seconds of finished video to aim for. */
  targetSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface SocialAccount {
  platform: PlatformId;
  /** Handle or channel name shown in the UI. */
  displayName: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch millis. Null when the token does not expire. */
  expiresAt: number | null;
  /** Platform-specific: YouTube channel id, Instagram IG user id, TikTok open id. */
  remoteUserId: string | null;
  connectedAt: string;
}

export interface Settings {
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  /** Where finished videos are written. Defaults to the data directory. */
  outputDir: string | null;
  accounts: SocialAccount[];
}

/** What `/api/settings` returns — keys reduced to a presence flag. */
export interface SettingsView {
  anthropic: boolean;
  openai: boolean;
  outputDir: string;
  providers: {
    script: string;
    voice: string;
    image: string;
  };
  accounts: {
    platform: PlatformId;
    displayName: string;
    expired: boolean;
    connectedAt: string;
  }[];
  /** Platforms with OAuth app credentials configured in the environment. */
  configurable: PlatformId[];
  ffmpeg: boolean;
}

export interface Job {
  id: string;
  kind: 'produce' | 'publish';
  videoId: string;
  /** Epoch millis. The worker ignores jobs until this passes. */
  runAfter: number;
  attempts: number;
  /** Set while a worker holds the job, so a second worker skips it. */
  leasedUntil: number | null;
  lastError: string | null;
  createdAt: string;
}
