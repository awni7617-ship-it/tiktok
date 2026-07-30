import type { MediaProbe, PlatformId, PostMetrics } from '@/lib/types';
import { buildEditPlan, summarizePlan } from '@/server/edit/plan';
import { buildMockTranscript, MockRoiDetector } from '@/server/ai/providers/mock';
import { runRules, scoreAreas, overallScore } from '@/server/optimizer/rules';
import { aggregate, comparePeriods, timeSeries, topPerformers, averageRetentionCurve, findDropOff, fallbackInsight, type PostSummary } from '@/server/analytics';
import { analyzeCadence, recommendSlots } from '@/server/planner';
import { seededRandom } from '@/server/ai/providers/mock';

/**
 * Demo dataset.
 *
 * The screens render real engine output rather than hand-written fixtures: the
 * edit plan, the optimizer report and the analytics summaries below are all
 * produced by the same functions the worker runs in production. That means the
 * UI can never drift from what the pipeline actually does, and a reviewer can
 * see the engines working without provisioning a database.
 */

const PROBE: MediaProbe = {
  durationSec: 0,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  audioChannels: 2,
  audioSampleRate: 48000,
  videoCodec: 'h264',
  audioCodec: 'aac',
  bitrateKbps: 5200,
};

export async function demoEditPlan(seed = 'demo-project') {
  const transcript = buildMockTranscript(seed);
  const probe = { ...PROBE, durationSec: transcript.durationSec };

  const regions = await new MockRoiDetector().detect(seed, {
    sampleFps: 5,
    durationSec: transcript.durationSec,
  });

  const plan = buildEditPlan({ probe, transcript, regions });
  return { plan, transcript, probe, summary: summarizePlan(plan) };
}

