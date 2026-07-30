import { CalendarDays, Clock, Repeat } from 'lucide-react';
import { AppShell } from '@/components/shell';
import { Badge, Card, Notice, SectionHeading } from '@/components/ui/primitives';
import { demoAnalytics, demoQueue } from '@/server/demo/data';
import { DAY_NAMES, formatSlot } from '@/server/planner';
import { PlannerCalendar } from '@/components/planner/calendar';

export const metadata = { title: 'Planner' };

/**
 * Content planner.
 *
 * Consistency is the thing that actually compounds, so the calendar leads with
 * cadence rather than with a slot-by-slot optimisation. Recommendations always
 * state what they are based on — the creator's own posts or general platform
 * guidance — because those deserve different levels of trust.
 */
export default function PlannerPage() {
  const analytics = demoAnalytics(28);
  const queue = demoQueue();

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Planner</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Drag posts between days to reschedule. Times shown in your local timezone.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-4">
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <Repeat className="size-3.5" />
              Cadence
            </div>
            <p className="mt-1.5 text-xl font-semibold tabular-nums">
              {analytics.cadence.postsPerWeek}
              <span className="ml-1 text-sm font-normal text-[var(--text-muted)]">/week</span>
            </p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <CalendarDays className="size-3.5" />
              Consistency
            </div>
            <p className="mt-1.5 text-xl font-semibold tabular-nums">
              {analytics.cadence.consistencyScore}
              <span className="ml-1 text-sm font-normal text-[var(--text-muted)]">/100</span>
            </p>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <Clock className="size-3.5" />
              Longest gap
            </div>
            <p className="mt-1.5 text-xl font-semibold tabular-nums">
              {analytics.cadence.longestGapDays}
              <span className="ml-1 text-sm font-normal text-[var(--text-muted)]">days</span>
            </p>
          </Card>
        </div>

        <Notice tone={analytics.cadence.consistencyScore >= 70 ? 'success' : 'warning'}>
          {analytics.cadence.recommendation}
        </Notice>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Card>
            <SectionHeading title="This week" description="Scheduled and queued posts." />
            <PlannerCalendar items={queue} />
          </Card>

          <div className="space-y-4">
            <Card>
              <SectionHeading
                title="Best times to post"
                description="Ranked for TikTok."
                className="mb-3"
              />
              <ul className="space-y-2">
                {analytics.slots.slice(0, 6).map((slot) => (
                  <li
                    key={`${slot.dayOfWeek}-${slot.hour}`}
                    className="rounded-lg border border-[var(--border-subtle)] p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{formatSlot(slot)}</span>
                      <Badge tone={slot.basis === 'platform-guidance' ? 'neutral' : 'accent'}>
                        {slot.basis === 'platform-guidance' ? 'general' : 'your data'}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-[var(--text-muted)] text-pretty">{slot.reason}</p>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <SectionHeading title="Posting rhythm" description="Last 28 days." className="mb-3" />
              <ul className="space-y-1.5">
                {DAY_NAMES.map((day, index) => {
                  const count = analytics.recent.filter(
                    (post) => post.publishedAt.getUTCDay() === index,
                  ).length;
                  const max = Math.max(
                    ...DAY_NAMES.map(
                      (_, i) => analytics.recent.filter((p) => p.publishedAt.getUTCDay() === i).length,
                    ),
                    1,
                  );

                  return (
                    <li key={day} className="flex items-center gap-2 text-xs">
                      <span className="w-8 shrink-0 text-[var(--text-muted)]">{day.slice(0, 3)}</span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-inset)]">
                        <div
                          className="h-full rounded-r-[4px] bg-[var(--accent)]"
                          style={{ width: `${(count / max) * 100}%` }}
                        />
                      </div>
                      <span className="w-4 shrink-0 text-right tabular-nums text-[var(--text-muted)]">
                        {count}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
