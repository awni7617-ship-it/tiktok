import { AppShell } from '@/components/shell';
import { Card, Notice, SectionHeading } from '@/components/ui/primitives';
import {
  BarChart,
  CategoricalSplit,
  RetentionCurve,
  StatTile,
  TimeSeriesChart,
} from '@/components/charts';
import { compactNumber } from '@/lib/format';
import { demoAnalytics } from '@/server/demo/data';

export const metadata = { title: 'Analytics' };

/**
 * Analytics dashboard.
 *
 * Every figure names its denominator, and comparisons against an empty prior
 * period report "no comparison" rather than a fabricated percentage. The
 * AI summary sits alongside the charts rather than replacing them — the reader
 * should always be able to check the narrative against the numbers.
 */
export default function AnalyticsPage() {
  const analytics = demoAnalytics(28);

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Last 28 days across {analytics.byPlatform.length} connected platforms
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Views"
            value={compactNumber(analytics.totals.views)}
            delta={analytics.comparison.change.views ?? null}
            spark={analytics.views}
          />
          <StatTile
            label="Watch time"
            value={compactNumber(analytics.totals.watchTimeHours)}
            suffix="hrs"
            delta={analytics.comparison.change.watchTimeHours ?? null}
            spark={analytics.watchTime}
          />
          <StatTile
            label="Avg. completion"
            value={`${(analytics.totals.averageCompletionRate * 100).toFixed(0)}%`}
            delta={analytics.comparison.change.averageCompletionRate ?? null}
            hint="Share of viewers reaching the end"
          />
          <StatTile
            label="Followers gained"
            value={compactNumber(analytics.totals.followersGained)}
            delta={analytics.comparison.change.followersGained ?? null}
            spark={analytics.followers}
          />
        </div>

        <Card>
          <SectionHeading title="What changed" description="Computed from the figures on this page." />
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
            {analytics.insight.summary}
          </p>

          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <InsightList title="Working" tone="success" items={analytics.insight.wins} />
            <InsightList title="Watch out" tone="warning" items={analytics.insight.concerns} />
            <InsightList title="Do next" tone="accent" items={analytics.insight.actions} />
          </div>
        </Card>

        <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <Card>
            <SectionHeading title="Views" description="Daily total across all platforms." />
            <TimeSeriesChart points={analytics.views} label="Views" height={240} />
          </Card>

          <Card>
            <SectionHeading title="Where views come from" description="Share of total views." />
            <CategoricalSplit data={analytics.byPlatform} />
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <SectionHeading
              title="Audience retention"
              description="Averaged across every post in the period."
            />
            <RetentionCurve
              curve={analytics.retentionCurve}
              dropOffPercent={analytics.dropOff?.atPercent ?? null}
            />
            {analytics.dropOff ? (
              <Notice tone="warning">
                The steepest fall is {analytics.dropOff.atPercent}% of the way through, where you lose{' '}
                {Math.round(analytics.dropOff.severity * 100)}% of the viewers still watching. That is
                usually a pacing problem, not a topic problem.
              </Notice>
            ) : null}
          </Card>

          <Card>
            <SectionHeading
              title="Top performing"
              description="Ranked on reach, engagement quality and completion — not views alone."
            />
            <BarChart
              data={analytics.top.map((post) => ({
                label: post.projectTitle,
                value: post.metrics.views,
                meta: `${post.platform} · ${(post.metrics.completionRate * 100).toFixed(0)}% completion · ${
                  post.metrics.shares
                } shares`,
              }))}
            />
          </Card>
        </div>

        <Card>
          <SectionHeading title="Watch time" description="Total seconds watched per day." />
          <TimeSeriesChart
            points={analytics.watchTime}
            label="Watch time"
            height={200}
            unit="hours"
          />
        </Card>
      </div>
    </AppShell>
  );
}

function InsightList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: 'success' | 'warning' | 'accent';
  items: string[];
}) {
  const dot = {
    success: 'bg-[var(--success)]',
    warning: 'bg-[var(--warning)]',
    accent: 'bg-[var(--accent)]',
  }[tone];

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Nothing to report.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item} className="flex gap-2 text-sm text-[var(--text-secondary)]">
              <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot}`} aria-hidden />
              <span className="text-pretty">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
