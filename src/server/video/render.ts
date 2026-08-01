import fs from 'node:fs/promises';
import path from 'node:path';
import { buildRenderCommand, sceneStarts, type TimelineScene } from './filtergraph';
import { hasFilter, runFfmpeg } from './ffmpeg';
import { buildAssSubtitles } from './captions';
import { ensureDir } from '../store/paths';
import { FRAME_HEIGHT, FRAME_WIDTH } from '../ai/types';
import type { MusicBed } from '@/lib/catalog';

export interface RenderResult {
  file: string;
  durationSeconds: number;
}

/**
 * Write the caption track next to the video.
 *
 * Returns null when this ffmpeg has no `subtitles` filter, in which case the
 * video renders without captions rather than not rendering at all. Losing
 * captions is bad; losing the video is worse.
 */
async function writeSubtitles(
  scenes: TimelineScene[],
  dir: string,
): Promise<string | null> {
  if (!(await hasFilter('subtitles'))) {
    console.warn('[render] this ffmpeg has no subtitles filter — rendering without captions');
    return null;
  }

  const starts = sceneStarts(scenes);
  const entries = scenes.map((scene, index) => ({
    narration: scene.narration,
    start: starts[index]!,
    seconds: scene.seconds,
  }));

  const file = path.join(dir, 'captions.ass');
  await fs.writeFile(file, buildAssSubtitles(entries, FRAME_WIDTH, FRAME_HEIGHT), 'utf8');
  return file;
}

/** Compose the scenes into a finished vertical mp4. */
export async function renderVideo(
  scenes: TimelineScene[],
  music: MusicBed | null,
  outFile: string,
): Promise<RenderResult> {
  const dir = path.dirname(outFile);
  await ensureDir(dir);

  const { args, duration } = buildRenderCommand({
    scenes,
    music,
    outFile,
    subtitleFile: await writeSubtitles(scenes, dir),
  });

  // Generous: a 60-second video with a dozen scenes is a few minutes of
  // encoding on a laptop, and killing a nearly-finished render is worse than
  // waiting.
  await runFfmpeg(args, 20 * 60_000);

  const stat = await fs.stat(outFile).catch(() => null);
  if (!stat || stat.size === 0) {
    throw new Error('ffmpeg reported success but produced no output file');
  }

  return { file: outFile, durationSeconds: duration };
}
