import type { AudioAnalysis, Cut, TimeRange, Transcript } from '@/lib/types';
import { mergeRanges, round } from '@/lib/time';

/**
 * Silence and dead-air detection.
 *
 * Two independent sources feed this: the loudness envelope from ffmpeg
 * (`astats`), and the gaps between words in the transcript. The envelope
 * catches non-speech dead air; the transcript catches pauses that are quiet but
 * still above the noise floor (breathing, room tone). Using both means neither
 * a noisy room nor a missing transcript disables the feature.
 */

export interface SilenceOptions {
  /** Anything quieter than this many dB below the noise floor counts as silence. */
  thresholdDb: number;
  /** Ignore silences shorter than this — cutting them produces audible clicks. */
  minSilenceSec: number;
  /**
   * Leave this much silence in place at each end of a cut. Removing a pause
   * entirely makes speech sound clipped and unnatural; a short breath reads as
   * intentional tightening.
   */
  paddingSec: number;
  /** Never cut so aggressively that a gap shorter than this remains. */
  minKeepSec: number;
  /** Treat pauses longer than this as "long-pause" cuts with higher confidence. */
  longPauseSec: number;
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  thresholdDb: -34,
  minSilenceSec: 0.35,
  paddingSec: 0.08,
  minKeepSec: 0.06,
  longPauseSec: 1.2,
};

/**
 * Estimate the noise floor as the 10th percentile of frame loudness. Using a
 * low percentile rather than the minimum makes the estimate robust to a single
 * digital-silence frame at the head of the file.
 */
export function estimateNoiseFloor(frames: AudioAnalysis['frames']): number {
  if (frames.length === 0) return -70;
  const sorted = frames.map((f) => f.db).sort((a, b) => a - b);
  const index = Math.floor(sorted.length * 0.1);
  return sorted[Math.min(index, sorted.length - 1)] ?? -70;
}

/**
 * Walk the loudness envelope and return every run of frames below the
 * threshold. The threshold is anchored to the measured noise floor so a
 * hissy recording does not report the entire take as silence.
 */
export function detectSilenceFromEnvelope(
  analysis: AudioAnalysis,
  options: Partial<SilenceOptions> = {},
): TimeRange[] {
  const opts = { ...DEFAULT_SILENCE_OPTIONS, ...options };
  const frames = analysis.frames;
  if (frames.length < 2) return [];

  const noiseFloor = Number.isFinite(analysis.noiseFloorDb)
    ? analysis.noiseFloorDb
    : estimateNoiseFloor(frames);

  // Sit above the noise floor, but never above the absolute threshold: a very
  // clean recording (floor at -80) should not treat -46dB speech as silence.
  const threshold = Math.min(opts.thresholdDb, noiseFloor + 12);

  const ranges: TimeRange[] = [];
  let runStart: number | null = null;

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const isQuiet = frame.db <= threshold;

    if (isQuiet && runStart === null) {
      runStart = frame.time;
    } else if (!isQuiet && runStart !== null) {
      if (frame.time - runStart >= opts.minSilenceSec) {
        ranges.push({ start: runStart, end: frame.time });
      }
      runStart = null;
    }
  }

  if (runStart !== null) {
    const last = frames[frames.length - 1]!;
    if (last.time - runStart >= opts.minSilenceSec) {
      ranges.push({ start: runStart, end: last.time });
    }
  }

  return ranges;
}

/** Gaps between consecutive spoken words, plus any lead-in and tail. */
export function detectSilenceFromTranscript(
  transcript: Transcript,
  options: Partial<SilenceOptions> = {},
): TimeRange[] {
  const opts = { ...DEFAULT_SILENCE_OPTIONS, ...options };
  const words = transcript.words;
  const ranges: TimeRange[] = [];

  const first = words[0];
  if (first && first.start >= opts.minSilenceSec) {
    ranges.push({ start: 0, end: first.start });
  }

  for (let i = 1; i < words.length; i++) {
    const previous = words[i - 1]!;
    const current = words[i]!;
    const gap = current.start - previous.end;
    if (gap >= opts.minSilenceSec) {
      ranges.push({ start: previous.end, end: current.start });
    }
  }

  const last = words[words.length - 1];
  if (last && transcript.durationSec - last.end >= opts.minSilenceSec) {
    ranges.push({ start: last.end, end: transcript.durationSec });
  }

  return ranges;
}

/**
 * Shrink each silence by `paddingSec` on both sides and drop anything that no
 * longer clears `minSilenceSec`. This is what turns "detected silence" into
 * "safe to cut".
 */
export function padAndFilterSilences(
  ranges: TimeRange[],
  options: Partial<SilenceOptions> = {},
): TimeRange[] {
  const opts = { ...DEFAULT_SILENCE_OPTIONS, ...options };
  const result: TimeRange[] = [];

  for (const range of ranges) {
    const start = range.start + opts.paddingSec;
    const end = range.end - opts.paddingSec;
    if (end - start >= opts.minKeepSec) {
      result.push({ start: round(start), end: round(end) });
    }
  }

  return result;
}

/**
 * Full silence pass: combine both detectors, pad, and label each result.
 *
 * When both sources are available they are intersected rather than unioned —
 * a region must be both acoustically quiet *and* free of transcribed words to
 * be cut. That conservative choice is what stops the editor from deleting a
 * quietly delivered but important line.
 */
export function detectSilence(
  input: { transcript?: Transcript; audio?: AudioAnalysis; durationSec: number },
  options: Partial<SilenceOptions> = {},
): Cut[] {
  const opts = { ...DEFAULT_SILENCE_OPTIONS, ...options };

  const fromAudio = input.audio ? detectSilenceFromEnvelope(input.audio, opts) : null;
  const fromText = input.transcript ? detectSilenceFromTranscript(input.transcript, opts) : null;

  let candidates: TimeRange[];
  if (fromAudio && fromText) {
    candidates = intersectRanges(fromAudio, fromText);
  } else {
    candidates = fromAudio ?? fromText ?? [];
  }

  const padded = padAndFilterSilences(mergeRanges(candidates, 0.05), opts);

  return padded.map((range) => {
    const length = range.end - range.start;
    const isLong = length >= opts.longPauseSec;
    return {
      start: range.start,
      end: range.end,
      reason: isLong ? ('long-pause' as const) : ('silence' as const),
      // Longer silences are more obviously dead air, so we trust them more.
      confidence: Math.min(0.98, 0.6 + length * 0.25),
      note: isLong
        ? `${length.toFixed(1)}s pause`
        : `${Math.round(length * 1000)}ms of silence`,
    };
  });
}

/** Pairwise intersection of two sorted, disjoint range sets. */
export function intersectRanges(a: TimeRange[], b: TimeRange[]): TimeRange[] {
  const left = mergeRanges(a);
  const right = mergeRanges(b);
  const result: TimeRange[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    const x = left[i]!;
    const y = right[j]!;
    const start = Math.max(x.start, y.start);
    const end = Math.min(x.end, y.end);
    if (end > start) result.push({ start, end });

    if (x.end < y.end) i += 1;
    else j += 1;
  }

  return result;
}
