import type { MetricPoint, PlatformId, PostMetrics } from '@/lib/types';
import { clamp, round } from '@/lib/time';
import { getLlm, withRetry } from '@/server/ai/registry';
import { analyticsInsightSchema, toJsonSchema, type AnalyticsInsight } from '@/server/ai/schemas';
import { logger } from '@/server/obs/logger';

const log = logger.child({ module: 'analytics' });

/**
 * Analytics aggregation and insight generation.
 *
 * Aggregation is pure and testable; the AI layer sits on top and explains what
 * the numbers mean. Every derived figure states its own denominator, because
 * "engagement rate" means at least three different things depending on whether
 * you divide by views, impressions or followers.
 */

export interface PostSummary {
  postId: string;
  projectTitle: string;
  platform: PlatformId;
  publishedAt: Date;
  metrics: PostMetrics;
}

export interface AnalyticsTotals {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  impressions: number;
  followersGained: number;
  watchTimeHours: number;
  /** Interactions ÷ views. */
  engagementRate: number;
  averageViewDurationSec: number;
  averageCompletionRate: number;
}

export function aggregate(posts: PostSummary[]): AnalyticsTotals {
  const totals = posts.reduce(
    (acc, post) => {
      acc.views += post.metrics.views;
      acc.likes += post.metrics.likes;
      acc.comments += post.metrics.comments;
      acc.shares += post.metrics.shares;
      acc.saves += post.metrics.saves;
      acc.impressions += post.metrics.impressions;
      acc.followersGained += post.metrics.followersGained;
      acc.watchTimeSec += post.metrics.watchTimeSec;
      acc.completionSum += post.metrics.completionRate;
      acc.durationSum += post.metrics.averageViewDurationSec;
      return acc;
    },
    {
      views: 0, likes: 0, comments: 0, shares: 0, saves: 0,
      impressions: 0, followersGained: 0, watchTimeSec: 0,
      completionSum: 0, durationSum: 0,
    },
  );

  const interactions = totals.likes + totals.comments + totals.shares + totals.saves;

  return {
    posts: posts.length,
    views: totals.views,
    likes: totals.likes,
    comments: totals.comments,
    shares: totals.shares,
    saves: totals.saves,
    impressions: totals.impressions,
    followersGained: totals.followersGained,
    watchTimeHours: round(totals.watchTimeSec / 3600, 2),
    engagementRate: totals.views > 0 ? round(interactions / totals.views, 4) : 0,
    averageViewDurationSec: posts.length > 0 ? round(totals.durationSum / posts.length, 2) : 0,
    averageCompletionRate: posts.length > 0 ? round(totals.completionSum / posts.length, 4) : 0,
  };
}

