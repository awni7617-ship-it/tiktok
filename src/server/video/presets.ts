import type { AspectRatio, ExportPreset, PlatformId } from '@/lib/types';

/** Numeric value of each supported aspect ratio, as width/height. */
export const ASPECT_VALUES: Record<AspectRatio, number> = {
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '16:9': 16 / 9,
};

/**
 * Export presets.
 *
 * Bitrates target the quality ceiling each platform actually re-encodes to —
 * uploading a 40Mbps master to TikTok wastes upload time and gains nothing,
 * but under-shooting visibly hurts. CRF is the primary quality control with
 * the bitrate acting as a cap.
 */
export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'vertical-1080',
    label: 'Vertical 1080×1920 · 30fps',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrateKbps: 8000,
    audioBitrateKbps: 192,
    container: 'mp4',
    videoCodec: 'h264',
    crf: 20,
  },
  {
    id: 'vertical-1080-60',
    label: 'Vertical 1080×1920 · 60fps',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    fps: 60,
    videoBitrateKbps: 12000,
    audioBitrateKbps: 192,
    container: 'mp4',
    videoCodec: 'h264',
    crf: 20,
  },
  {
    id: 'vertical-720',
    label: 'Vertical 720×1280 · 30fps',
    aspect: '9:16',
    width: 720,
    height: 1280,
    fps: 30,
    videoBitrateKbps: 4500,
    audioBitrateKbps: 128,
    container: 'mp4',
    videoCodec: 'h264',
    crf: 22,
  },
  {
    id: 'square-1080',
    label: 'Square 1080×1080 · 30fps',
    aspect: '1:1',
    width: 1080,
    height: 1080,
    fps: 30,
    videoBitrateKbps: 6000,
    audioBitrateKbps: 192,
    container: 'mp4',
    videoCodec: 'h264',
    crf: 20,
  },
  {
    id: 'portrait-4x5',
    label: 'Portrait 1080×1350 · 30fps',
    aspect: '4:5',
    width: 1080,
    height: 1350,
    fps: 30,
    videoBitrateKbps: 7000,
    audioBitrateKbps: 192,
    container: 'mp4',
    videoCodec: 'h264',
    crf: 20,
  },
  {
    id: 'landscape-1080',
    label: 'Landscape 1920×1080 · 30fps',
    aspect: '16:9',
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrateKbps: 10000,
    audioBitrateKbps: 192,
    container: 'mp4',
    videoCodec: 'h264',
    crf: 20,
  },
  {
    id: 'landscape-4k',
    label: 'Landscape 3840×2160 · 30fps',
    aspect: '16:9',
    width: 3840,
    height: 2160,
    fps: 30,
    videoBitrateKbps: 35000,
    audioBitrateKbps: 256,
    container: 'mp4',
    videoCodec: 'h264',
    crf: 19,
  },
  {
    id: 'vertical-webm',
    label: 'Vertical 1080×1920 · VP9 (web)',
    aspect: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrateKbps: 5000,
    audioBitrateKbps: 128,
    container: 'webm',
    videoCodec: 'vp9',
    crf: 31,
  },
];

export function getPreset(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((preset) => preset.id === id);
}

export function presetsForAspect(aspect: AspectRatio): ExportPreset[] {
  return EXPORT_PRESETS.filter((preset) => preset.aspect === aspect);
}

/** Default preset each platform should receive when the user has no preference. */
export const PLATFORM_DEFAULT_PRESET: Record<PlatformId, string> = {
  tiktok: 'vertical-1080',
  youtube: 'vertical-1080',
  instagram: 'vertical-1080',
  facebook: 'vertical-1080',
  linkedin: 'square-1080',
  pinterest: 'portrait-4x5',
  x: 'landscape-1080',
};

/** Thumbnail sizes generated alongside every render. */
export const THUMBNAIL_SIZES = [
  { id: 'poster', width: 1080, height: 1920 },
  { id: 'card', width: 640, height: 1138 },
  { id: 'preview', width: 320, height: 569 },
] as const;
