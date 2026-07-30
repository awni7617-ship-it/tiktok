import type { PlatformId, PostMetrics } from '@/lib/types';
import { clamp, round } from '@/lib/time';

/**
 * Smart content planner.
 *
 * Posting-time recommendations come from the creator's own data when there is
 * enough of it, and from published platform guidance when there is not. The
 * distinction is surfaced to the user — a recommendation based on eleven of
 * their own posts deserves different trust than a generic weekday heuristic,
 * and pretending otherwise would be dishonest.
 */

export interface TimeSlot {
  /** 0 = Sunday. */
  dayOfWeek: number;
  /** Hour in the creator's local timezone, 0–23. */
  hour: number;
}

export interface SlotRecommendation extends TimeSlot {
  /** Relative strength in `[0, 1]`; not a predicted view count. */
  score: number;
  /** How this recommendation was derived. */
  basis: 'personal' | 'platform-guidance' | 'blended';
  /** Number of the creator's own posts backing this slot. */
  sampleSize: number;
  /** Plain-language rationale for the UI. */
  reason: string;
}

/**
 * Baseline windows from each platform's published creator guidance.
 * Weekday-evening and lunchtime peaks are near-universal in short-form.
 */
const PLATFORM_BASELINE: Record<PlatformId, TimeSlot[]> = {
  tiktok: [
    { dayOfWeek: 2, hour: 19 }, { dayOfWeek: 3, hour: 19 }, { dayOfWeek: 4, hour: 20 },
    { dayOfWeek: 5, hour: 12 }, { dayOfWeek: 0, hour: 20 }, { dayOfWeek: 6, hour: 11 },
  ],
  youtube: [
    { dayOfWeek: 5, hour: 17 }, { dayOfWeek: 6, hour: 10 }, { dayOfWeek: 0, hour: 11 },
    { dayOfWeek: 4, hour: 18 }, { dayOfWeek: 3, hour: 18 },
  ],
  instagram: [
    { dayOfWeek: 3, hour: 12 }, { dayOfWeek: 4, hour: 19 }, { dayOfWeek: 2, hour: 12 },
    { dayOfWeek: 6, hour: 10 }, { dayOfWeek: 1, hour: 18 },
  ],
  facebook: [
    { dayOfWeek: 3, hour: 13 }, { dayOfWeek: 4, hour: 13 }, { dayOfWeek: 2, hour: 12 },
    { dayOfWeek: 0, hour: 14 },
  ],
  linkedin: [
    { dayOfWeek: 2, hour: 9 }, { dayOfWeek: 3, hour: 9 }, { dayOfWeek: 4, hour: 8 },
    { dayOfWeek: 2, hour: 17 },
  ],
  pinterest: [
    { dayOfWeek: 6, hour: 20 }, { dayOfWeek: 0, hour: 21 }, { dayOfWeek: 5, hour: 15 },
    { dayOfWeek: 4, hour: 21 },
  ],
  x: [
    { dayOfWeek: 2, hour: 9 }, { dayOfWeek: 3, hour: 12 }, { dayOfWeek: 4, hour: 9 },
    { dayOfWeek: 1, hour: 8 },
  ],
};

export interface HistoricalPost {
  publishedAt: Date;
  platform: PlatformId;
  metrics: Pick<PostMetrics, 'views' | 'likes' | 'comments' | 'shares' | 'completionRate'>;
}

/** Below this many posts in a slot, personal data is treated as noise. */
const MIN_SAMPLES_PER_SLOT = 2;
/** Below this total, we fall back entirely to platform guidance. */
const MIN_TOTAL_POSTS = 8;

/**
 * Rank posting slots.
 *
 * Personal performance is normalised per platform (so a creator whose YouTube
 * numbers dwarf their LinkedIn numbers does not get told to only post on
 * YouTube) and blended with the baseline in proportion to how much data backs
 * each slot.
 */
