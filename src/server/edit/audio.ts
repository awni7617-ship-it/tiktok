import type { AudioAnalysis, AudioPlan, LoudnessFrame, MediaProbe } from '@/lib/types';
import { clamp, round } from '@/lib/time';

/**
 * Audio cleanup planning.
 *
 * Every decision here is derived from measurements rather than applied blindly:
 * denoising clean audio smears consonants, and compressing already-compressed
 * audio pumps. The plan records *why* each processor was enabled so the UI can
 * show it and the user can override.
 */

/** Loudness targets per destination. Platforms normalise to roughly these. */
export const LOUDNESS_TARGETS = {
  tiktok: { lufs: -14, truePeak: -1 },
  youtube: { lufs: -14, truePeak: -1 },
  instagram: { lufs: -14, truePeak: -1 },
  facebook: { lufs: -16, truePeak: -1 },
  linkedin: { lufs: -14, truePeak: -1 },
  pinterest: { lufs: -14, truePeak: -1 },
  x: { lufs: -14, truePeak: -1 },
  broadcast: { lufs: -23, truePeak: -2 },
} as const;

export type LoudnessTarget = keyof typeof LOUDNESS_TARGETS;

export interface AudioPlanOptions {
  target: LoudnessTarget;
  /** Force denoise on/off; `null` lets the analysis decide. */
  denoise: boolean | null;
  /** Enable de-essing when sibilance is likely (bright mic, close-mic'd). */
  deEss: boolean | null;
  /** Roll off rumble below this frequency. `null` disables the filter. */
  highPassHz: number | null;
}

export const DEFAULT_AUDIO_PLAN_OPTIONS: AudioPlanOptions = {
  target: 'tiktok',
  denoise: null,
  deEss: null,
  highPassHz: 80,
};

/**
 * Signal-to-noise estimate in dB: the gap between typical speech level and the
 * noise floor. Below ~18dB a listener notices hiss; below 12dB it is
 * distracting and denoising is clearly worth its artifacts.
 */
export function estimateSnr(analysis: AudioAnalysis): number {
  const frames = analysis.frames;
  if (frames.length === 0) return 40;

  const sorted = frames.map((f) => f.db).sort((a, b) => a - b);
  const percentile = (p: number) => sorted[clamp(Math.floor(sorted.length * p), 0, sorted.length - 1)] ?? -60;

  // 85th percentile approximates speech level without being skewed by transients.
  const speech = percentile(0.85);
  const floor = Number.isFinite(analysis.noiseFloorDb) ? analysis.noiseFloorDb : percentile(0.1);
  return round(speech - floor, 1);
}

/** Peak-to-loudness ratio. A very wide range benefits from gentle compression. */
export function dynamicRange(analysis: AudioAnalysis): number {
  return round(analysis.truePeakDb - analysis.integratedLufs, 1);
}

