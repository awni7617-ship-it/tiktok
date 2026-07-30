import type {
  AudioAnalysis,
  ClipVariation,
  Moment,
  MomentSignal,
  TimeRange,
  Transcript,
  TranscriptSegment,
} from '@/lib/types';
import { clamp, round } from '@/lib/time';
import { normalizeWord, sentences } from '@/lib/text';
import { shortHash } from '@/lib/id';

/**
 * Engagement detection: find the moments in a take that are worth clipping.
 *
 * The scorer is deliberately explainable. Every signal contributes a named,
 * bounded amount to the composite score, and the breakdown travels with the
 * moment so the UI can answer "why did you pick this?" — which matters more
 * for user trust than squeezing out a marginally better ranking.
 */

/** Openers that promise a payoff. Strong retention predictors in short-form. */
const HOOK_PATTERNS: RegExp[] = [
  /\bhere('s| is) (why|how|what)\b/i,
  /\bthe (real|only|biggest|number one) (reason|problem|secret|mistake)\b/i,
  /\bnobody (tells|talks about|knows)\b/i,
  /\bmost people (don't|do not|never)\b/i,
  /\bwhat (if|nobody|they don't)\b/i,
  /\byou('re| are) (doing|using|making) .{0,24}(wrong|mistake)\b/i,
  /\bstop\b.{0,20}\b(doing|using|scrolling)\b/i,
  /\bi (was|used to be|couldn't|didn't)\b/i,
  /\blet me (show|tell|explain)\b/i,
  /\b(this|that) (changed|ruined|saved) (my|everything)\b/i,
];

/** Words that signal a payoff or resolution — good clip endings. */
const PAYOFF_PATTERNS: RegExp[] = [
  /\b(so|and) (that('s| is) why|here('s| is) what happened)\b/i,
  /\bturns out\b/i,
  /\bthe (result|answer|truth|point) (is|was)\b/i,
  /\bin the end\b/i,
  /\bwhich means\b/i,
  /\bfinally\b/i,
];

/** Contrast markers create tension, which holds attention. */
const CONTRAST_PATTERNS: RegExp[] = [
  /\bbut (then|actually|here('s| is))\b/i,
  /\bhowever\b/i,
  /\binstead\b/i,
  /\bexcept\b/i,
  /\bthe problem is\b/i,
  /\buntil\b/i,
];

/** Emphatic vocabulary. Weighted low individually; meaningful in aggregate. */
const EMPHASIS_WORDS = new Set([
  'insane', 'crazy', 'unbelievable', 'shocking', 'massive', 'huge', 'never',
  'always', 'everyone', 'nobody', 'literally', 'exactly', 'perfect', 'terrible',
  'best', 'worst', 'incredible', 'wild', 'brutal', 'genius', 'secret', 'proof',
]);

const LIST_PATTERNS: RegExp[] = [
  /\b(first|second|third|finally|lastly)\b/i,
  /\b(step|tip|rule|reason) (one|two|three|\d)\b/i,
  /\b\d+ (ways|things|reasons|steps|tips|mistakes)\b/i,
];

export interface MomentOptions {
  /** Target clip length used to size the analysis window. */
  windowSec: number;
  /** Minimum composite score for a window to become a moment. */
  minScore: number;
  /** Maximum moments returned, highest scoring first. */
  limit: number;
}

export const DEFAULT_MOMENT_OPTIONS: MomentOptions = {
  windowSec: 12,
  minScore: 0.28,
  limit: 20,
};

interface SignalHit {
  signal: MomentSignal;
  weight: number;
}

/** Score one chunk of text, returning each signal that fired and its weight. */
export function scoreText(text: string): SignalHit[] {
  const hits: SignalHit[] = [];

  if (HOOK_PATTERNS.some((pattern) => pattern.test(text))) {
    hits.push({ signal: 'hook', weight: 0.3 });
  }
  if (PAYOFF_PATTERNS.some((pattern) => pattern.test(text))) {
    hits.push({ signal: 'payoff', weight: 0.22 });
  }
  if (CONTRAST_PATTERNS.some((pattern) => pattern.test(text))) {
    hits.push({ signal: 'contrast', weight: 0.16 });
  }
  if (LIST_PATTERNS.some((pattern) => pattern.test(text))) {
    hits.push({ signal: 'list', weight: 0.14 });
  }
  if (/\?/.test(text)) {
    hits.push({ signal: 'question', weight: 0.12 });
  }
  if (/\b\d+([.,]\d+)?%?\b/.test(text)) {
    hits.push({ signal: 'number', weight: 0.1 });
  }
  if (/\b(ha){2,}\b|\[laugh|\(laugh/i.test(text)) {
    hits.push({ signal: 'laughter', weight: 0.12 });
  }

  const emphasisCount = text
    .split(/\s+/)
    .filter((word) => EMPHASIS_WORDS.has(normalizeWord(word))).length;
  if (emphasisCount > 0) {
    hits.push({ signal: 'emphasis', weight: Math.min(0.18, emphasisCount * 0.06) });
  }

  // A short declarative sentence lands harder than a rambling one.
  const sentenceList = sentences(text);
  if (sentenceList.length > 0) {
    const averageWords =
      sentenceList.reduce((sum, s) => sum + s.split(/\s+/).length, 0) / sentenceList.length;
    if (averageWords <= 12) {
      hits.push({ signal: 'story-beat', weight: 0.08 });
    }
  }

  return hits;
}

/**
 * Audio energy contribution for a window: how much louder it is than the
 * programme average, normalised. Energetic delivery correlates with retention.
 */
export function scoreEnergy(audio: AudioAnalysis | undefined, range: TimeRange): number {
  if (!audio || audio.frames.length === 0) return 0;

  const inRange = audio.frames.filter((f) => f.time >= range.start && f.time < range.end);
  if (inRange.length === 0) return 0;

  const average = audio.frames.reduce((sum, f) => sum + f.db, 0) / audio.frames.length;
  const windowAverage = inRange.reduce((sum, f) => sum + f.db, 0) / inRange.length;

  // +6dB over the programme average is a strong emphasis; map that to the cap.
  return clamp((windowAverage - average) / 6, 0, 1) * 0.15;
}

/**
 * Slide a window across the transcript and score each position.
 *
 * Windows are anchored to sentence boundaries so clips never open or close
 * mid-thought — a purely time-based window produces technically high-scoring
 * clips that feel broken to a viewer.
 */
export function detectMoments(
  transcript: Transcript,
  audio?: AudioAnalysis,
  options: Partial<MomentOptions> = {},
): Moment[] {
  const opts = { ...DEFAULT_MOMENT_OPTIONS, ...options };
  if (transcript.segments.length === 0) return [];

  const candidates: Moment[] = [];

  for (let i = 0; i < transcript.segments.length; i++) {
    const window = collectWindow(transcript.segments, i, opts.windowSec);
    if (!window) continue;

    const hits = scoreText(window.text);
    const energy = scoreEnergy(audio, { start: window.start, end: window.end });

    const breakdown: Record<string, number> = {};
    for (const hit of hits) {
      breakdown[hit.signal] = round((breakdown[hit.signal] ?? 0) + hit.weight, 3);
    }
    if (energy > 0) breakdown['energy'] = round(energy, 3);

    // Openings get a bonus: the first 15s decides whether anyone watches at all.
    const positionBonus = window.start < 15 ? 0.08 : 0;
    if (positionBonus > 0) breakdown['opening'] = positionBonus;

    const raw = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
    const score = clamp(raw, 0, 1);
    if (score < opts.minScore) continue;

    const signals = [...new Set(hits.map((h) => h.signal))];
    if (energy > 0.06) signals.push('energy');

    candidates.push({
      start: round(window.start),
      end: round(window.end),
      score: round(score, 3),
      signals,
      text: window.text,
      breakdown,
    });
  }

  return dedupeMoments(candidates).slice(0, opts.limit);
}

function collectWindow(
  segments: TranscriptSegment[],
  startIndex: number,
  windowSec: number,
): { start: number; end: number; text: string } | null {
  const first = segments[startIndex];
  if (!first) return null;

  let end = first.end;
  const parts: string[] = [first.text];

  for (let i = startIndex + 1; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.end - first.start > windowSec) break;
    end = segment.end;
    parts.push(segment.text);
  }

  return { start: first.start, end, text: parts.join(' ').trim() };
}

/** Greedily keep the best moments, discarding anything that overlaps a winner by >50%. */
export function dedupeMoments(moments: Moment[]): Moment[] {
  const sorted = [...moments].sort((a, b) => b.score - a.score || a.start - b.start);
  const kept: Moment[] = [];

  for (const moment of sorted) {
    const length = moment.end - moment.start;
    const conflicts = kept.some((existing) => {
      const overlap =
        Math.min(existing.end, moment.end) - Math.max(existing.start, moment.start);
      return overlap > 0 && overlap / length > 0.5;
    });
    if (!conflicts) kept.push(moment);
  }

  return kept.sort((a, b) => b.score - a.score);
}

export interface VariationOptions {
  /** Target output lengths to generate variations for. */
  targetLengthsSec: number[];
  /** How many variations to return. */
  count: number;
  /** Absolute bounds enforced on every variation. */
  minLengthSec: number;
  maxLengthSec: number;
}

export const DEFAULT_VARIATION_OPTIONS: VariationOptions = {
  targetLengthsSec: [15, 30, 45],
  count: 5,
  minLengthSec: 8,
  maxLengthSec: 90,
};

/**
 * Build clip variations around the strongest moments.
 *
 * Each target length produces its own cut of the best moment, because "the
 * best 15 seconds" and "the best 45 seconds" are genuinely different edits —
 * the shorter one needs the payoff immediately, the longer one can set up.
 */
export function buildVariations(
  moments: Moment[],
  transcript: Transcript,
  options: Partial<VariationOptions> = {},
): ClipVariation[] {
  const opts = { ...DEFAULT_VARIATION_OPTIONS, ...options };
  if (moments.length === 0) return [];

  const variations: ClipVariation[] = [];
  const ranked = [...moments].sort((a, b) => b.score - a.score);

  for (const target of opts.targetLengthsSec) {
    const anchor = ranked[0];
    if (!anchor) break;

    const range = expandToLength(anchor, target, transcript, opts);
    variations.push(
      makeVariation(range, anchor, transcript, `${Math.round(target)}s cut`, `Tightest ${Math.round(
        target,
      )}s edit anchored on the highest-scoring moment (${anchor.signals.join(', ') || 'engagement'}).`),
    );
  }

  // Then one variation per remaining distinct moment, for creative options.
  for (const moment of ranked.slice(1)) {
    if (variations.length >= opts.count) break;
    const range = expandToLength(moment, opts.targetLengthsSec[1] ?? 30, transcript, opts);
    if (variations.some((v) => overlapFraction(v.range, range) > 0.6)) continue;

    variations.push(
      makeVariation(
        range,
        moment,
        transcript,
        `Alt: ${moment.signals[0] ?? 'moment'}`,
        `Alternative angle built around a ${moment.signals[0] ?? 'high-engagement'} beat at ${Math.round(
          moment.start,
        )}s.`,
      ),
    );
  }

  return variations
    .slice(0, opts.count)
    .sort((a, b) => b.score - a.score);
}

function makeVariation(
  range: TimeRange,
  moment: Moment,
  transcript: Transcript,
  label: string,
  rationale: string,
): ClipVariation {
  const length = range.end - range.start;
  // Prefer clips near 30s: long enough to land, short enough to complete.
  const lengthFit = 1 - clamp(Math.abs(length - 30) / 60, 0, 1);
  const score = round(clamp(moment.score * 0.75 + lengthFit * 0.25, 0, 1), 3);

  return {
    id: `var_${shortHash(`${range.start}:${range.end}:${label}`)}`,
    label,
    range: { start: round(range.start), end: round(range.end) },
    score,
    rationale,
    hookText: firstSentenceIn(transcript, range),
  };
}

/**
 * Grow (or shrink) a moment toward the target length, snapping the edges to
 * sentence boundaries and preferring to add lead-in over tail — viewers need
 * context before the payoff, not after it.
 */
function expandToLength(
  moment: Moment,
  targetSec: number,
  transcript: Transcript,
  opts: VariationOptions,
): TimeRange {
  const target = clamp(targetSec, opts.minLengthSec, opts.maxLengthSec);
  let start = moment.start;
  let end = moment.end;

  if (end - start > target) {
    // Too long: trim from the front, keeping the payoff at the end.
    start = end - target;
  } else {
    const deficit = target - (end - start);
    const lead = deficit * 0.35;
    start = Math.max(0, start - lead);
    end = Math.min(transcript.durationSec, start + target);
  }

  return {
    start: snapToSegmentStart(transcript, start),
    end: snapToSegmentEnd(transcript, end),
  };
}

function snapToSegmentStart(transcript: Transcript, time: number): number {
  let best = time;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of transcript.segments) {
    const distance = Math.abs(segment.start - time);
    if (distance < bestDistance && distance < 2.5) {
      best = segment.start;
      bestDistance = distance;
    }
  }
  return Math.max(0, best);
}

function snapToSegmentEnd(transcript: Transcript, time: number): number {
  let best = time;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of transcript.segments) {
    const distance = Math.abs(segment.end - time);
    if (distance < bestDistance && distance < 2.5) {
      best = segment.end;
      bestDistance = distance;
    }
  }
  return Math.min(transcript.durationSec, best);
}

function firstSentenceIn(transcript: Transcript, range: TimeRange): string | null {
  const segment = transcript.segments.find((s) => s.start >= range.start - 0.5);
  if (!segment) return null;
  const [first] = sentences(segment.text);
  return first ?? (segment.text.slice(0, 120) || null);
}

function overlapFraction(a: TimeRange, b: TimeRange): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shortest = Math.min(a.end - a.start, b.end - b.start);
  return shortest > 0 ? Math.max(0, overlap) / shortest : 0;
}
