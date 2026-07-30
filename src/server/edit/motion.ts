import type { CutPlan, Moment, MotionCue, MusicCue, TransitionCue } from '@/lib/types';
import { clamp, round } from '@/lib/time';

/**
 * Motion, transitions and music.
 *
 * Restraint is the whole design here. Short-form editing tools tend to slap a
 * whip-pan on every cut, which reads as noise. The planners below budget their
 * effects: motion only on long static stretches, transitions only where a cut
 * removed enough time to be jarring, and never two effects back to back.
 */

export interface MotionOptions {
  /** Only add motion to output segments at least this long. */
  minSegmentSec: number;
  /** Maximum fraction of the timeline that may carry motion. */
  maxCoverage: number;
  /** Peak scale for a push, e.g. 1.08 = 8% zoom over the segment. */
  intensity: number;
  /** Minimum gap between two motion cues. */
  minGapSec: number;
}

export const DEFAULT_MOTION_OPTIONS: MotionOptions = {
  minSegmentSec: 2.5,
  maxCoverage: 0.45,
  intensity: 1.08,
  minGapSec: 1.5,
};

/**
 * Add slow pushes to long, visually static stretches.
 *
 * Segments that coincide with a high-scoring moment get a push *in* (drawing
 * the eye), everything else alternates direction so consecutive cues do not
 * all drift the same way.
 */
export function planMotion(
  plan: CutPlan,
  moments: Moment[],
  options: Partial<MotionOptions> = {},
): MotionCue[] {
  const opts = { ...DEFAULT_MOTION_OPTIONS, ...options };
  if (plan.kept.length === 0) return [];

  const cues: MotionCue[] = [];
  const budget = plan.outputDurationSec * opts.maxCoverage;
  let used = 0;
  let direction: 'in' | 'out' = 'in';

  for (const segment of plan.kept) {
    const outputLength = (segment.sourceEnd - segment.sourceStart) / segment.speed;
    if (outputLength < opts.minSegmentSec) continue;
    if (used + outputLength > budget) break;

    const previous = cues[cues.length - 1];
    if (previous && segment.outputStart - previous.end < opts.minGapSec) continue;

    const isHighlight = moments.some(
      (moment) =>
        moment.start < segment.sourceEnd &&
        moment.end > segment.sourceStart &&
        moment.score >= 0.5,
    );

    const kind = isHighlight ? 'zoom-in' : direction === 'in' ? 'push' : 'zoom-out';
    // Scale the push with segment length so a 12s shot does not zoom 8% in the
    // first second and then sit still.
    const intensity = round(
      1 + (opts.intensity - 1) * clamp(outputLength / 8, 0.35, 1) * (isHighlight ? 1.2 : 1),
      3,
    );

    cues.push({
      start: round(segment.outputStart),
      end: round(segment.outputStart + outputLength),
      kind,
      intensity,
      reason: isHighlight
        ? 'Slow push in on a high-engagement beat'
        : `Adds movement to a ${outputLength.toFixed(1)}s static shot`,
    });

    used += outputLength;
    direction = direction === 'in' ? 'out' : 'in';
  }

  return cues;
}

export interface TransitionOptions {
  /** Removed time above this makes a jump cut feel abrupt. */
  jumpThresholdSec: number;
  /** Default transition length. */
  durationSec: number;
  /** Maximum number of non-cut transitions in the timeline. */
  maxDecorated: number;
}

export const DEFAULT_TRANSITION_OPTIONS: TransitionOptions = {
  jumpThresholdSec: 1.5,
  durationSec: 0.22,
  maxDecorated: 6,
};

/**
 * Choose a transition for each segment boundary.
 *
 * Most boundaries stay hard cuts — that is what a tight edit looks like. Only
 * boundaries that removed a lot of source time get a visible transition, since
 * those are the ones where a hard cut reads as a mistake rather than a choice.
 */
export function planTransitions(
  plan: CutPlan,
  options: Partial<TransitionOptions> = {},
): TransitionCue[] {
  const opts = { ...DEFAULT_TRANSITION_OPTIONS, ...options };
  const cues: TransitionCue[] = [];
  let decorated = 0;

  for (let i = 1; i < plan.kept.length; i++) {
    const previous = plan.kept[i - 1]!;
    const current = plan.kept[i]!;
    const removed = current.sourceStart - previous.sourceEnd;

    let kind: TransitionCue['kind'] = 'cut';

    if (removed >= opts.jumpThresholdSec && decorated < opts.maxDecorated) {
      // Bigger jumps get a stronger transition to sell the time skip.
      kind = removed >= 6 ? 'dip-to-black' : removed >= 3 ? 'whip' : 'fade';
      decorated += 1;
    }

    cues.push({
      at: round(current.outputStart),
      kind,
      durationSec: kind === 'cut' ? 0 : opts.durationSec,
    });
  }

  return cues;
}

