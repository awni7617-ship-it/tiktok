'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { Badge, Button, Card, Field, Input, Notice, SectionHeading } from '@/components/ui/primitives';

/**
 * Where the app gets its intelligence.
 *
 * Without this screen the desktop app could only ever use the offline
 * providers: there is no shell to export an environment variable in, so the
 * real models were unreachable no matter what the user had paid for. That one
 * gap is why every video came out generic.
 *
 * Keys are written to a file in the app's own data directory and never sent
 * back to the browser — the form shows only whether one is set.
 */

interface Status {
  keys: {
    anthropic: { configured: boolean; source: string; model: string };
    openai: { configured: boolean; source: string };
    elevenLabs: { configured: boolean; source: string };
  };
  providers: Record<string, { configured: string; active: string }>;
  rendering: { available: boolean; mode?: string; detail?: string };
  storageDir: string;
}

const CAPABILITY_LABELS: Record<string, string> = {
  llm: 'Scripts',
  image: 'Visuals',
  tts: 'Narration',
  asr: 'Transcription',
};

export function SettingsKeys() {
  const [status, setStatus] = useState<Status | null>(null);
  const [anthropic, setAnthropic] = useState('');
  const [openai, setOpenai] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      setStatus((await response.json()) as Status);
    } catch {
      setError('Could not read the current settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);

    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Only send what was typed: an untouched field must not clear a key
        // that is already stored.
        body: JSON.stringify({
          ...(anthropic ? { anthropicApiKey: anthropic } : {}),
          ...(openai ? { openaiApiKey: openai } : {}),
        }),
      });

      if (!response.ok) throw new Error('Could not save');

      setAnthropic('');
      setOpenai('');
      setSaved(true);
      await load();
    } catch {
      setError('Could not save those keys.');
    } finally {
      setSaving(false);
    }
  };

  if (!status) {
    return (
      <Card className="grid min-h-48 place-items-center">
        <Loader2 className="size-5 animate-spin text-[var(--text-muted)]" />
      </Card>
    );
  }

  const usingOffline = Object.values(status.providers).some((entry) => entry.active === 'mock');

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Phantom works with no keys at all, using offline stand-ins. Add real ones and the same
          pipeline produces real writing, real voices and real imagery.
        </p>
      </header>

      {usingOffline ? (
        <Notice tone="warning" title="Running on offline stand-ins">
          Scripts are template-generated, narration is synthetic tone, and visuals are gradients.
          That is why videos come out generic. Add a key below to change it.
        </Notice>
      ) : null}

      <Card className="space-y-5">
        <SectionHeading
          title="AI keys"
          description="Stored on this computer only, in the app's own data folder."
        />

        <Field
          label="Anthropic API key"
          htmlFor="anthropic"
          hint="Writes the scripts — hook, scenes, narration, description, hashtags."
        >
          <Input
            id="anthropic"
            type="password"
            autoComplete="off"
            placeholder={status.keys.anthropic.configured ? 'Set — paste a new key to replace it' : 'sk-ant-…'}
            value={anthropic}
            onChange={(event) => setAnthropic(event.target.value)}
          />
        </Field>

        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] underline-offset-2 hover:underline"
        >
          Get an Anthropic key <ExternalLink className="size-3" />
        </a>

        <Field
          label="OpenAI API key"
          htmlFor="openai"
          hint="Generates the images and speaks the narration."
        >
          <Input
            id="openai"
            type="password"
            autoComplete="off"
            placeholder={status.keys.openai.configured ? 'Set — paste a new key to replace it' : 'sk-…'}
            value={openai}
            onChange={(event) => setOpenai(event.target.value)}
          />
        </Field>

        <a
          href="https://platform.openai.com/api-keys"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] underline-offset-2 hover:underline"
        >
          Get an OpenAI key <ExternalLink className="size-3" />
        </a>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            loading={saving}
            disabled={!anthropic && !openai}
            onClick={() => void save()}
          >
            Save keys
          </Button>
          {saved ? (
            <span className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)]">
              <Check className="size-4" /> Saved — the next video uses them
            </span>
          ) : null}
        </div>
      </Card>

      <Card className="space-y-4">
        <SectionHeading
          title="What is serving each part"
          description="What is running right now, not what is configured in theory."
        />

        <dl className="space-y-2">
          {Object.entries(status.providers).map(([capability, entry]) => (
            <div key={capability} className="flex items-center justify-between gap-3">
              <dt className="text-sm">{CAPABILITY_LABELS[capability] ?? capability}</dt>
              <dd>
                <Badge tone={entry.active === 'mock' ? 'warning' : 'success'}>
                  {entry.active === 'mock' ? 'offline stand-in' : entry.active}
                </Badge>
              </dd>
            </div>
          ))}

          <div className="flex items-center justify-between gap-3">
            <dt className="text-sm">Video rendering</dt>
            <dd>
              <Badge tone={status.rendering.available ? 'success' : 'danger'}>
                {status.rendering.available ? 'ffmpeg ready' : 'unavailable'}
              </Badge>
            </dd>
          </div>
        </dl>

        <p className="border-t border-[var(--border-subtle)] pt-3 text-xs text-[var(--text-muted)]">
          Videos are saved to <code className="break-all">{status.storageDir}</code>
        </p>
      </Card>
    </div>
  );
}