export function planAudio(
  analysis: AudioAnalysis,
  probe: MediaProbe | null,
  options: Partial<AudioPlanOptions> = {},
): AudioPlan {
  const opts = { ...DEFAULT_AUDIO_PLAN_OPTIONS, ...options };
  const target = LOUDNESS_TARGETS[opts.target];
  const notes: string[] = [];

  const snr = estimateSnr(analysis);
  const range = dynamicRange(analysis);

  const shouldDenoise = opts.denoise ?? snr < 18;
  // Map SNR onto afftdn's noise-reduction amount: worse SNR, stronger reduction,
  // capped at 18dB because beyond that speech starts sounding underwater.
  const denoiseStrength = shouldDenoise ? round(clamp(24 - snr, 6, 18), 1) : 0;

  if (shouldDenoise) {
    notes.push(`Noise reduction at ${denoiseStrength}dB — measured SNR ${snr}dB.`);
  } else {
    notes.push(`Skipping denoise — SNR ${snr}dB is already clean.`);
  }

  const gainNeeded = round(target.lufs - analysis.integratedLufs, 1);
  if (Math.abs(gainNeeded) >= 0.5) {
    notes.push(
      `Normalising ${gainNeeded > 0 ? '+' : ''}${gainNeeded} LU to hit ${target.lufs} LUFS.`,
    );
  } else {
    notes.push(`Loudness already within 0.5 LU of ${target.lufs} LUFS.`);
  }

  if (analysis.truePeakDb > target.truePeak) {
    notes.push(`Limiting true peak from ${analysis.truePeakDb} to ${target.truePeak} dBTP.`);
  }

  // Compress only when the range is genuinely wide; ratios stay gentle so
  // narration keeps its natural dynamics.
  let compressorRatio: number | null = null;
  if (range > 16) {
    compressorRatio = round(clamp(1 + (range - 16) / 8, 1.5, 4), 1);
    notes.push(`Gentle ${compressorRatio}:1 compression — ${range}dB peak-to-loudness range.`);
  }

  const shouldDeEss = opts.deEss ?? ((probe?.audioSampleRate ?? 48000) >= 44100 && snr > 20);
  if (shouldDeEss) notes.push('De-esser engaged for close-mic sibilance.');

  if (opts.highPassHz) notes.push(`High-pass at ${opts.highPassHz}Hz to remove rumble.`);

  return {
    denoise: shouldDenoise,
    denoiseStrength,
    targetLufs: target.lufs,
    targetTruePeakDb: target.truePeak,
    loudnessRangeLu: 11,
    deEss: shouldDeEss,
    highPassHz: opts.highPassHz,
    compressorRatio,
    notes,
  };
}

/**
 * Parse `ffmpeg -af astats=metadata=1:reset=1 -f null -` output into a
 * loudness envelope. The filter prints one block per window; we take the RMS
 * level of the overall channel and pair it with the frame's pts time.
 */
export function parseAstats(output: string, windowSec = 0.05): LoudnessFrame[] {
  const frames: LoudnessFrame[] = [];
  const lines = output.split('\n');

  let pendingTime: number | null = null;

  for (const line of lines) {
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch?.[1]) {
      pendingTime = Number.parseFloat(timeMatch[1]);
      continue;
    }

    const rmsMatch = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+|-inf)/);
    if (rmsMatch?.[1]) {
      const value = rmsMatch[1] === '-inf' ? -100 : Number.parseFloat(rmsMatch[1]);
      frames.push({
        time: round(pendingTime ?? frames.length * windowSec, 3),
        db: round(value, 2),
      });
      pendingTime = null;
    }
  }

  return frames;
}

/**
 * Parse the JSON block `ffmpeg -af loudnorm=print_format=json` writes to
 * stderr. Returns null when the block is absent or malformed so callers can
 * fall back to single-pass normalisation.
 */
export function parseLoudnorm(output: string): {
  integratedLufs: number;
  loudnessRangeLu: number;
  truePeakDb: number;
  thresholdDb: number;
  offsetDb: number;
} | null {
  const match = output.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[0]) as Record<string, string>;
    const num = (key: string, fallback: number) => {
      const raw = parsed[key];
      if (raw === undefined) return fallback;
      const value = Number.parseFloat(raw);
      return Number.isFinite(value) ? value : fallback;
    };

    return {
      integratedLufs: num('input_i', -23),
      loudnessRangeLu: num('input_lra', 7),
      truePeakDb: num('input_tp', -2),
      thresholdDb: num('input_thresh', -34),
      offsetDb: num('target_offset', 0),
    };
  } catch {
    return null;
  }
}

/** Build a complete `AudioAnalysis` from raw ffmpeg output. */
export function buildAudioAnalysis(
  astatsOutput: string,
  loudnormOutput: string,
): AudioAnalysis {
  const frames = parseAstats(astatsOutput);
  const loudnorm = parseLoudnorm(loudnormOutput);

  const sorted = frames.map((f) => f.db).sort((a, b) => a - b);
  const noiseFloor = sorted.length > 0
    ? sorted[Math.floor(sorted.length * 0.1)] ?? -70
    : -70;

  return {
    frames,
    integratedLufs: loudnorm?.integratedLufs ?? -23,
    loudnessRangeLu: loudnorm?.loudnessRangeLu ?? 7,
    truePeakDb: loudnorm?.truePeakDb ?? -2,
    noiseFloorDb: round(noiseFloor, 2),
  };
}