export function recommendSlots(
  platform: PlatformId,
  history: HistoricalPost[],
  options: { timezoneOffsetMinutes?: number; limit?: number } = {},
): SlotRecommendation[] {
  const limit = options.limit ?? 7;
  const offset = options.timezoneOffsetMinutes ?? 0;
  const relevant = history.filter((post) => post.platform === platform);

  const baseline = PLATFORM_BASELINE[platform];

  if (relevant.length < MIN_TOTAL_POSTS) {
    return baseline.slice(0, limit).map((slot, index) => ({
      ...slot,
      score: round(1 - index * 0.08, 3),
      basis: 'platform-guidance' as const,
      sampleSize: 0,
      reason: `Based on ${platform} audience-activity guidance. Publish ${
        MIN_TOTAL_POSTS - relevant.length
      } more post${MIN_TOTAL_POSTS - relevant.length === 1 ? '' : 's'} and this switches to your own data.`,
    }));
  }

  // Group the creator's posts by local weekday/hour.
  const slots = new Map<string, { total: number; count: number; slot: TimeSlot }>();

  for (const post of relevant) {
    const local = new Date(post.publishedAt.getTime() + offset * 60_000);
    const slot: TimeSlot = { dayOfWeek: local.getUTCDay(), hour: local.getUTCHours() };
    const key = `${slot.dayOfWeek}-${slot.hour}`;

    const entry = slots.get(key) ?? { total: 0, count: 0, slot };
    entry.total += engagementScore(post.metrics);
    entry.count += 1;
    slots.set(key, entry);
  }

  const averages = [...slots.values()].map((entry) => ({
    slot: entry.slot,
    average: entry.total / entry.count,
    count: entry.count,
  }));

  const best = Math.max(...averages.map((entry) => entry.average), 1);
  const baselineKeys = new Set(baseline.map((slot) => `${slot.dayOfWeek}-${slot.hour}`));

  const personal: SlotRecommendation[] = averages
    .filter((entry) => entry.count >= MIN_SAMPLES_PER_SLOT)
    .map((entry) => {
      const normalized = entry.average / best;
      const inBaseline = baselineKeys.has(`${entry.slot.dayOfWeek}-${entry.slot.hour}`);
      // Confidence rises with sample size and saturates around six posts.
      const confidence = clamp(entry.count / 6, 0.3, 1);
      const score = normalized * confidence + (inBaseline ? 0.1 : 0);

      return {
        ...entry.slot,
        score: round(clamp(score, 0, 1), 3),
        basis: inBaseline ? ('blended' as const) : ('personal' as const),
        sampleSize: entry.count,
        reason: inBaseline
          ? `Your ${entry.count} posts in this slot performed ${Math.round(
              normalized * 100,
            )}% of your best, and it matches ${platform}'s general peak.`
          : `Your ${entry.count} posts in this slot performed ${Math.round(
              normalized * 100,
            )}% of your best.`,
      };
    });

  // Top up with baseline slots the creator has not tried yet.
  const covered = new Set(personal.map((slot) => `${slot.dayOfWeek}-${slot.hour}`));
  const untried: SlotRecommendation[] = baseline
    .filter((slot) => !covered.has(`${slot.dayOfWeek}-${slot.hour}`))
    .map((slot, index) => ({
      ...slot,
      score: round(0.5 - index * 0.05, 3),
      basis: 'platform-guidance' as const,
      sampleSize: 0,
      reason: 'A general peak window you have not tried yet — worth an experiment.',
    }));

  return [...personal, ...untried].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Composite engagement score used to rank slots.
 *
 * Shares and comments are weighted far above likes: they are the actions that
 * drive distribution, whereas a like is close to free.
 */
export function engagementScore(metrics: HistoricalPost['metrics']): number {
  const views = Math.max(metrics.views, 1);
  const interactions =
    metrics.likes * 1 + metrics.comments * 3 + metrics.shares * 5;
  const rate = interactions / views;
  return rate * 1000 + metrics.completionRate * 40;
}

// ---------------------------------------------------------------------------
// Consistency & cadence
// ---------------------------------------------------------------------------

export interface CadenceAnalysis {
  postsPerWeek: number;
  /** Longest gap between consecutive posts, in days. */
  longestGapDays: number;
  /** 0–100; rewards regularity, not raw volume. */
  consistencyScore: number;
  streakWeeks: number;
  recommendation: string;
}

/**
 * Measure posting consistency.
 *
 * Consistency is scored on the *variance* of gaps rather than the count:
 * posting four times on one day and then nothing for two weeks is worse than
 * posting twice a week, every week, even though the totals match.
 */
export function analyzeCadence(publishDates: Date[], windowDays = 56): CadenceAnalysis {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const dates = publishDates
    .filter((date) => date.getTime() >= cutoff)
    .sort((a, b) => a.getTime() - b.getTime());

  if (dates.length < 2) {
    return {
      postsPerWeek: dates.length,
      longestGapDays: 0,
      consistencyScore: dates.length === 0 ? 0 : 25,
      streakWeeks: dates.length > 0 ? 1 : 0,
      recommendation:
        'Not enough history yet. Aim for a fixed cadence — three posts a week, same days — and the planner will start tuning to your results.',
    };
  }

  const gapsDays: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gapsDays.push((dates[i]!.getTime() - dates[i - 1]!.getTime()) / (24 * 60 * 60 * 1000));
  }

  const spanDays = (dates[dates.length - 1]!.getTime() - dates[0]!.getTime()) / (24 * 60 * 60 * 1000);
  const postsPerWeek = spanDays > 0 ? (dates.length / spanDays) * 7 : dates.length;

  const meanGap = gapsDays.reduce((sum, gap) => sum + gap, 0) / gapsDays.length;
  const variance =
    gapsDays.reduce((sum, gap) => sum + (gap - meanGap) ** 2, 0) / gapsDays.length;
  const stdDev = Math.sqrt(variance);
  const longestGapDays = Math.max(...gapsDays);

  // Coefficient of variation: 0 is perfectly regular, 1+ is erratic.
  const cv = meanGap > 0 ? stdDev / meanGap : 1;
  const regularity = clamp(1 - cv, 0, 1);
  const volume = clamp(postsPerWeek / 4, 0, 1);
  const consistencyScore = round(clamp(regularity * 70 + volume * 30, 0, 100), 1);

  const streakWeeks = countStreakWeeks(dates);

  return {
    postsPerWeek: round(postsPerWeek, 1),
    longestGapDays: round(longestGapDays, 1),
    consistencyScore,
    streakWeeks,
    recommendation: cadenceAdvice(consistencyScore, postsPerWeek, longestGapDays),
  };
}

