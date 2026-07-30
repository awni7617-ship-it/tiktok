import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { AssetKind, JobStatus, PostStatus, ProjectStatus, RenderStatus } from '@prisma/client';
import type { EditPlan, MediaProbe, Transcript } from '@/lib/types';
import { newId } from '@/lib/id';
import { config } from '@/server/config';
import { prisma } from '@/server/db/client';
import { logger } from '@/server/obs/logger';
import { getStorage, LocalStorageDriver } from '@/server/storage';
import { getAsr, getRoiDetector, getTts } from '@/server/ai/registry';
import { buildEditPlan } from '@/server/edit/plan';
import { buildAudioAnalysis } from '@/server/edit/audio';
import { toAss, toSrt, toVtt } from '@/server/edit/captions';
import { getPreset } from '@/server/video/presets';
import { isFfmpegAvailable, ffmpeg, probeMedia } from '@/server/video/ffmpeg';
import { buildAnalysisCommand, buildProxyCommand, buildThumbnailCommand, renderVideo } from '@/server/video/render';
import { optimize } from '@/server/optimizer';
import { generateContent } from '@/server/ai/generate';
import { getAdapter } from '@/server/social/publish';
import type { PlatformId } from '@/lib/types';
import { enqueue, updateProgress, type JobType } from './queue';

const log = logger.child({ module: 'jobs' });

export interface JobContext {
  jobId: string;
  payload: Record<string, unknown>;
  /** Report fractional progress; throttled by the caller. */
  progress: (fraction: number) => Promise<void>;
  signal: AbortSignal;
}

export type JobHandler = (context: JobContext) => Promise<Record<string, unknown>>;

/** Scratch directory for one job; always removed, even on failure. */
async function withTempDir<T>(jobId: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.resolve(config.MEDIA_TMP_DIR, jobId);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Get a local path for a stored asset.
 *
 * The local driver already has the bytes on disk, so we hand back the real
 * path rather than copying a multi-gigabyte file to read it.
 */
async function materialize(storageKey: string, dir: string, filename: string): Promise<string> {
  const storage = getStorage();
  if (storage instanceof LocalStorageDriver) return storage.localPath(storageKey);
  return storage.download(storageKey, path.join(dir, filename));
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Job payload is missing "${key}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Media analysis
// ---------------------------------------------------------------------------

/**
 * Probe an uploaded asset and kick off the rest of the analysis chain.
 *
 * Each stage enqueues the next rather than doing everything in one job, so a
 * transcription failure does not force a re-probe, and progress is visible at
 * a useful granularity in the UI.
 */
export const probeAsset: JobHandler = async ({ payload }) => {
  const assetId = requireString(payload, 'assetId');
  const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });

  if (!(await isFfmpegAvailable())) {
    log.warn('ffmpeg unavailable; skipping probe', { assetId });
    return { skipped: true, reason: 'ffmpeg-unavailable' };
  }

  return withTempDir(`probe-${assetId}`, async (dir) => {
    const source = await materialize(asset.storageKey, dir, asset.filename);
    const probe = await probeMedia(source);

    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: {
        durationSec: probe.durationSec,
        width: probe.width || null,
        height: probe.height || null,
        metadata: probe as unknown as object,
      },
    });

    if (asset.projectId) {
      await enqueue({
        type: 'media.transcribe',
        payload: { assetId, projectId: asset.projectId },
        projectId: asset.projectId,
        workspaceId: asset.workspaceId,
        priority: 5,
      });
      await enqueue({
        type: 'media.proxy',
        payload: { assetId },
        projectId: asset.projectId,
        workspaceId: asset.workspaceId,
        priority: 1,
      });
    }

    return { probe: probe as unknown as Record<string, unknown> };
  });
};