export async function demoReport(seed = 'demo-project') {
  const { plan } = await demoEditPlan(seed);

  const suggestions = runRules({
    plan,
    platform: 'tiktok',
    content: {
      title: 'The one editing habit that doubled my watch time',
      hook: 'Hey guys, welcome back — today I want to talk about editing',
      hashtags: ['#editing'],
      callToAction: '',
    },
  });

  const subScores = scoreAreas(suggestions);
  return { suggestions, subScores, score: overallScore(subScores) };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type DemoProjectStatus = 'draft' | 'analyzing' | 'ready' | 'rendering' | 'published';

export interface DemoProject {
  id: string;
  title: string;
  status: DemoProjectStatus;
  kind: 'upload' | 'generated' | 'faceless';
  durationSec: number;
  updatedAt: string;
  score: number | null;
  platforms: PlatformId[];
  thumbnailHue: number;
}

export const DEMO_PROJECTS: DemoProject[] = [
  {
    id: 'prj_editing_habit',
    title: 'The one editing habit that doubled my watch time',
    status: 'ready',
    kind: 'upload',
    durationSec: 34,
    updatedAt: '2 hours ago',
    score: 78,
    platforms: ['tiktok', 'instagram', 'youtube'],
    thumbnailHue: 262,
  },
  {
    id: 'prj_lighthouse',
    title: 'The lighthouse keeper who vanished in 1900',
    status: 'published',
    kind: 'faceless',
    durationSec: 52,
    updatedAt: 'Yesterday',
    score: 91,
    platforms: ['tiktok', 'youtube'],
    thumbnailHue: 190,
  },
  {
    id: 'prj_compound',
    title: 'Compound interest, explained in 30 seconds',
    status: 'rendering',
    kind: 'generated',
    durationSec: 31,
    updatedAt: '4 hours ago',
    score: 84,
    platforms: ['instagram', 'linkedin'],
    thumbnailHue: 150,
  },
  {
    id: 'prj_stadium',
    title: 'That 94th minute touch — slowed down',
    status: 'ready',
    kind: 'upload',
    durationSec: 22,
    updatedAt: '1 day ago',
    score: 69,
    platforms: ['tiktok'],
    thumbnailHue: 20,
  },
  {
    id: 'prj_dancing',
    title: 'In 1518, a town danced itself to death',
    status: 'draft',
    kind: 'faceless',
    durationSec: 47,
    updatedAt: '3 days ago',
    score: null,
    platforms: [],
    thumbnailHue: 320,
  },
  {
    id: 'prj_desk',
    title: 'I tested the £40 mic against the £400 one',
    status: 'analyzing',
    kind: 'upload',
    durationSec: 63,
    updatedAt: 'Just now',
    score: null,
    platforms: ['youtube'],
    thumbnailHue: 220,
  },
];

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

const PLATFORM_MIX: { platform: PlatformId; weight: number }[] = [
  { platform: 'tiktok', weight: 0.46 },
  { platform: 'youtube', weight: 0.27 },
  { platform: 'instagram', weight: 0.19 },
  { platform: 'linkedin', weight: 0.08 },
];

/**
 * Synthesise a plausible posting history.
 *
 * Seeded, so the dashboard shows the same numbers on every render — a demo
 * whose figures shuffle on refresh reads as broken.
 */
export function demoPosts(days = 60): PostSummary[] {
  const random = seededRandom('phantom-analytics-v1');
  const posts: PostSummary[] = [];

  for (let day = days; day >= 0; day--) {
    // Roughly four posts a week, clustered on weekdays.
    const date = new Date(Date.now() - day * 86400000);
    const weekday = date.getUTCDay();
    const postChance = weekday === 0 || weekday === 6 ? 0.25 : 0.55;
    if (random() > postChance) continue;

    const mix = PLATFORM_MIX.find((entry) => random() < entry.weight) ?? PLATFORM_MIX[0]!;

    // A couple of breakouts, the rest clustered around a modest baseline.
    const breakout = random() < 0.07;
    const views = Math.round(
      breakout ? 40000 + random() * 180000 : 1200 + random() * 9000,
    );

    const completionRate = 0.28 + random() * 0.34;
    const engagement = 0.04 + random() * 0.07;

    posts.push({
      postId: `post_${day}_${mix.platform}`,
      projectTitle: DEMO_PROJECTS[Math.floor(random() * DEMO_PROJECTS.length)]!.title,
      platform: mix.platform,
      publishedAt: date,
      metrics: buildMetrics(views, completionRate, engagement, random),
    });
  }

  return posts;
}

function buildMetrics(
  views: number,
  completionRate: number,
  engagement: number,
  random: () => number,
): PostMetrics {
  const interactions = Math.round(views * engagement);
  const averageViewDurationSec = 8 + random() * 18;

  return {
    views,
    likes: Math.round(interactions * 0.78),
    comments: Math.round(interactions * 0.09),
    shares: Math.round(interactions * 0.08),
    saves: Math.round(interactions * 0.05),
    impressions: Math.round(views * (1.15 + random() * 0.3)),
    watchTimeSec: Math.round(views * averageViewDurationSec),
    averageViewDurationSec: Math.round(averageViewDurationSec * 10) / 10,
    completionRate: Math.round(completionRate * 1000) / 1000,
    followersGained: Math.round(views * (0.002 + random() * 0.006)),
    // Retention decays fast at first, then flattens — the usual shape.
    retentionCurve: Array.from({ length: 11 }, (_, i) => {
      const t = i / 10;
      const value = Math.exp(-2.4 * t ** 0.8) * (0.55 + completionRate) + completionRate * 0.35;
      return Math.round(Math.min(1, value) * 1000) / 1000;
    }),
  };
}

export function demoAnalytics(periodDays = 28) {
  const posts = demoPosts(periodDays * 2 + 4);
  const comparison = comparePeriods(posts, { days: periodDays });

  const recent = posts.filter(
    (post) => post.publishedAt.getTime() > Date.now() - periodDays * 86400000,
  );

  const retentionCurve = averageRetentionCurve(recent);

  return {
    posts,
    recent,
    comparison,
    totals: aggregate(recent),
    views: timeSeries(recent, 'views', { days: periodDays }),
    watchTime: timeSeries(recent, 'watchTimeSec', { days: periodDays }),
    followers: timeSeries(recent, 'followersGained', { days: periodDays }),
    top: topPerformers(recent, 5),
    retentionCurve,
    dropOff: findDropOff(retentionCurve),
    byPlatform: PLATFORM_MIX.map((entry) => ({
      label: entry.platform,
      value: recent
        .filter((post) => post.platform === entry.platform)
        .reduce((sum, post) => sum + post.metrics.views, 0),
    })).filter((entry) => entry.value > 0),
    cadence: analyzeCadence(recent.map((post) => post.publishedAt)),
    insight: fallbackInsight({
      comparison,
      top: topPerformers(recent, 5),
      periodDays,
      retentionCurve,
      postsPerWeek: analyzeCadence(recent.map((post) => post.publishedAt)).postsPerWeek,
    }),
    slots: recommendSlots(
      'tiktok',
      posts.map((post) => ({
        publishedAt: post.publishedAt,
        platform: post.platform,
        metrics: post.metrics,
      })),
    ),
  };
}

// ---------------------------------------------------------------------------
// Publishing queue
// ---------------------------------------------------------------------------

export interface DemoQueueItem {
  id: string;
  projectTitle: string;
  platform: PlatformId;
  status: 'scheduled' | 'queued' | 'published' | 'failed' | 'draft';
  scheduledFor: Date | null;
  caption: string;
  error?: string;
}

export function demoQueue(): DemoQueueItem[] {
  const now = Date.now();
  return [
    {
      id: 'q1',
      projectTitle: 'The one editing habit that doubled my watch time',
      platform: 'tiktok',
      status: 'scheduled',
      scheduledFor: new Date(now + 5 * 3600000),
      caption: 'The edit nobody talks about. #editing #contentcreator #videotips',
    },
    {
      id: 'q2',
      projectTitle: 'The one editing habit that doubled my watch time',
      platform: 'instagram',
      status: 'scheduled',
      scheduledFor: new Date(now + 26 * 3600000),
      caption: 'Same idea, tuned for Reels. #editing #reels',
    },
    {
      id: 'q3',
      projectTitle: 'Compound interest, explained in 30 seconds',
      platform: 'linkedin',
      status: 'queued',
      scheduledFor: new Date(now + 2 * 3600000),
      caption: 'A 30-second explainer on the maths most people meet too late.',
    },
    {
      id: 'q4',
      projectTitle: 'The lighthouse keeper who vanished in 1900',
      platform: 'youtube',
      status: 'published',
      scheduledFor: new Date(now - 20 * 3600000),
      caption: 'The full story is stranger than the theories. #history #shorts',
    },
    {
      id: 'q5',
      projectTitle: 'That 94th minute touch — slowed down',
      platform: 'tiktok',
      status: 'failed',
      scheduledFor: new Date(now - 3 * 3600000),
      caption: 'Pure technique. #football #edit',
      error: 'TikTok authorization expired. Reconnect the account and retry.',
    },
  ];
}
