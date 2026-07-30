import type { CutPlan, KeptSegment, Transcript } from '@/lib/types';
import { clamp, round } from '@/lib/time';
import { relayout } from './cutplan';

/**
 * Pacing analysis and retiming.
 *
 * Short-form retention drops hardest during slow stretches, so the engine
 * measures speaking rate over a sliding window and gently speeds up the
 * sections that lag. Speed changes are capped and smoothed: anything above
 * ~1.15x on speech becomes audibly chipmunked even with pitch correction.
 */

export interface PacingOptions {
  /** Words per minute the edit aims for. 165 is brisk but natural. */
  targetWpm: number;
  /** Sliding window used to measure local speaking rate. */
  windowSec: number;
  /** Hard bounds on the retime factor applied to any segment. */
  maxSpeed: number;
  minSpeed: number;
  /** Only retime segments at least this long; short ones cause artifacts. */
  minSegmentSec: number;
}

export const DEFAULT_PACING_OPTIONS: PacingOptions = {
  targetWpm: 165,
  windowSec: 6,
  maxSpeed: 1.15,
  minSpeed: 0.92,
  minSegmentSec: 1.5,
};

export interface PacingSample {
  start: number;
  end: number;
  wpm: number;
  /** Suggested speed multiplier to bring this window onto target. */
  suggestedSpeed: number;
}

export interface PacingAnalysis {
  samples: PacingSample[];
  averageWpm: number;
  /** Standard deviation of local WPM; high values mean uneven delivery. */
  variability: number;
  /** Stretches meaningfully slower than target. */
  slowSections: { start: number; end: number; wpm: number }[];
  /** 0-100 score where 100 is perfectly on-target and even. */
  score: number;
}

/** Measure speaking rate across the take with a sliding window. */
export function analyzePacing(
  transcript: Transcript,
  options: Partial<PacingOptions> = {},
): PacingAnalysis {
  const opts = { ...DEFAULT_PACING_OPTIONS, ...options };
  const words = transcript.words;

  if (words.length < 2) {
    return {
      samples: [],
      averageWpm: 0,
      variability: 0,
      slowSections: [],
      score: 50,
    };
  }

  const samples: PacingSample[] = [];
  const step = opts.windowSec / 2;
  const end = transcript.durationSec;

  for (let start = 0; start < end; start += step) {
    const windowEnd = Math.min(start + opts.windowSec, end);
    if (windowEnd - start < 1) break;

    const inWindow = words.filter((w) => w.start >= start && w.start < windowEnd);
    const wpm = (inWindow.length / (windowEnd - start)) * 60;

    samples.push({
      start: round(start),
      end: round(windowEnd),
      wpm: round(wpm, 1),
      suggestedSpeed:
        wpm > 0
          ? round(clamp(opts.targetWpm / wpm, opts.minSpeed, opts.maxSpeed), 3)
          : 1,
    });
  }

  const rates = samples.map((s) => s.wpm).filter((wpm) => wpm > 0);
  const averageWpm = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const variance =
    rates.length > 0
      ? rates.reduce((sum, wpm) => sum + (wpm - averageWpm) ** 2, 0) / rates.length
      : 0;
  const variability = Math.sqrt(variance);

  const slowThreshold = opts.targetWpm * 0.72;
  const slowSections = mergeAdjacent(
    samples.filter((s) => s.wpm > 0 && s.wpm < slowThreshold),
  ).map((s) => ({ start: s.start, end: s.end, wpm: s.wpm }));

  // Penalise both being off-target and being uneven.
  const offTarget = Math.abs(averageWpm - opts.targetWpm) / opts.targetWpm;
  const unevenness = variability / Math.max(opts.targetWpm, 1);
  const score = clamp(100 - offTarget * 120 - unevenness * 80, 0, 100);

  return {
    samples,
    averageWpm: round(averageWpm, 1),
    variability: round(variability, 1),
    slowSections,
    score: round(score, 1),
  };
}

function mergeAdjacent(samples: PacingSample[]): PacingSample[] {
  const merged: PacingSample[] = [];
  for (const sample of samples) {
    const previous = merged[merged.length - 1];
    if (previous && sample.start <= previous.end + 0.01) {
      previous.end = sample.end;
      previous.wpm = round((previous.wpm + sample.wpm) / 2, 1);
    } else {
      merged.push({ ...sample });
    }
  }
  return merged;
}

/**
 * Apply pacing-driven speed changes to a cut plan.
 *
 * Each kept segment takes the speed suggested by the pacing windows it
 * overlaps. Speeds are then smoothed across neighbours so the viewer never
 * hears an abrupt tempo jump at a cut point.
 */
export function applyPacing(
  plan: CutPlan,
  analysis: PacingAnalysis,
  options: Partial<PacingOptions> = {},
): CutPlan {
  const opts = { ...DEFAULT_PACING_OPTIONS, ...options };
  if (analysis.samples.length === 0) return plan;

  const speeds = plan.kept.map((segment) => {
    const length = segment.sourceEnd - segment.sourceStart;
    if (length < opts.minSegmentSec) return 1;

    const overlapping = analysis.samples.filter(
      (sample) => sample.start < segment.sourceEnd && sample.end > segment.sourceStart,
    );
    if (overlapping.length === 0) return 1;

    // Weight each window by how much of the segment it covers.
    let weighted = 0;
    let totalWeight = 0;
    for (const sample of overlapping) {
      const weight =
        Math.min(sample.end, segment.sourceEnd) - Math.max(sample.start, segment.sourceStart);
      if (weight <= 0) continue;
      weighted += sample.suggestedSpeed * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weighted / totalWeight : 1;
  });

  const smoothed = smoothSpeeds(speeds, opts);

  const kept: KeptSegment[] = plan.kept.map((segment, index) => ({
    ...segment,
    speed: round(smoothed[index] ?? 1, 3),
  }));

  const relaid = relayout(kept);
  const outputDuration = relaid.reduce(
    (sum, segment) => sum + (segment.sourceEnd - segment.sourceStart) / segment.speed,
    0,
  );

  return {
    ...plan,
    kept: relaid,
    outputDurationSec: round(outputDuration),
    removedSec: round(plan.sourceDurationSec - outputDuration),
  };
}

/** Single-pass moving average that also clamps to the configured bounds. */
function smoothSpeeds(speeds: number[], opts: PacingOptions): number[] {
  return speeds.map((speed, index) => {
    const previous = speeds[index - 1] ?? speed;
    const next = speeds[index + 1] ?? speed;
    const averaged = previous * 0.25 + speed * 0.5 + next * 0.25;
    return clamp(averaged, opts.minSpeed, opts.maxSpeed);
  });
}