export const transcribeAsset: JobHandler = async ({ payload, progress }) => {
  const assetId = requireString(payload, 'assetId');
  const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });

  await progress(0.1);

  const transcript = await withTempDir(`asr-${assetId}`, async (dir) => {
    const source = await materialize(asset.storageKey, dir, asset.filename);
    return getAsr().transcribe({
      source,
      language: (payload['language'] as string | undefined) ?? null,
      diarize: payload['diarize'] === true,
    });
  });

  await progress(0.8);

  await prisma.mediaAsset.update({
    where: { id: assetId },
    data: { transcript: transcript as unknown as object },
  });

  if (asset.projectId) {
    await enqueue({
      type: 'edit.plan',
      payload: { projectId: asset.projectId, assetId },
      projectId: asset.projectId,
      workspaceId: asset.workspaceId,
      priority: 5,
    });
  }

  return { words: transcript.words.length, durationSec: transcript.durationSec };
};

/**
 * Build the edit plan.
 *
 * This is the heart of the AI editor: it runs the loudness analysis and ROI
 * detection, then hands everything to the pure planner. The planner is fast,
 * so re-running it with different settings is cheap — only the measurement
 * steps here are expensive.
 */
export const planEdit: JobHandler = async ({ payload, progress }) => {
  const projectId = requireString(payload, 'projectId');
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { assets: { where: { kind: AssetKind.SOURCE_VIDEO }, orderBy: { createdAt: 'asc' } } },
  });

  const asset = project.assets[0];
  if (!asset) throw new Error('Project has no source video');

  await prisma.project.update({
    where: { id: projectId },
    data: { status: ProjectStatus.ANALYZING },
  });

  const probe = (asset.metadata as unknown as MediaProbe | null) ?? {
    durationSec: asset.durationSec ?? 0,
    width: asset.width ?? 1920,
    height: asset.height ?? 1080,
    fps: 30,
    hasAudio: true,
    audioChannels: 2,
    audioSampleRate: 48000,
    videoCodec: null,
    audioCodec: null,
    bitrateKbps: null,
  };

  const transcript = (asset.transcript as unknown as Transcript | null) ?? undefined;

  const plan = await withTempDir(`plan-${projectId}`, async (dir) => {
    await progress(0.2);

    // Loudness envelope, when ffmpeg is present.
    let audio;
    if (await isFfmpegAvailable()) {
      const source = await materialize(asset.storageKey, dir, asset.filename);
      const result = await ffmpeg(buildAnalysisCommand(source), { timeoutMs: 20 * 60 * 1000 }).catch(
        (error) => {
          log.warn('audio analysis failed; continuing without it', { projectId, error });
          return null;
        },
      );
      if (result) audio = buildAudioAnalysis(result.stderr, result.stderr);
    }

    await progress(0.55);

    const regions = await getRoiDetector().detect(asset.storageKey, {
      sampleFps: 5,
      durationSec: probe.durationSec,
    });

    await progress(0.8);

    const settings = (project.settings as Record<string, unknown> | null) ?? {};
    return buildEditPlan({ probe, transcript, audio, regions }, settings);
  });

  await prisma.project.update({
    where: { id: projectId },
    data: { editPlan: plan as unknown as object, status: ProjectStatus.READY },
  });

  await enqueue({
    type: 'edit.optimize',
    payload: { projectId },
    projectId,
    workspaceId: project.workspaceId,
    priority: 3,
  });

  return {
    cuts: plan.cutPlan.cuts.length,
    outputDurationSec: plan.cutPlan.outputDurationSec,
    captions: plan.captions.length,
    moments: plan.moments.length,
  };
};

export const optimizeProject: JobHandler = async ({ payload }) => {
  const projectId = requireString(payload, 'projectId');
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { assets: { where: { kind: AssetKind.SOURCE_VIDEO }, take: 1 } },
  });

  const report = await optimize({
    plan: (project.editPlan as unknown as EditPlan | null) ?? undefined,
    transcript: (project.assets[0]?.transcript as unknown as Transcript | null) ?? undefined,
    content: (project.content as Record<string, never> | null) ?? undefined,
    platform: (payload['platform'] as PlatformId | undefined) ?? 'tiktok',
  });

  await prisma.project.update({
    where: { id: projectId },
    data: { report: report as unknown as object },
  });

  return { score: report.score, suggestions: report.suggestions.length };
};