/**
 * Copyright-safe music library.
 *
 * Every entry is CC0 or an equivalent licence that permits commercial use
 * without attribution. The catalogue ships as data so the selection logic is
 * testable and so self-hosted deployments can point at their own library.
 */
export interface MusicTrack {
  id: string;
  title: string;
  artist: string;
  license: string;
  bpm: number;
  /** Energy in `[0, 1]`; matched against the video's pacing. */
  energy: number;
  moods: string[];
  durationSec: number;
  /** Relative path inside the configured music bucket. */
  path: string;
}

export const MUSIC_LIBRARY: MusicTrack[] = [
  {
    id: 'trk_pulse',
    title: 'Neon Pulse',
    artist: 'Phantom Library',
    license: 'CC0-1.0',
    bpm: 128,
    energy: 0.82,
    moods: ['energetic', 'tech', 'gaming', 'hype'],
    durationSec: 180,
    path: 'music/neon-pulse.mp3',
  },
  {
    id: 'trk_dusk',
    title: 'Dusk Drive',
    artist: 'Phantom Library',
    license: 'CC0-1.0',
    bpm: 100,
    energy: 0.55,
    moods: ['reflective', 'story', 'documentary', 'business'],
    durationSec: 210,
    path: 'music/dusk-drive.mp3',
  },
  {
    id: 'trk_hollow',
    title: 'Hollow Air',
    artist: 'Phantom Library',
    license: 'CC0-1.0',
    bpm: 72,
    energy: 0.28,
    moods: ['tense', 'scary', 'mystery', 'suspense'],
    durationSec: 240,
    path: 'music/hollow-air.mp3',
  },
  {
    id: 'trk_ascend',
    title: 'Ascend',
    artist: 'Phantom Library',
    license: 'CC0-1.0',
    bpm: 110,
    energy: 0.72,
    moods: ['motivational', 'uplifting', 'sport', 'football'],
    durationSec: 195,
    path: 'music/ascend.mp3',
  },
  {
    id: 'trk_ledger',
    title: 'Clean Ledger',
    artist: 'Phantom Library',
    license: 'CC0-1.0',
    bpm: 96,
    energy: 0.42,
    moods: ['finance', 'educational', 'explainer', 'calm'],
    durationSec: 220,
    path: 'music/clean-ledger.mp3',
  },
  {
    id: 'trk_relic',
    title: 'Relic',
    artist: 'Phantom Library',
    license: 'CC0-1.0',
    bpm: 84,
    energy: 0.38,
    moods: ['history', 'documentary', 'epic', 'science'],
    durationSec: 260,
    path: 'music/relic.mp3',
  },
];

export interface MusicOptions {
  /** Desired mood tags, usually derived from the content niche. */
  moods: string[];
  /** Music bed level relative to narration. */
  gainDb: number;
  /** How far to duck the bed while narration plays. */
  duckDb: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export const DEFAULT_MUSIC_OPTIONS: MusicOptions = {
  moods: [],
  gainDb: -18,
  duckDb: -8,
  fadeInSec: 0.8,
  fadeOutSec: 1.2,
};

/**
 * Pick a bed that matches the requested mood and the video's actual energy.
 * Mood match dominates; energy proximity breaks ties, so a "scary" request
 * never returns a 128bpm hype track just because the edit is fast.
 */
export function selectMusic(
  durationSec: number,
  energy: number,
  options: Partial<MusicOptions> = {},
  library: MusicTrack[] = MUSIC_LIBRARY,
): MusicCue | null {
  const opts = { ...DEFAULT_MUSIC_OPTIONS, ...options };
  if (library.length === 0) return null;

  const wanted = new Set(opts.moods.map((mood) => mood.toLowerCase()));

  const ranked = [...library]
    .map((track) => {
      const moodHits = track.moods.filter((mood) => wanted.has(mood.toLowerCase())).length;
      const energyFit = 1 - Math.min(1, Math.abs(track.energy - energy));
      // Tracks shorter than the video would need looping; penalise mildly.
      const lengthFit = track.durationSec >= durationSec ? 1 : 0.7;
      return { track, score: moodHits * 1.5 + energyFit * 0.8 + lengthFit * 0.3 };
    })
    .sort((a, b) => b.score - a.score);

  const winner = ranked[0]?.track;
  if (!winner) return null;

  return {
    trackId: winner.id,
    title: winner.title,
    license: winner.license,
    startAt: 0,
    gainDb: opts.gainDb,
    duckDb: opts.duckDb,
    fadeInSec: opts.fadeInSec,
    fadeOutSec: Math.min(opts.fadeOutSec, durationSec / 4),
  };
}

/** Rough energy estimate from pacing, used to drive music selection. */
export function estimateEnergy(wordsPerMinute: number, cutsPerMinute: number): number {
  const paceScore = clamp((wordsPerMinute - 100) / 100, 0, 1);
  const cutScore = clamp(cutsPerMinute / 20, 0, 1);
  return round(clamp(paceScore * 0.6 + cutScore * 0.4, 0, 1), 3);
}
