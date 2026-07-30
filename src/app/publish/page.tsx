import { AlertTriangle, CheckCircle2, Clock, Send } from 'lucide-react';
import { AppShell } from '@/components/shell';
import { Badge, Button, Card, Notice, SectionHeading } from '@/components/ui/primitives';
import { demoQueue } from '@/server/demo/data';
import { PLATFORMS } from '@/server/social/platforms';
import { humanDuration } from '@/lib/time';

export const metadata = { title: 'Publishing' };

const STATUS = {
  scheduled: { tone: 'neutral', icon: Clock, label: 'Scheduled' },
  queued: { tone: 'accent', icon: Send, label: 'Queued' },
  published: { tone: 'success', icon: CheckCircle2, label: 'Published' },
  failed: { tone: 'danger', icon: AlertTriangle, label: 'Failed' },
  draft: { tone: 'neutral', icon: Clock, label: 'Draft' },
} as const;

/**
 * Publishing queue.
 *
 * Publishing to someone's real accounts is the highest-consequence action in
 * the product, so the queue is explicit about state, shows the exact caption
 * that will be posted, and never retries a failure silently.
 */
export default function PublishPage() {
  const queue = demoQueue();
  const failed = queue.filter((item) => item.status === 'failed');

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Publishing</h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {queue.length} posts across your connected accounts
            </p>
          </div>
          <Button variant="primary" icon={<Send className="size-4" />}>
            New post
          </Button>
        </header>

        {failed.length > 0 ? (
          <Notice tone="danger" title="Action needed">
            {failed[0]!.error} Nothing will be retried automatically — reconnect the account, then
            publish again from this queue.
          </Notice>
        ) : null}

        <Card className="p-0">
          <ul className="divide-y divide-[var(--border-subtle)]">
            {queue.map((item) => {
              const status = STATUS[item.status];
              const platform = PLATFORMS[item.platform];
              const Icon = status.icon;

              return (
                <li key={item.id} className="p-4">
                  <div className="flex flex-wrap items-start gap-4">
                    <div
                      className="grid size-10 shrink-0 place-items-center rounded-xl text-white"
                      style={{ background: platform.color }}
                      aria-hidden
                    >
                      <Icon className="size-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium">{item.projectTitle}</p>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </div>

                      <p className="mt-1.5 text-sm text-[var(--text-secondary)] text-pretty">
                        {item.caption}
                      </p>

                      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
                        <span>{platform.name}</span>
                        {item.scheduledFor ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>
                              {item.status === 'published' ? 'Published' : 'Goes out'}{' '}
                              {item.scheduledFor.toLocaleString(undefined, {
                                weekday: 'short',
                                day: 'numeric',
                                month: 'short',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </span>
                          </>
                        ) : null}
                        <span aria-hidden>·</span>
                        <span>
                          Max {humanDuration(platform.capabilities.maxDurationSec)} ·{' '}
                          {platform.capabilities.maxDescriptionChars} char caption
                        </span>
                      </p>

                      {item.error ? (
                        <p className="mt-2 rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-xs text-[var(--danger)]">
                          {item.error}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 gap-2">
                      {item.status === 'failed' ? (
                        <Button size="sm" variant="primary">
                          Retry
                        </Button>
                      ) : null}
                      {item.status !== 'published' ? (
                        <Button size="sm" variant="ghost">
                          Edit
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost">
                          View post
                        </Button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          <SectionHeading
            title="Platform limits"
            description="Checked before a post is queued, so a rejection never happens mid-upload."
          />
          <div className="scroll-x">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th scope="col" className="pb-2 font-medium">Platform</th>
                  <th scope="col" className="pb-2 font-medium">Max length</th>
                  <th scope="col" className="pb-2 font-medium">Caption</th>
                  <th scope="col" className="pb-2 font-medium">Scheduling</th>
                  <th scope="col" className="pb-2 font-medium">Analytics</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(PLATFORMS).map((platform) => (
                  <tr key={platform.id} className="border-t border-[var(--border-subtle)]">
                    <td className="py-2.5">
                      <span className="flex items-center gap-2">
                        <span
                          className="size-2 rounded-full"
                          style={{ background: platform.color }}
                          aria-hidden
                        />
                        {platform.name}
                      </span>
                    </td>
                    <td className="py-2.5 tabular-nums text-[var(--text-secondary)]">
                      {humanDuration(platform.capabilities.maxDurationSec)}
                    </td>
                    <td className="py-2.5 tabular-nums text-[var(--text-secondary)]">
                      {platform.capabilities.maxDescriptionChars.toLocaleString()}
                    </td>
                    <td className="py-2.5 text-[var(--text-secondary)]">
                      {platform.capabilities.supportsScheduling ? 'Native' : 'Held in queue'}
                    </td>
                    <td className="py-2.5 text-[var(--text-secondary)]">
                      {platform.capabilities.supportsAnalytics ? 'Yes' : 'Not exposed'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