export const generateProxy: JobHandler = async ({ payload }) => {
  const assetId = requireString(payload, 'assetId');
  if (!(await isFfmpegAvailable())) return { skipped: true, reason: 'ffmpeg-unavailable' };

  const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });

  return withTempDir(`proxy-${assetId}`, async (dir) => {
    const source = await materialize(asset.storageKey, dir, asset.filename);
    const output = path.join(dir, 'proxy.mp4');

    await ffmpeg(buildProxyCommand(source, output), { timeoutMs: 30 * 60 * 1000 });

    const storage = getStorage();
    const key = `${asset.storageKey.replace(/\.[^.]+$/, '')}.proxy.mp4`;
    const stored = await storage.upload(output, key, 'video/mp4');

    await prisma.mediaAsset.create({
      data: {
        id: newId('ast'),
        workspaceId: asset.workspaceId,
        projectId: asset.projectId,
        kind: AssetKind.PROXY,
        filename: 'proxy.mp4',
        storageKey: stored.key,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(stored.sizeBytes),
        durationSec: asset.durationSec,
      },
    });

    return { key: stored.key, sizeBytes: stored.sizeBytes };
  });
};

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

export const generateProjectContent: JobHandler = async ({ payload }) => {
  const projectId = requireString(payload, 'projectId');
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const result = await generateContent({
    prompt: requireString(payload, 'prompt'),
    niche: payload['niche'] as never,
    targetDurationSec: payload['targetDurationSec'] as number | undefined,
    tone: payload['tone'] as string | undefined,
    platform: payload['platform'] as PlatformId | undefined,
    useAsScript: payload['useAsScript'] === true,
  });

  await prisma.project.update({
    where: { id: projectId },
    data: {
      content: result.content as unknown as object,
      title: result.content.title,
      niche: result.content.niche,
      status: ProjectStatus.READY,
    },
  });

  if (payload['narrate'] !== false) {
    await enqueue({
      type: 'content.narrate',
      payload: { projectId, voiceId: payload['voiceId'] ?? 'voice_nova' },
      projectId,
      workspaceId: project.workspaceId,
      priority: 4,
    });
  }

  return { title: result.content.title, scenes: result.content.scenes.length, provider: result.provider };
};

