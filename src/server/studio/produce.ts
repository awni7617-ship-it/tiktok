import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContentNiche, GeneratedContent, PlatformId } from '@/lib/types';
import { generateContent } from '@/server/ai/generate';
import { getImage, getTts } from '@/server/ai/registry';
import { toAss } from '@/server/edit/captions';
import { ffmpeg, probeMedia } from '@/server/video/ffmpeg';
import { logger } from '@/server/obs/logger';
import { buildImagePrompt } from './prompts';
import {
  DEFAULT_CAPTION_STYLE,
  buildSlideshowCommand,
  planSceneTiming,
  type SlideshowScene,
} from './slideshow';

const log = logger.child({ module: 'studio:produce' });

/**
 * Idea in, finished video file out.
 *
 * This is the studio's spine: write the script, speak it, illustrate it, cut
 * it together. Every step runs through the same provider interfaces the rest
 * of the platform uses, so it works offline on the deterministic providers
 * and gets better — not different — when API keys are configured.
 */

export interface ProduceOptions {
  prompt: string;
  /**
   * A script the creator has already seen and approved.
   *
   * Without this, clicking "build this video" would silently regenerate the
   * script and produce something different from what is on screen.
   */
  content?: GeneratedContent;
  niche?: ContentNiche;
  targetDurationSec?: number;
  tone?: string;
  platform?: PlatformId;
  voiceId?: string;
  speed?: number;
  width?: number;
  height?: number;
  fps?: number;
  captions?: boolean;
  kenBurns?: boolean;
  transitionSec?: number;
  musicPath?: string;
  /** Directory for the finished video and its intermediate assets. */
  workDir: string;
  fontsDir?: string;
  onProgress?: (update: ProduceProgress) => void;
  signal?: AbortSignal;
}

export interface ProduceProgress {
  stage: 'script' | 'narration' | 'visuals' | 'render' | 'done';
  /** 0–1 across the whole production, not within the stage. */
  fraction: number;
  message: string;
}

export interface ProduceResult {
  videoPath: string;
  content: GeneratedContent;
  durationSec: number;
  sceneCount: number;
  /** The exact ffmpeg filter graph, for the "inspect render" panel. */
  filterGraph: string;
}

/** Stage weights, so progress reflects real time rather than step count. */
const STAGE_START = { script: 0, narration: 0.15, visuals: 0.45, render: 0.7, done: 1 } as const;

export async function produceVideo(options: ProduceOptions): Promise<ProduceResult> {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const fps = options.fps ?? 30;

  const report = (stage: ProduceProgress['stage'], fraction: number, message: string) =>
    options.onProgress?.({ stage, fraction, message });

  const assets = path.join(options.workDir, 'assets');
  await mkdir(assets, { recursive: true });

  // --- 1. Script -----------------------------------------------------------
  let content: GeneratedContent;

  if (options.content) {
    report('script', STAGE_START.script, 'Using your script');
    content = options.content;
  } else {
    report('script', STAGE_START.script, 'Writing the script');
    const generated = await generateContent({
      prompt: options.prompt,
      niche: options.niche,
      targetDurationSec: options.targetDurationSec ?? 45,
      tone: options.tone,
      platform: options.platform,
    });
    content = generated.content;
  }

  if (content.scenes.length === 0) {
    throw new Error('The generated script had no scenes to film');
  }

  options.signal?.throwIfAborted();

  // --- 2. Narration --------------------------------------------------------
  // Speech first, because everything downstream is timed to its real
  // duration: scene lengths, caption cues and the total runtime.
  const tts = getTts();
  const voiceId = options.voiceId ?? (await tts.listVoices())[0]?.id ?? 'default';

  const narration: { path: string; durationSec: number }[] = [];

  for (const [index, scene] of content.scenes.entries()) {
    options.signal?.throwIfAborted();

    const share = index / content.scenes.length;
    report(
      'narration',
      STAGE_START.narration + share * (STAGE_START.visuals - STAGE_START.narration),
      `Recording narration ${index + 1} of ${content.scenes.length}`,
    );

    const outputPath = path.join(assets, `narration-${index}.wav`);
    const result = await tts.synthesize({
      text: scene.narration,
      voiceId,
      speed: options.speed ?? 1,
      outputPath,
      format: 'wav',
    });

    // Trust the file over the provider: a reported duration that is out by
    // even 200ms per scene puts the captions visibly off by the end.
    let durationSec = result.durationSec;
    try {
      const probed = await probeMedia(result.path);
      if (probed.durationSec > 0) durationSec = probed.durationSec;
    } catch {
      // Keep the provider's figure if the probe fails; the render will still
      // be watchable, just marginally less precise.
    }

    narration.push({ path: result.path, durationSec });
  }

  // --- 3. Visuals ----------------------------------------------------------
  const image = getImage();
  const visuals: string[] = [];

  for (const [index, scene] of content.scenes.entries()) {
    options.signal?.throwIfAborted();

    const share = index / content.scenes.length;
    report(
      'visuals',
      STAGE_START.visuals + share * (STAGE_START.render - STAGE_START.visuals),
      `Creating visual ${index + 1} of ${content.scenes.length}`,
    );

    const outputPath = path.join(assets, `scene-${index}.png`);
    const result = await image.generate({
      // The scene's visual direction, plus the framing, look and text ban the
      // script model should not have to think about.
      prompt: buildImagePrompt({
        visual: scene.visual,
        niche: options.niche,
        tone: options.tone,
        index,
      }),
      // Generated at frame size so the Ken Burns push has real pixels to
      // work with rather than upscaling artefacts.
      width,
      height,
      outputPath,
      style: options.tone,
    });
    visuals.push(result.path);
  }

  // --- 4. Timing and captions ---------------------------------------------
  const timing = planSceneTiming(
    content.scenes.map((scene, index) => ({
      text: scene.narration,
      narrationSec: narration[index]?.durationSec ?? null,
    })),
  );

  let subtitlePath: string | undefined;
  if (options.captions !== false) {
    subtitlePath = path.join(assets, 'captions.ass');
    await writeFile(subtitlePath, toAss(timing.cues, DEFAULT_CAPTION_STYLE, { width, height }), 'utf8');
  }

  // --- 5. Render -----------------------------------------------------------
  const scenes: SlideshowScene[] = content.scenes.map((_, index) => ({
    imagePath: visuals[index] as string,
    audioPath: narration[index]?.path ?? null,
    durationSec: timing.durations[index] ?? 3,
  }));

  const videoPath = path.join(options.workDir, 'video.mp4');
  const command = buildSlideshowCommand({
    scenes,
    outputPath: videoPath,
    width,
    height,
    fps,
    subtitlePath,
    fontsDir: options.fontsDir,
    musicPath: options.musicPath,
    kenBurns: options.kenBurns,
    transitionSec: options.transitionSec ?? 0.4,
  });

  report('render', STAGE_START.render, 'Rendering the video');
  log.info('rendering faceless video', {
    scenes: scenes.length,
    durationSec: command.durationSec,
  });

  await ffmpeg(command.args, {
    signal: options.signal,
    totalDurationSec: command.durationSec,
    onProgress: (share) => {
      report(
        'render',
        STAGE_START.render + share * (STAGE_START.done - STAGE_START.render),
        `Rendering ${Math.round(share * 100)}%`,
      );
    },
  });

  report('done', 1, 'Finished');

  return {
    videoPath,
    content,
    durationSec: command.durationSec,
    sceneCount: scenes.length,
    filterGraph: command.filterGraph,
  };
}
