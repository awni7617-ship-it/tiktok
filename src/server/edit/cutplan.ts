import type { Cut, CutPlan, KeptSegment, TimeRange } from '@/lib/types';
import { mergeRanges, round, subtractRanges } from '@/lib/time';

/**
 * Turns a bag of proposed cuts into an ordered, non-overlapping edit decision
 * list. This is the single place where "what the AI proposed" becomes "what
 * will actually be rendered", so it is also where user decisions are honoured.
 */

export interface CutPlanOptions {
  /**
   * Cuts below this confidence are kept in the plan as suggestions but are not
   * applied unless the user explicitly accepts them.
   */
  autoApplyThreshold: number;
  /** Drop kept segments shorter than this; single-frame slivers look broken. */
  minSegmentSec: number;
  /** Never remove more than this fraction of the source. */
  maxRemovedFraction: number;
}

export const DEFAULT_CUT_PLAN_OPTIONS: CutPlanOptions = {
  autoApplyThreshold: 0.65,
  minSegmentSec: 0.25,
  maxRemovedFraction: 0.6,
};

/** A cut is applied when the user accepted it, or (absent a decision) when the engine is confident. */
export function isCutApplied(cut: Cut, threshold: number): boolean {
  if (cut.accepted === true) return true;
  if (cut.accepted === false) return false;
  return cut.confidence >= threshold;
}

/**
 * Resolve overlapping proposals from different detectors. When a silence cut
 * and a filler cut overlap, the higher-confidence one wins and the other is
 * trimmed, so the plan never double-counts removed time.
 */
export function dedupeCuts(cuts: Cut[]): Cut[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start || b.confidence - a.confidence);
  const result: Cut[] = [];

  for (const cut of sorted) {
    const previous = result[result.length - 1];
    if (!previous || cut.start >= previous.end) {
      result.push({ ...cut });
      continue;
    }

    // Overlap: extend the winner and discard the swallowed remainder.
    if (cut.confidence > previous.confidence) {
      previous.end = Math.min(previous.end, cut.start);
      if (previous.end - previous.start < 1e-6) result.pop();
      result.push({ ...cut });
    } else if (cut.end > previous.end) {
      result.push({ ...cut, start: previous.end });
    }
  }

  return result.filter((cut) => cut.end - cut.start > 1e-6);
}

/**
 * Build the edit decision list.
 *
 * Guards against over-cutting: if applying every confident cut would remove
 * more than `maxRemovedFraction` of the source, the lowest-confidence cuts are
 * dropped until the plan is back under budget. A 90-second take that collapses
 * to 8 seconds is almost always a detector failure, not a good edit.
 */
export function buildCutPlan(
  cuts: Cut[],
  sourceDurationSec: number,
  options: Partial<CutPlanOptions> = {},
): CutPlan {
  const opts = { ...DEFAULT_CUT_PLAN_OPTIONS, ...options };
  const deduped = dedupeCuts(cuts);

  const applied = deduped.filter((cut) => isCutApplied(cut, opts.autoApplyThreshold));

  // Explicit user acceptances are never dropped by the over-cut guard.
  const budget = sourceDurationSec * opts.maxRemovedFraction;
  const withinBudget: Cut[] = [];
  let removed = 0;

  const ordered = [...applied].sort((a, b) => {
    if (a.accepted === true && b.accepted !== true) return -1;
    if (b.accepted === true && a.accepted !== true) return 1;
    return b.confidence - a.confidence;
  });

  for (const cut of ordered) {
    const length = cut.end - cut.start;
    if (cut.accepted === true || removed + length <= budget) {
      withinBudget.push(cut);
      removed += length;
    }
  }

  const holes = mergeRanges(withinBudget);
  const survivors = subtractRanges({ start: 0, end: sourceDurationSec }, holes).filter(
    (segment) => segment.end - segment.start >= opts.minSegmentSec,
  );

  const kept = layoutSegments(survivors);
  const outputDuration = kept.reduce(
    (sum, segment) => sum + (segment.sourceEnd - segment.sourceStart) / segment.speed,
    0,
  );

  return {
    cuts: deduped,
    kept,
    sourceDurationSec: round(sourceDurationSec),
    outputDurationSec: round(outputDuration),
    removedSec: round(sourceDurationSec - outputDuration),
  };
}

/** Place source ranges consecutively on the output timeline at 1x speed. */
export function layoutSegments(ranges: TimeRange[], speed = 1): KeptSegment[] {
  let cursor = 0;
  return ranges.map((range) => {
    const segment: KeptSegment = {
      sourceStart: round(range.start),
      sourceEnd: round(range.end),
      outputStart: round(cursor),
      speed,
    };
    cursor += (range.end - range.start) / speed;
    return segment;
  });
}

/** Recompute `outputStart` after segments have been reordered, split or retimed. */
export function relayout(segments: KeptSegment[]): KeptSegment[] {
  let cursor = 0;
  return segments.map((segment) => {
    const next: KeptSegment = { ...segment, outputStart: round(cursor) };
    cursor += (segment.sourceEnd - segment.sourceStart) / segment.speed;
    return next;
  });
}

/**
 * Map a time on the *source* timeline to its position on the *output*
 * timeline. Returns null when that moment was cut. Captions, motion cues and
 * ROI tracks all need this to survive the edit.
 */
export function mapSourceToOutput(plan: CutPlan, sourceTime: number): number | null {
  for (const segment of plan.kept) {
    if (sourceTime >= segment.sourceStart && sourceTime <= segment.sourceEnd) {
      return round(segment.outputStart + (sourceTime - segment.sourceStart) / segment.speed);
    }
  }
  return null;
}

/** Inverse of `mapSourceToOutput`. */
export function mapOutputToSource(plan: CutPlan, outputTime: number): number | null {
  for (const segment of plan.kept) {
    const length = (segment.sourceEnd - segment.sourceStart) / segment.speed;
    if (outputTime >= segment.outputStart && outputTime <= segment.outputStart + length) {
      return round(segment.sourceStart + (outputTime - segment.outputStart) * segment.speed);
    }
  }
  return null;
}

/**
 * Project a source range onto the output timeline.
 *
 * The range is clipped against each kept segment and the results are merged.
 * A range that straddles a removed pause therefore comes back as one
 * contiguous piece — because after the cut its two halves *are* contiguous on
 * the output. It only splits when the surviving pieces land in segments that
 * were reordered or retimed apart.
 */
export function projectRange(plan: CutPlan, range: TimeRange): TimeRange[] {
  const pieces: TimeRange[] = [];

  for (const segment of plan.kept) {
    const start = Math.max(range.start, segment.sourceStart);
    const end = Math.min(range.end, segment.sourceEnd);
    if (end <= start) continue;

    pieces.push({
      start: round(segment.outputStart + (start - segment.sourceStart) / segment.speed),
      end: round(segment.outputStart + (end - segment.sourceStart) / segment.speed),
    });
  }

  return mergeRanges(pieces, 0.02);
}

/** Apply a user's accept/reject decisions and rebuild the plan. */
export function applyDecisions(
  plan: CutPlan,
  decisions: Record<string, boolean>,
  options: Partial<CutPlanOptions> = {},
): CutPlan {
  const updated = plan.cuts.map((cut, index) => {
    const key = cutKey(cut, index);
    return key in decisions ? { ...cut, accepted: decisions[key] } : cut;
  });
  return buildCutPlan(updated, plan.sourceDurationSec, options);
}

/** Stable identifier for a cut, used as the key in the review UI. */
export function cutKey(cut: Cut, index: number): string {
  return `${index}:${cut.reason}:${cut.start.toFixed(2)}`;
}