/** Synthesise narration for every scene and store it as one voiceover asset. */
export const narrateProject: JobHandler = async ({ payload, progress }) => {
  const projectId = requireString(payload, 'projectId');
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });

  const content = project.content as { script?: string; scenes?: { narration: string }[] } | null;
  const script = content?.scenes?.map((scene) => scene.narration).join(' ') ?? content?.script;
  if (!script) throw new Error('Project has no script to narrate');

  return withTempDir(`tts-${projectId}`, async (dir) => {
    const output = path.join(dir, 'voiceover.mp3');

    const result = await getTts().synthesize({
      text: script,
      voiceId: (payload['voiceId'] as string) ?? 'voice_nova',
      speed: (payload['speed'] as number) ?? 1,
      outputPath: output,
      format: 'mp3',
    });

    await progress(0.7);

    const storage = getStorage();
    const stored = await storage.upload(
      result.path,
      `workspaces/${project.workspaceId}/projects/${projectId}/voiceover/${newId()}.mp3`,
      'audio/mpeg',
    );

    // Word timings from the TTS provider give exact caption sync; when the
    // provider omits them the caption builder falls back to the transcript.
    const transcript: Transcript | null = result.words
      ? {
          language: 'en',
          durationSec: result.durationSec,
          words: result.words.map((word) => ({ ...word, confidence: 1 })),
          segments: [
            {
              start: 0,
              end: result.durationSec,
              text: script,
              words: result.words.map((word) => ({ ...word, confidence: 1 })),
            },
          ],
        }
      : null;

    await prisma.mediaAsset.create({
      data: {
        id: newId('ast'),
        workspaceId: project.workspaceId,
        projectId,
        kind: AssetKind.VOICEOVER,
        filename: 'voiceover.mp3',
        storageKey: stored.key,
        mimeType: 'audio/mpeg',
        sizeBytes: BigInt(stored.sizeBytes),
        durationSec: result.durationSec,
        transcript: (transcript ?? undefined) as unknown as object | undefined,
      },
    });

    return { key: stored.key, durationSec: result.durationSec };
  });
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const renderProject: JobHandler = async ({ payload, progress, signal }) => {
  const renderId = requireString(payload, 'renderId');
  const render = await prisma.render.findUniqueOrThrow({
    where: { id: renderId },
    include: {
      project: {
        include: { assets: { where: { kind: AssetKind.SOURCE_VIDEO }, take: 1 } },
      },
    },
  });

  const preset = getPreset(render.presetId);
  if (!preset) throw new Error(`Unknown export preset: ${render.presetId}`);

  const asset = render.project.assets[0];
  if (!asset) throw new Error('Project has no source video to render');

  const plan = render.project.editPlan as unknown as EditPlan | null;
  if (!plan) throw new Error('Project has no edit plan; run analysis first');

  if (!(await isFfmpegAvailable())) {
    await prisma.render.update({
      where: { id: renderId },
      data: {
        status: RenderStatus.FAILED,
        errorMessage: 'ffmpeg is not installed on this server, so rendering is unavailable.',
        completedAt: new Date(),
      },
    });
    throw new Error('ffmpeg is not available');
  }

  await prisma.render.update({
    where: { id: renderId },
    data: { status: RenderStatus.RUNNING, startedAt: new Date() },
  });
  await prisma.project.update({
    where: { id: render.projectId },
    data: { status: ProjectStatus.RENDERING },
  });

  try {
    const result = await withTempDir(`render-${renderId}`, async (dir) => {
      const source = await materialize(asset.storageKey, dir, asset.filename);
      const output = path.join(dir, `output.${preset.container}`);

      const probe = asset.metadata as unknown as MediaProbe | null;

      const rendered = await renderVideo(
        {
          inputPath: source,
          outputPath: output,
          plan,
          preset,
          hasAudio: probe?.hasAudio ?? true,
          fontsDir: config.FONTS_DIR,
        },
        {
          onProgress: (fraction) => void progress(fraction * 0.85),
          signal,
        },
      );

      const storage = getStorage();
      const videoKey = `workspaces/${render.project.workspaceId}/projects/${render.projectId}/renders/${renderId}.${preset.container}`;
      const stored = await storage.upload(rendered.outputPath, videoKey, `video/${preset.container}`);

      await progress(0.92);

      // A poster frame from 25% in usually avoids both the black first frame
      // and a mid-blink face.
      const thumbPath = path.join(dir, 'thumb.jpg');
      let thumbnailKey: string | null = null;
      try {
        await ffmpeg(
          buildThumbnailCommand(rendered.outputPath, thumbPath, rendered.durationSec * 0.25, {
            width: preset.width,
            height: preset.height,
          }),
          { timeoutMs: 120_000 },
        );
        const thumb = await storage.upload(
          thumbPath,
          `workspaces/${render.project.workspaceId}/projects/${render.projectId}/renders/${renderId}.jpg`,
          'image/jpeg',
        );
        thumbnailKey = thumb.key;
      } catch (error) {
        log.warn('thumbnail extraction failed', { renderId, error });
      }

      // Ship caption sidecars alongside the video for platforms that accept them.
      if (plan.captions.length > 0) {
        await storage.put(
          `${videoKey.replace(/\.[^.]+$/, '')}.srt`,
          Buffer.from(toSrt(plan.captions), 'utf8'),
          'application/x-subrip',
        );
        await storage.put(
          `${videoKey.replace(/\.[^.]+$/, '')}.vtt`,
          Buffer.from(toVtt(plan.captions), 'utf8'),
          'text/vtt',
        );
        await storage.put(
          `${videoKey.replace(/\.[^.]+$/, '')}.ass`,
          Buffer.from(
            toAss(plan.captions, plan.captionStyle, { width: preset.width, height: preset.height }),
            'utf8',
          ),
          'text/x-ssa',
        );
      }

      return { rendered, stored, thumbnailKey };
    });

    await prisma.render.update({
      where: { id: renderId },
      data: {
        status: RenderStatus.COMPLETED,
        progress: 1,
        storageKey: result.stored.key,
        thumbnailKey: result.thumbnailKey,
        durationSec: result.rendered.durationSec,
        sizeBytes: BigInt(result.rendered.sizeBytes),
        width: result.rendered.width,
        height: result.rendered.height,
        command: result.rendered.command.slice(0, 8000),
        completedAt: new Date(),
      },
    });

    await prisma.project.update({
      where: { id: render.projectId },
      data: { status: ProjectStatus.RENDERED },
    });

    return { key: result.stored.key, durationSec: result.rendered.durationSec };
  } catch (error) {
    await prisma.render.update({
      where: { id: renderId },
      data: {
        status: RenderStatus.FAILED,
        errorMessage: error instanceof Error ? error.message.slice(0, 2000) : String(error),
        completedAt: new Date(),
      },
    });
    await prisma.project.update({
      where: { id: render.projectId },
      data: { status: ProjectStatus.FAILED },
    });
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Publishing & analytics
// ---------------------------------------------------------------------------

export const publishPost: JobHandler = async ({ payload }) => {
  const postId = requireString(payload, 'postId');
  const post = await prisma.post.findUniqueOrThrow({
    where: { id: postId },
    include: { render: true, socialAccount: true, project: true },
  });

  if (post.status === PostStatus.PUBLISHED || post.status === PostStatus.CANCELLED) {
    return { skipped: true, status: post.status };
  }
  if (!post.socialAccount || post.socialAccount.disconnectedAt) {
    throw new Error('This post has no connected account. Reconnect the account and retry.');
  }
  if (!post.render?.storageKey) {
    throw new Error('This post has no completed render');
  }

  await prisma.post.update({
    where: { id: postId },
    data: { status: PostStatus.UPLOADING, attempts: { increment: 1 } },
  });

  try {
    // Platforms fetch the file themselves, so the URL must outlive the upload.
    const videoUrl = await getStorage().signedUrl(post.render.storageKey, 6 * 60 * 60);

    const adapter = getAdapter(post.platform as PlatformId);
    const result = await adapter.publish({
      accountId: post.socialAccountId!,
      videoUrl,
      title: post.title ?? undefined,
      caption: post.caption,
      hashtags: post.hashtags,
      options: (post.options as Record<string, unknown> | null) ?? {},
      scheduledFor: null,
    });

    await prisma.post.update({
      where: { id: postId },
      data: {
        status: result.status === 'processing' ? PostStatus.PROCESSING : PostStatus.PUBLISHED,
        externalId: result.externalId,
        externalUrl: result.url,
        publishedAt: result.status === 'published' ? new Date() : null,
        errorMessage: null,
      },
    });

    // Platforms that transcode asynchronously need a follow-up status check.
    if (result.status === 'processing') {
      await enqueue({
        type: 'social.publish',
        payload: { postId, checkOnly: true },
        workspaceId: post.workspaceId,
        delayMs: 60_000,
        priority: 2,
      });
    } else {
      await enqueue({
        type: 'analytics.sync',
        payload: { postId },
        workspaceId: post.workspaceId,
        delayMs: 30 * 60 * 1000,
      });
    }

    return { externalId: result.externalId, status: result.status };
  } catch (error) {
    await prisma.post.update({
      where: { id: postId },
      data: {
        status: PostStatus.FAILED,
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : String(error),
      },
    });
    throw error;
  }
};

export const syncAnalytics: JobHandler = async ({ payload }) => {
  const postId = payload['postId'] as string | undefined;

  const posts = postId
    ? [
        await prisma.post.findUniqueOrThrow({
          where: { id: postId },
          include: { socialAccount: true },
        }),
      ]
    : await prisma.post.findMany({
        where: {
          status: PostStatus.PUBLISHED,
          externalId: { not: null },
          publishedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        include: { socialAccount: true },
        take: 200,
      });

  let synced = 0;

  for (const post of posts) {
    if (!post.externalId || !post.socialAccountId || post.socialAccount?.disconnectedAt) continue;

    try {
      const adapter = getAdapter(post.platform as PlatformId);
      const metrics = await adapter.fetchMetrics(post.socialAccountId, post.externalId);
      if (!metrics) continue;

      await prisma.postMetric.create({
        data: {
          id: newId('met'),
          postId: post.id,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments,
          shares: metrics.shares,
          saves: metrics.saves,
          impressions: metrics.impressions,
          watchTimeSec: metrics.watchTimeSec,
          averageViewDurationSec: metrics.averageViewDurationSec,
          completionRate: metrics.completionRate,
          followersGained: metrics.followersGained,
          retentionCurve: metrics.retentionCurve,
        },
      });
      synced += 1;
    } catch (error) {
      // One failing account should never stop the whole sync.
      log.warn('metric sync failed for a post', { postId: post.id, error });
    }
  }

  return { synced, considered: posts.length };
};

/** Release scheduled posts whose time has come. */
export const releaseScheduled: JobHandler = async () => {
  const due = await prisma.post.findMany({
    where: { status: PostStatus.SCHEDULED, scheduledFor: { lte: new Date() } },
    take: 100,
  });

  for (const post of due) {
    await prisma.post.update({ where: { id: post.id }, data: { status: PostStatus.QUEUED } });
    await enqueue({
      type: 'social.publish',
      payload: { postId: post.id },
      workspaceId: post.workspaceId,
      priority: 8,
    });
  }

  return { released: due.length };
};

export const maintenance: JobHandler = async () => {
  const { pruneJobs } = await import('./queue');
  const { pruneSessions } = await import('@/server/auth/session');

  const [jobs, sessions] = await Promise.all([pruneJobs(), pruneSessions()]);

  // Reap renders that were claimed but never finished.
  const stale = await prisma.render.updateMany({
    where: {
      status: RenderStatus.RUNNING,
      startedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    },
    data: { status: RenderStatus.FAILED, errorMessage: 'Render timed out', completedAt: new Date() },
  });

  return { prunedJobs: jobs, prunedSessions: sessions, staleRenders: stale.count };
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const HANDLERS: Record<JobType, JobHandler> = {
  'media.probe': probeAsset,
  'media.transcribe': transcribeAsset,
  'media.analyze': planEdit,
  'media.proxy': generateProxy,
  'edit.plan': planEdit,
  'edit.optimize': optimizeProject,
  'content.generate': generateProjectContent,
  'content.narrate': narrateProject,
  'render.video': renderProject,
  'render.thumbnail': generateProxy,
  'social.publish': publishPost,
  'social.refresh-token': async ({ payload }) => {
    const { getValidAccessToken } = await import('@/server/social/oauth');
    await getValidAccessToken(requireString(payload, 'accountId'));
    return { refreshed: true };
  },
  'analytics.sync': syncAnalytics,
  'analytics.insights': async ({ payload }) => {
    const projectId = payload['projectId'] as string | undefined;
    return { projectId: projectId ?? null, note: 'Insights are computed on demand by the dashboard.' };
  },
  'maintenance.prune': maintenance,
};

export function getHandler(type: string): JobHandler | undefined {
  return HANDLERS[type as JobType];
}

/** Job types that only make sense to run once at a time, cluster-wide. */
export const SINGLETON_JOBS: JobType[] = ['maintenance.prune', 'analytics.sync'];

export { JobStatus, updateProgress };
