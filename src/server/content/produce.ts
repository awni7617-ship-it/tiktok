import path from 'node:path';
import { imageProvider, scriptProvider, voiceProvider } from '../ai/registry';
import { renderVideo } from '../video/render';
import { hasFfmpeg } from '../video/ffmpeg';
import { ensureDir, relativeToData, videoDir } from '../store/paths';
import { getChannel, updateVideo } from '../store/db';
import { artStyle, musicBed, niche } from '@/lib/catalog';
import type { TimelineScene } from '../video/filtergraph';
import type { Video, VideoStatus } from '@/lib/types';

/**
 * Idea → finished mp4.
 *
 * Each stage writes its status back before starting, so a video stuck at
 * "generating visuals" tells you which provider is hanging. Intermediate files
 * are kept in the video's own directory rather than a temp dir: a failed
 * render is much easier to diagnose when the images and audio it got as far as
 * are still sitting there.
 */

async function stage(videoId: string, status: VideoStatus): Promise<void> {
  await updateVideo(videoId, { status });
}

export async function produceVideo(video: Video): Promise<void> {
  const channel = await getChannel(video.channelId);
  if (!channel) throw new Error('The channel this video belongs to no longer exists');

  if (!(await hasFfmpeg())) {
    throw new Error('ffmpeg is not available, so rendering cannot run');
  }

  const dir = videoDir(video.id);
  await ensureDir(dir);

  const nicheDef = niche(channel.nicheId);
  const style = artStyle(channel.styleId);

  // --- Script -------------------------------------------------------------
  await stage(video.id, 'writing');

  const script =
    video.script ??
    (await (await scriptProvider()).write({
      idea: video.idea ?? `something worth knowing about ${nicheDef?.name ?? 'this topic'}`,
      brief: nicheDef?.brief ?? 'A general-interest short-form video.',
      targetSeconds: channel.targetSeconds,
    }));

  await updateVideo(video.id, { script, title: script.hook });

  // --- Narration ----------------------------------------------------------
  // Voiced before the images are drawn, because the measured audio length is
  // what every later timing decision keys off — the images cannot be timed
  // until the voice exists.
  await stage(video.id, 'narrating');

  const voice = await voiceProvider();
  const durations: number[] = [];

  for (const [index, scene] of script.scenes.entries()) {
    const audioFile = path.join(dir, `scene-${index}.${voice.name === 'offline' ? 'wav' : 'mp3'}`);
    const seconds = await voice.speak({
      text: scene.narration,
      voiceId: channel.voiceId,
      outFile: audioFile,
    });
    durations.push(seconds);
  }

  // --- Visuals ------------------------------------------------------------
  await stage(video.id, 'illustrating');

  const images = await imageProvider(channel.styleId);
  const imageFiles: string[] = [];

  for (const [index, scene] of script.scenes.entries()) {
    const imageFile = path.join(dir, `scene-${index}.png`);
    await images.draw({
      prompt: scene.visual,
      style: style?.prompt ?? '',
      outFile: imageFile,
      seed: index + 1,
    });
    imageFiles.push(imageFile);
  }

  // --- Render -------------------------------------------------------------
  await stage(video.id, 'rendering');

  const timeline: TimelineScene[] = script.scenes.map((scene, index) => ({
    image: imageFiles[index]!,
    audio: path.join(dir, `scene-${index}.${voice.name === 'offline' ? 'wav' : 'mp3'}`),
    seconds: durations[index]!,
    narration: scene.narration,
  }));

  const outFile = path.join(dir, 'final.mp4');
  const result = await renderVideo(timeline, musicBed(channel.musicId ?? '') ?? null, outFile);

  await updateVideo(video.id, {
    status: 'ready',
    file: relativeToData(result.file),
    durationSeconds: result.durationSeconds,
    script: {
      ...script,
      scenes: script.scenes.map((scene, index) => ({ ...scene, seconds: durations[index]! })),
    },
    error: null,
  });
}