function cadenceAdvice(score: number, postsPerWeek: number, longestGap: number): string {
  if (score >= 75) {
    return `Strong cadence at ${postsPerWeek.toFixed(
      1,
    )} posts a week. Hold this — consistency compounds more than any single post.`;
  }
  if (longestGap > 7) {
    return `Your longest gap was ${Math.round(
      longestGap,
    )} days. Gaps over a week are where momentum goes; batch-record so you always have one in the queue.`;
  }
  if (postsPerWeek < 2) {
    return `At ${postsPerWeek.toFixed(
      1,
    )} posts a week there is not much for the algorithm to learn from. Three a week is the usual floor for growth.`;
  }
  return 'Your volume is fine but the spacing is uneven. Pick fixed days and stick to them — the planner queue will hold drafts for you.';
}

function countStreakWeeks(dates: Date[]): number {
  if (dates.length === 0) return 0;

  const weeks = new Set(dates.map((date) => isoWeekKey(date)));
  let streak = 0;
  const cursor = new Date();

  // Walk back week by week until a week has no posts.
  for (let i = 0; i < 104; i++) {
    if (!weeks.has(isoWeekKey(cursor))) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 7);
  }

  return streak;
}

function isoWeekKey(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Queue scheduling
// ---------------------------------------------------------------------------

export interface QueueSlotOptions {
  /** Recommended slots, best first. */
  slots: SlotRecommendation[];
  /** Times already taken, so the queue never double-books. */
  taken: Date[];
  /** Do not schedule before this instant. */
  from: Date;
  /** Minimum spacing between two posts on the same platform. */
  minSpacingHours?: number;
  timezoneOffsetMinutes?: number;
}

/**
 * Find the next free recommended slot.
 *
 * Walks forward day by day, checking the ranked slots in order, and enforces a
 * minimum spacing so a bulk-scheduled batch does not land three posts in one
 * evening.
 */
export function nextAvailableSlot(options: QueueSlotOptions): Date | null {
  const spacingMs = (options.minSpacingHours ?? 4) * 60 * 60 * 1000;
  const offsetMs = (options.timezoneOffsetMinutes ?? 0) * 60_000;
  const takenTimes = options.taken.map((date) => date.getTime()).sort((a, b) => a - b);

  for (let dayOffset = 0; dayOffset < 30; dayOffset++) {
    const day = new Date(options.from.getTime() + dayOffset * 24 * 60 * 60 * 1000);

    for (const slot of options.slots) {
      const local = new Date(day.getTime() + offsetMs);
      if (local.getUTCDay() !== slot.dayOfWeek) continue;

      const candidateLocal = Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
        slot.hour,
        0,
        0,
      );
      const candidate = new Date(candidateLocal - offsetMs);

      if (candidate.getTime() <= options.from.getTime()) continue;
      if (takenTimes.some((time) => Math.abs(time - candidate.getTime()) < spacingMs)) continue;

      return candidate;
    }
  }

  return null;
}

/** Fill a batch of drafts into the best available slots, in order. */
export function scheduleBatch(
  count: number,
  options: QueueSlotOptions,
): Date[] {
  const scheduled: Date[] = [];
  const taken = [...options.taken];

  for (let i = 0; i < count; i++) {
    const next = nextAvailableSlot({ ...options, taken });
    if (!next) break;
    scheduled.push(next);
    taken.push(next);
  }

  return scheduled;
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatSlot(slot: TimeSlot): string {
  const hour = slot.hour % 12 === 0 ? 12 : slot.hour % 12;
  const meridiem = slot.hour < 12 ? 'am' : 'pm';
  return `${DAY_NAMES[slot.dayOfWeek]} ${hour}${meridiem}`;
}
