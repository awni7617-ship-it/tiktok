import Link from 'next/link';
import {
  ArrowRight,
  Clapperboard,
  Cpu,
  Eye,
  Flame,
  Sparkles,
  TrendingUp,
  Upload,
} from 'lucide-react';
import { AppShell } from '@/components/shell';
import { Badge, Button, Card, SectionHeading, StatusDot } from '@/components/ui/primitives';
import { StatTile, TimeSeriesChart } from '@/components/charts';
import { compactNumber } from '@/lib/format';
import { DEMO_PROJECTS, demoAnalytics, demoQueue } from '@/server/demo/data';
import { ProjectCard } from '@/components/project-card';

export const metadata = { title: 'Dashboard' };

/**
 * Dashboard.
 *
 * Answers three questions in order of urgency: is anything broken, what
 * happened recently, and what should I do next. Everything below the fold is
 * context; everything above it is action.
 */
export default function DashboardPage() {
  const analytics = demoAnalytics(28);
  const queue = demoQueue();

  const failed = queue.filter((item) => item.status === 'failed');
  const upcoming = queue
    .filter((item) => item.status === 'scheduled' || item.status === 'queued')
    .sort((a, b) => (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0));

  const activeProjects = DEMO_PROJECTS.filter(
    (project) => project.status === 'ready' || project.status === 'analyzing' || project.status === 'rendering',
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Good to see you</h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {analytics.totals.posts} posts in the last 28 days · {analytics.cadence.postsPerWeek}/week ·{' '}
              {analytics.cadence.streakWeeks}-week streak
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon={<Upload className="size-4" />} className="hidden sm:inline-flex">
              Upload video
            </Button>
            <Link href="/studio">
              <Button variant="primary" icon={<Sparkles className="size-4" />}>
                Create with AI
              </Button>
            </Link>
          </div>
        </header>

        {failed.length > 0 ? (
          <div className="panel border-l-2 border-l-[var(--danger)] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">
                  {failed.length} post{failed.length === 1 ? '' : 's'} failed to publish
                </p>
                <p className="mt-0.5 text-sm text-[var(--text-muted)]">{failed[0]!.error}</p>
              </div>
              <Link href="/publish">
                <Button size="sm" variant="secondary">
                  Review queue
                </Button>
              </Link>
            </div>
          </div>
        ) : null}

        <section aria-label="Performance summary">
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
              label="Engagement rate"
              value={`${(analytics.totals.engagementRate * 100).toFixed(1)}%`}
              delta={analytics.comparison.change.engagementRate ?? null}
              hint="Interactions ÷ views"
            />
            <StatTile
              label="New followers"
              value={compactNumber(analytics.totals.followersGained)}
              delta={analytics.comparison.change.followersGained ?? null}
              spark={analytics.followers}
            />
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
          <Card>
            <SectionHeading
              title="Views over time"
              description="Daily totals across every connected platform."
              action={
                <Link href="/analytics">
                  <Button size="sm" variant="ghost" icon={<ArrowRight className="size-3.5" />}>
                    Details
                  </Button>
                </Link>
              }
            />
            <TimeSeriesChart points={analytics.views} label="Views" height={220} />
          </Card>

          <Card>
            <SectionHeading title="What the numbers say" description="Generated from your last 28 days." />
            <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{analytics.insight.summary}</p>

            {analytics.insight.actions.length > 0 ? (
              <ul className="mt-4 space-y-2.5">
                {analytics.insight.actions.slice(0, 3).map((action) => (
                  <li key={action} className="flex gap-2.5 text-sm">
                    <TrendingUp className="mt-0.5 size-4 shrink-0 text-[var(--accent)]" />
                    <span className="text-[var(--text-secondary)] text-pretty">{action}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>

        <section>
          <SectionHeading
            title="In progress"
            description="Projects still moving through analysis, editing or render."
            action={
              <Link href="/projects">
                <Button size="sm" variant="ghost">
                  All projects
                </Button>
              </Link>
            }
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {activeProjects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <SectionHeading
              title="Next up"
              description="Scheduled and queued posts."
              action={
                <Link href="/planner">
                  <Button size="sm" variant="ghost">
                    Calendar
                  </Button>
                </Link>
              }
            />
            <ul className="divide-y divide-[var(--border-subtle)]">
              {upcoming.slice(0, 4).map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-3 first:pt-0">
                  <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--surface-inset)]">
                    <Clapperboard className="size-4 text-[var(--text-muted)]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.projectTitle}</p>
                    <p className="text-xs text-[var(--text-muted)]">
                      {item.platform} ·{' '}
                      {item.scheduledFor?.toLocaleString(undefined, {
                        weekday: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                  <Badge tone={item.status === 'queued' ? 'accent' : 'neutral'}>{item.status}</Badge>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <SectionHeading title="Pipeline health" description="Background work across this workspace." />
            <dl className="grid grid-cols-2 gap-4">
              <HealthStat icon={<Cpu className="size-4" />} label="Jobs running" value="2" />
              <HealthStat icon={<Flame className="size-4" />} label="Queue depth" value="5" />
              <HealthStat icon={<Eye className="size-4" />} label="Renders today" value="8" />
              <HealthStat icon={<Clapperboard className="size-4" />} label="Storage used" value="4.2 GB" />
            </dl>
            <div className="mt-5 space-y-2 border-t border-[var(--border-subtle)] pt-4">
              <StatusDot tone="success" label="Transcription — healthy" />
              <StatusDot tone="success" label="Render workers — 2 online" />
              <StatusDot tone="warning" label="TikTok — 1 account needs reconnecting" />
            </div>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function HealthStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-inset)] p-3">
      <dt className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
