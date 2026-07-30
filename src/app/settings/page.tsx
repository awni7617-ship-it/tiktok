import { Link2, ShieldCheck } from 'lucide-react';
import { AppShell } from '@/components/shell';
import { Badge, Button, Card, Notice, SectionHeading } from '@/components/ui/primitives';
import { PLATFORMS, isPlatformConfigured } from '@/server/social/platforms';
import { describeProviders } from '@/server/ai/registry';
import { config } from '@/server/config';

export const metadata = { title: 'Settings' };

/**
 * Settings.
 *
 * Two things are surfaced honestly here because hiding them erodes trust: what
 * each connection can actually do with the user's account, and which AI
 * provider is really serving each capability (including when it has fallen
 * back to the offline mock).
 */
export default function SettingsPage() {
  const providers = describeProviders();

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Connections, AI providers and workspace configuration
          </p>
        </header>

        <Card>
          <SectionHeading
            title="Connected accounts"
            description="Phantom never posts anywhere you have not explicitly authorised."
          />

          <Notice tone="accent" title="How authorisation works">
            Connecting uses each platform&apos;s own OAuth flow. Phantom stores an encrypted access
            token, never your password, and you can revoke it here or from the platform at any time.
          </Notice>

          <ul className="mt-4 divide-y divide-[var(--border-subtle)]">
            {Object.values(PLATFORMS).map((platform) => {
              const configured = isPlatformConfigured(platform.id);

              return (
                <li key={platform.id} className="flex flex-wrap items-center gap-4 py-4 first:pt-0">
                  <div
                    className="grid size-10 shrink-0 place-items-center rounded-xl text-sm font-semibold text-white"
                    style={{ background: platform.color }}
                    aria-hidden
                  >
                    {platform.name.slice(0, 1)}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{platform.name}</p>
                      {!configured ? <Badge tone="neutral">Not configured</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--text-muted)] text-pretty">
                      {platform.permissionSummary}
                    </p>
                  </div>

                  <Button
                    size="sm"
                    variant={configured ? 'secondary' : 'ghost'}
                    disabled={!configured}
                    icon={<Link2 className="size-3.5" />}
                    title={
                      configured
                        ? undefined
                        : `Set ${platform.oauth.clientIdEnv} and ${platform.oauth.clientSecretEnv} to enable this`
                    }
                  >
                    {configured ? 'Connect' : 'Unavailable'}
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          <SectionHeading
            title="AI providers"
            description="What is actually serving each capability right now."
          />

          <ul className="space-y-2">
            {Object.entries(providers).map(([capability, provider]) => {
              const fellBack = provider.configured !== provider.active;

              return (
                <li
                  key={capability}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-subtle)] p-3"
                >
                  <div>
                    <p className="text-sm font-medium capitalize">{capability}</p>
                    <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                      Configured: {provider.configured} · Active: {provider.active}
                    </p>
                  </div>
                  <Badge tone={fellBack ? 'warning' : 'success'}>
                    {fellBack ? 'fell back to mock' : 'live'}
                  </Badge>
                </li>
              );
            })}
          </ul>

          <Notice tone="neutral">
            A capability falls back to the offline provider when its API key is missing. Everything
            keeps working — the output is deterministic sample content rather than model output.
          </Notice>
        </Card>

        <Card>
          <SectionHeading title="Environment" description="Read-only view of this deployment." />
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Storage driver" value={config.STORAGE_DRIVER} />
            <Detail label="Worker concurrency" value={String(config.WORKER_CONCURRENCY)} />
            <Detail label="Model" value={config.ANTHROPIC_MODEL} />
            <Detail label="Effort" value={config.ANTHROPIC_EFFORT} />
            <Detail label="Max upload" value={`${Math.round(config.MAX_UPLOAD_BYTES / 1024 ** 3)} GB`} />
            <Detail label="Job retries" value={String(config.JOB_MAX_ATTEMPTS)} />
          </dl>

          <div className="mt-4 flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-inset)] p-3 text-xs text-[var(--text-muted)]">
            <ShieldCheck className="size-4 shrink-0 text-[var(--success)]" />
            <span>
              OAuth tokens are encrypted at rest with AES-256-GCM and are never returned to the
              browser.
            </span>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] p-3">
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  );
}
