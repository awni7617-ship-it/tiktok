'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Check, TriangleAlert } from 'lucide-react';
import { send, useData } from '@/components/use-data';
import { Button, Card, Field, inputClass } from '@/components/ui';
import { PLATFORMS } from '@/lib/catalog';
import type { PlatformId, SettingsView } from '@/lib/types';

const ENV_HINT: Record<PlatformId, string> = {
  tiktok: 'TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET',
  instagram: 'INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET',
  youtube: 'YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET',
};

function ConnectionResult() {
  const params = useSearchParams();
  const connected = params.get('connected');
  if (!connected) return null;

  if (connected === 'failed' || connected === 'cancelled') {
    return (
      <Card className="border-rose-500/40 text-sm text-rose-400">
        {connected === 'cancelled'
          ? 'Connection cancelled.'
          : `Connection failed. ${params.get('reason') ?? ''}`}
      </Card>
    );
  }

  return (
    <Card className="border-mint-500/40 text-sm text-mint-400">
      Connected {PLATFORMS.find((p) => p.id === connected)?.name ?? connected}.
    </Card>
  );
}

export default function SettingsPage() {
  const { data, error, reload } = useData<SettingsView>('/api/settings', 0);
  const [anthropic, setAnthropic] = useState('');
  const [openai, setOpenai] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function saveKeys() {
    setSaving(true);
    setProblem(null);
    try {
      const patch: Record<string, string> = {};
      if (anthropic.trim()) patch.anthropicApiKey = anthropic.trim();
      if (openai.trim()) patch.openaiApiKey = openai.trim();
      await send('/api/settings', 'PATCH', patch);
      setAnthropic('');
      setOpenai('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await reload();
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function disconnect(platform: PlatformId) {
    await send(`/api/social/${platform}`, 'DELETE').catch(() => undefined);
    await reload();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Keys are stored on this machine and never sent to the browser.
        </p>
      </div>

      <Suspense fallback={null}>
        <ConnectionResult />
      </Suspense>

      {error && <Card className="border-rose-500/40 text-sm text-rose-400">{error}</Card>}

      {data && !data.ffmpeg && (
        <Card className="flex items-start gap-3 border-amber-400/40 text-sm text-amber-400">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            ffmpeg was not found, so videos cannot be rendered. It normally ships with the install —
            reinstall dependencies, or set <code>FFMPEG_PATH</code>.
          </span>
        </Card>
      )}

      <Card className="space-y-5">
        <div>
          <h2 className="font-medium">AI keys</h2>
          <p className="mt-1 text-sm text-muted">
            Without these everything still runs, on offline stand-ins: template scripts, silent
            narration timed to the words, and gradient visuals.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Anthropic"
            hint={
              data?.anthropic ? 'Set — Claude writes the scripts.' : 'Not set — scripts are templates.'
            }
          >
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              value={anthropic}
              onChange={(e) => setAnthropic(e.target.value)}
              placeholder={data?.anthropic ? '••••••••' : 'sk-ant-…'}
            />
          </Field>

          <Field
            label="OpenAI"
            hint={
              data?.openai
                ? 'Set — real voiceover and images.'
                : 'Not set — silent narration, gradient visuals.'
            }
          >
            <input
              className={inputClass}
              type="password"
              autoComplete="off"
              value={openai}
              onChange={(e) => setOpenai(e.target.value)}
              placeholder={data?.openai ? '••••••••' : 'sk-…'}
            />
          </Field>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={saveKeys} disabled={saving}>
            {saving ? 'Saving…' : 'Save keys'}
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1.5 text-sm text-mint-400">
              <Check size={15} aria-hidden />
              Saved
            </span>
          )}
        </div>

        {problem && <p className="text-sm text-rose-400">{problem}</p>}

        {data && (
          <dl className="grid grid-cols-3 gap-3 border-t border-app pt-4 text-sm">
            {(['script', 'voice', 'image'] as const).map((capability) => (
              <div key={capability}>
                <dt className="text-xs capitalize text-faint">{capability}</dt>
                <dd className="mt-0.5">{data.providers[capability]}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card className="space-y-4">
        <div>
          <h2 className="font-medium">Accounts</h2>
          <p className="mt-1 text-sm text-muted">
            Each platform needs its own registered app before it will accept a post. Set the
            credentials in the environment, restart, then connect here.
          </p>
        </div>

        <div className="space-y-2">
          {PLATFORMS.map((platform) => {
            const account = data?.accounts.find((a) => a.platform === platform.id);
            const configurable = data?.configurable.includes(platform.id) ?? false;

            return (
              <div
                key={platform.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-app px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{platform.name}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {account
                      ? account.expired
                        ? `${account.displayName} — token expired, reconnect`
                        : account.displayName
                      : configurable
                        ? 'Not connected'
                        : `Set ${ENV_HINT[platform.id]}`}
                  </p>
                </div>

                {account ? (
                  <Button size="sm" variant="danger" onClick={() => disconnect(platform.id)}>
                    Disconnect
                  </Button>
                ) : (
                  <a href={configurable ? `/api/social/${platform.id}/authorize` : undefined}>
                    <Button size="sm" disabled={!configurable}>
                      Connect
                    </Button>
                  </a>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {data && (
        <p className="text-xs text-faint">
          Videos and settings live in <code>{data.outputDir}</code>.
        </p>
      )}
    </div>
  );
}