/** Bucket a metric into a daily series, filling gaps with zero. */
export function timeSeries(
  posts: PostSummary[],
  metric: keyof PostMetrics,
  options: { days: number; endDate?: Date },
): MetricPoint[] {
  const end = options.endDate ?? new Date();
  const buckets = new Map<string, number>();

  for (let i = options.days - 1; i >= 0; i--) {
    const date = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    buckets.set(dateKey(date), 0);
  }

  for (const post of posts) {
    const key = dateKey(post.publishedAt);
    if (!buckets.has(key)) continue;

    const value = post.metrics[metric];
    if (typeof value === 'number') {
      buckets.set(key, (buckets.get(key) ?? 0) + value);
    }
  }

  return [...buckets.entries()].map(([date, value]) => ({ date, value: round(value, 2) }));
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface PeriodComparison {
  current: AnalyticsTotals;
  previous: AnalyticsTotals;
  /** Percentage change per metric; null when the previous period was zero. */
  change: Partial<Record<keyof AnalyticsTotals, number | null>>;
}

/**
 * Compare two equal-length periods.
 *
 * Growth from a zero baseline is reported as `null` rather than as infinity or
 * a misleading 100% — going from 0 to 5 views is not a percentage story.
 */
export function comparePeriods(
  posts: PostSummary[],
  options: { days: number; endDate?: Date },
): PeriodComparison {
  const end = (options.endDate ?? new Date()).getTime();
  const periodMs = options.days * 24 * 60 * 60 * 1000;

  const current = posts.filter((post) => {
    const time = post.publishedAt.getTime();
    return time > end - periodMs && time <= end;
  });
  const previous = posts.filter((post) => {
    const time = post.publishedAt.getTime();
    return time > end - periodMs * 2 && time <= end - periodMs;
  });

  const currentTotals = aggregate(current);
  const previousTotals = aggregate(previous);

  const change: PeriodComparison['change'] = {};
  for (const key of Object.keys(currentTotals) as (keyof AnalyticsTotals)[]) {
    const before = previousTotals[key];
    const after = currentTotals[key];
    change[key] = before > 0 ? round(((after - before) / before) * 100, 1) : null;
  }

  return { current: currentTotals, previous: previousTotals, change };
}

/**
 * Rank posts by a composite of reach and engagement quality.
 *
 * Ranking purely by views surfaces whatever the algorithm happened to push;
 * weighting engagement rate and completion alongside it surfaces the posts
 * that actually earned their reach, which is what a creator can learn from.
 */
export function topPerformers(posts: PostSummary[], limit = 5): PostSummary[] {
  if (posts.length === 0) return [];

  const maxViews = Math.max(...posts.map((post) => post.metrics.views), 1);

  return [...posts]
    .map((post) => {
      const views = Math.max(post.metrics.views, 1);
      const interactions =
        post.metrics.likes + post.metrics.comments * 3 + post.metrics.shares * 5 + post.metrics.saves * 2;

      const reach = post.metrics.views / maxViews;
      const quality = clamp(interactions / views, 0, 0.5) * 2;
      const retention = post.metrics.completionRate;

      return { post, score: reach * 0.45 + quality * 0.35 + retention * 0.2 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.post);
}

/** Average the retention curves of several posts into one profile. */
export function averageRetentionCurve(posts: PostSummary[]): number[] {
  const curves = posts.map((post) => post.metrics.retentionCurve).filter((curve) => curve.length > 0);
  if (curves.length === 0) return [];

  const length = Math.max(...curves.map((curve) => curve.length));
  const result: number[] = [];

  for (let i = 0; i < length; i++) {
    const values = curves.map((curve) => curve[i]).filter((value): value is number => value !== undefined);
    result.push(values.length > 0 ? round(values.reduce((a, b) => a + b, 0) / values.length, 4) : 0);
  }

  return result;
}

/**
 * Locate the sharpest drop in a retention curve.
 *
 * The steepest decline is where the edit lost people; expressing it as a
 * percentage of the video's length tells the creator exactly where to look.
 */
export function findDropOff(curve: number[]): { atPercent: number; severity: number } | null {
  if (curve.length < 2) return null;

  let worstIndex = 0;
  let worstDrop = 0;

  for (let i = 1; i < curve.length; i++) {
    const drop = (curve[i - 1] ?? 0) - (curve[i] ?? 0);
    if (drop > worstDrop) {
      worstDrop = drop;
      worstIndex = i;
    }
  }

  if (worstDrop <= 0) return null;

  return {
    atPercent: round((worstIndex / (curve.length - 1)) * 100, 1),
    severity: round(worstDrop, 4),
  };
}

// ---------------------------------------------------------------------------
// AI insights
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an analytics assistant for a short-form video creator. You explain what their numbers mean and what to do next.

Rules:
- Ground every statement in the figures you are given. Never invent a number.
- Say what changed, why it plausibly changed, and what to do — in that order.
- Be honest when a change is small or noisy. "Up 3% on nine posts" is not a trend, and saying so builds more trust than manufacturing a narrative.
- Never promise or predict specific view counts, and never claim something will go viral.
- Actions must be things the creator can do this week, not general advice.`;

export interface InsightInput {
  comparison: PeriodComparison;
  top: PostSummary[];
  periodDays: number;
  retentionCurve?: number[];
  postsPerWeek?: number;
}

export async function generateInsights(input: InsightInput): Promise<AnalyticsInsight> {
  const llm = getLlm();

  try {
    const result = await withRetry(
      () =>
        llm.completeJson({
          system: SYSTEM_PROMPT,
          cacheSystem: true,
          maxTokens: 2000,
          messages: [{ role: 'user', content: buildInsightPrompt(input) }],
          schema: toJsonSchema(analyticsInsightSchema),
          parse: (value) => analyticsInsightSchema.parse(value),
        }),
      { label: 'analytics-insights', attempts: 2 },
    );

    return result.value;
  } catch (error) {
    log.warn('AI insights unavailable; using the computed summary', { error });
    return fallbackInsight(input);
  }
}

export function buildInsightPrompt(input: InsightInput): string {
  const { current, previous, change } = input.comparison;

  const lines = [
    `Period: the last ${input.periodDays} days, compared with the ${input.periodDays} days before.`,
    '',
    'Current period:',
    `  Posts: ${current.posts}`,
    `  Views: ${current.views.toLocaleString()}`,
    `  Engagement rate: ${(current.engagementRate * 100).toFixed(2)}% of views`,
    `  Average completion: ${(current.averageCompletionRate * 100).toFixed(1)}%`,
    `  Watch time: ${current.watchTimeHours} hours`,
    `  Followers gained: ${current.followersGained}`,
    '',
    'Previous period:',
    `  Posts: ${previous.posts}`,
    `  Views: ${previous.views.toLocaleString()}`,
    `  Engagement rate: ${(previous.engagementRate * 100).toFixed(2)}%`,
    `  Average completion: ${(previous.averageCompletionRate * 100).toFixed(1)}%`,
    '',
    'Change:',
    ...Object.entries(change)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `  ${key}: ${value! > 0 ? '+' : ''}${value}%`),
  ];

  if (input.postsPerWeek !== undefined) {
    lines.push('', `Posting cadence: ${input.postsPerWeek.toFixed(1)} posts per week.`);
  }

  if (input.top.length > 0) {
    lines.push('', 'Best performing posts:');
    for (const post of input.top.slice(0, 5)) {
      lines.push(
        `  "${post.projectTitle}" on ${post.platform}: ${post.metrics.views.toLocaleString()} views, ${(
          post.metrics.completionRate * 100
        ).toFixed(0)}% completion, ${post.metrics.shares} shares`,
      );
    }
  }

  if (input.retentionCurve && input.retentionCurve.length > 0) {
    const drop = findDropOff(input.retentionCurve);
    lines.push(
      '',
      `Average retention curve (deciles): ${input.retentionCurve
        .map((value) => `${Math.round(value * 100)}%`)
        .join(' → ')}`,
    );
    if (drop) {
      lines.push(
        `Sharpest drop-off at ${drop.atPercent}% through the video, losing ${(drop.severity * 100).toFixed(
          0,
        )}% of remaining viewers.`,
      );
    }
  }

  return lines.join('\n');
}

/** Purely computed insight, used when the AI layer is unavailable. */
export function fallbackInsight(input: InsightInput): AnalyticsInsight {
  const { current, change } = input.comparison;
  const viewChange = change.views;

  const wins: string[] = [];
  const concerns: string[] = [];
  const actions: string[] = [];

  if (viewChange !== null && viewChange !== undefined && viewChange > 10) {
    wins.push(`Views are up ${viewChange}% on the previous period.`);
  }
  if (current.averageCompletionRate > 0.5) {
    wins.push(`Average completion is ${(current.averageCompletionRate * 100).toFixed(0)}% — strong for short-form.`);
  }
  if (current.followersGained > 0) {
    wins.push(`${current.followersGained} new followers this period.`);
  }

  if (viewChange !== null && viewChange !== undefined && viewChange < -10) {
    concerns.push(`Views are down ${Math.abs(viewChange)}% on the previous period.`);
  }
  if (current.averageCompletionRate < 0.3 && current.posts > 0) {
    concerns.push(
      `Average completion is ${(current.averageCompletionRate * 100).toFixed(
        0,
      )}%. Most viewers are leaving before the payoff.`,
    );
  }
  if (current.posts < input.periodDays / 7 * 2) {
    concerns.push('Posting volume is below two per week, which limits how much the ranker can learn.');
  }

  const drop = input.retentionCurve ? findDropOff(input.retentionCurve) : null;
  if (drop) {
    actions.push(
      `Rewatch your posts at the ${drop.atPercent}% mark — that is where retention falls hardest.`,
    );
  }
  if (input.top[0]) {
    actions.push(`"${input.top[0].projectTitle}" outperformed. Make two more in that format.`);
  }
  actions.push('Hold a consistent cadence — gaps cost more than any single weak post.');

  return {
    summary:
      current.posts === 0
        ? 'No posts published in this period, so there is nothing to compare yet.'
        : `${current.posts} post${current.posts === 1 ? '' : 's'} drew ${current.views.toLocaleString()} views at a ${(
            current.engagementRate * 100
          ).toFixed(2)}% engagement rate${
            viewChange !== null && viewChange !== undefined
              ? `, ${viewChange >= 0 ? 'up' : 'down'} ${Math.abs(viewChange)}% on the previous period`
              : ''
          }.`,
    wins: wins.slice(0, 5),
    concerns: concerns.slice(0, 5),
    actions: actions.slice(0, 5),
  };
}
