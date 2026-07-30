import type { MediaProbe, VideoEnhancePlan } from '@/lib/types';
import { clamp, round } from '@/lib/time';

/**
 * Video enhancement planning.
 *
 * "Enhance" is easy to overdo — oversharpened, oversaturated video reads as
 * amateurish and platform compression punishes it. The rule here is that
 * enhancement only fires when a measurement says the source is deficient, and
 * the strength is proportional to the deficit.
 */

export interface EnhanceOptions {
  /** Upscale sources below this height to the target. */
  minHeight: number;
  /** Never upscale beyond this many pixels of height. */
  maxUpscaleHeight: number;
  /** Global intensity multiplier in `[0, 1]`; 0 disables enhancement. */
  intensity: number;
  /** Denoise low-bitrate sources to suppress blocking artifacts. */
  denoiseLowBitrate: boolean;
}

export const DEFAULT_ENHANCE_OPTIONS: EnhanceOptions = {
  minHeight: 720,
  maxUpscaleHeight: 1920,
  intensity: 0.6,
  denoiseLowBitrate: true,
};

/**
 * Bits per pixel per frame — the standard way to judge whether a stream is
 * under-bitrated for its resolution. Below ~0.06 bpp, h264 shows visible
 * blocking on motion.
 */
export function bitsPerPixel(probe: MediaProbe): number | null {
  if (!probe.bitrateKbps || probe.width <= 0 || probe.height <= 0 || probe.fps <= 0) {
    return null;
  }
  return round((probe.bitrateKbps * 1000) / (probe.width * probe.height * probe.fps), 4);
}

export function planEnhancement(
  probe: MediaProbe,
  options: Partial<EnhanceOptions> = {},
): VideoEnhancePlan {
  const opts = { ...DEFAULT_ENHANCE_OPTIONS, ...options };
  const notes: string[] = [];

  if (opts.intensity <= 0) {
    return {
      denoise: false,
      sharpen: 0,
      saturation: 1,
      contrast: 1,
      brightness: 0,
      upscaleTo: null,
      notes: ['Enhancement disabled.'],
    };
  }

  const bpp = bitsPerPixel(probe);
  const isLowBitrate = bpp !== null && bpp < 0.06;

  const denoise = opts.denoiseLowBitrate && isLowBitrate;
  if (denoise) {
    notes.push(`Light denoise — ${bpp} bits/pixel suggests compression artifacts.`);
  }

  // Sharpening compensates for softness introduced by upscaling and by low
  // bitrate. Both together still stay well under the "crunchy" threshold.
  let sharpen = 0;
  if (isLowBitrate) sharpen += 0.35;

  let upscaleTo: VideoEnhancePlan['upscaleTo'] = null;
  if (probe.height > 0 && probe.height < opts.minHeight) {
    const targetHeight = Math.min(opts.minHeight, opts.maxUpscaleHeight);
    const scale = targetHeight / probe.height;
    // Keep dimensions even; most encoders require it.
    const targetWidth = Math.round((probe.width * scale) / 2) * 2;
    upscaleTo = { width: targetWidth, height: targetHeight };
    sharpen += 0.4;
    notes.push(`Upscaling ${probe.width}×${probe.height} → ${targetWidth}×${targetHeight}.`);
  }

  sharpen = round(clamp(sharpen, 0, 1) * opts.intensity, 2);
  if (sharpen > 0 && upscaleTo === null && !denoise) {
    notes.push('Source is clean — sharpening left off.');
  }

  // A small saturation and contrast lift makes video read better on phone
  // screens in daylight. Deliberately subtle: 1.06 is perceptible, 1.3 is not
  // a filter anyone asked for.
  const saturation = round(1 + 0.08 * opts.intensity, 3);
  const contrast = round(1 + 0.05 * opts.intensity, 3);

  if (saturation > 1) {
    notes.push('Subtle saturation and contrast lift for small-screen viewing.');
  }

  return {
    denoise,
    sharpen,
    saturation,
    contrast,
    brightness: 0,
    upscaleTo,
    notes,
  };
}
