'use client';

import { useState } from 'react';
import { Loader2, Mic, Sparkles, Wand2 } from 'lucide-react';
import type { ContentNiche, GeneratedContent, PlatformId } from '@/lib/types';
import { NICHES, NICHE_LABELS } from '@/lib/niches';
import { VOICES } from '@/lib/voices';
import {
  Badge,
  Button,
  Card,
  Field,
  Notice,
  SectionHeading,
  Select,
  Slider,
  Textarea,
  Toggle,
} from '@/components/ui/primitives';
import { cn } from '@/lib/cn';
import { humanDuration } from '@/lib/time';

/**
 * AI Studio: prompt or script in, a complete production package out.
 *
 * The generated package is presented as editable fields rather than a preview
 * — a creator's voice is the product, and a tool that makes their script hard
 * to change has misunderstood its job. Every variant the model produced is one
 * click away.
 */


const PLATFORMS: PlatformId[] = ['tiktok', 'youtube', 'instagram', 'facebook', 'linkedin', 'pinterest', 'x'];

export function StudioComposer() {
  const [prompt, setPrompt] = useState('');
  const [niche, setNiche] = useState<ContentNiche>('storytelling');
  const [platform, setPlatform] = useState<PlatformId>('tiktok');
  const [duration, setDuration] = useState(35);
  const [tone, setTone] = useState('');
  const [useAsScript, setUseAsScript] = useState(false);
  const [faceless, setFaceless] = useState(true);
  const [voiceId, setVoiceId] = useState(VOICES[1]!.id);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GeneratedContent | null>(null);

  const generate = async () => {
    if (prompt.trim().length < 8) {
      setError('Give the model a little more to work with — a sentence is plenty.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          niche,
          platform,
          targetDurationSec: duration,
          tone: tone || undefined,
          useAsScript,
        }),
      });

      const payload = (await response.json()) as { content?: GeneratedContent; error?: string };
      if (!response.ok || !payload.content) {
        throw new Error(payload.error ?? 'Generation failed');
      }

      setResult(payload.content);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">AI Studio</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Describe an idea or paste a script. You get a title, hook, scene-by-scene breakdown,
          narration and metadata — all editable before anything renders.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <Card className="h-fit space-y-5">
          <Field
            label={useAsScript ? 'Your script' : 'Your idea'}
            htmlFor="prompt"
            required
            hint={
              useAsScript
                ? 'Kept in your voice — only lines that drag get tightened.'
                : 'One or two sentences is enough. Be specific about the angle.'
            }
          >
            <Textarea
              id="prompt"
              rows={useAsScript ? 10 : 4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={
                useAsScript
                  ? 'Paste your full script here…'
                  : 'e.g. Why the 1518 dancing plague is stranger than any horror film'
              }
            />
          </Field>

          <Toggle
            id="use-as-script"
            label="I already have a script"
            description="Structure what I wrote instead of writing something new."
            checked={useAsScript}
            onChange={setUseAsScript}
          />

          <div className="grid grid-cols-2 gap-3">
            <Field label="Content type" htmlFor="niche">
              <Select id="niche" value={niche} onChange={(event) => setNiche(event.target.value as ContentNiche)}>
                {NICHES.map((value) => (
                  <option key={value} value={value}>
                    {NICHE_LABELS[value]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Platform" htmlFor="platform">
              <Select
                id="platform"
                value={platform}
                onChange={(event) => setPlatform(event.target.value as PlatformId)}
              >
                {PLATFORMS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Slider
            id="duration"
            label="Target length"
            min={10}
            max={180}
            step={5}
            value={duration}
            onChange={setDuration}
            format={(value) => humanDuration(value)}
          />

          <Field label="Tone" htmlFor="tone" hint="Optional. e.g. deadpan, urgent, warm.">
            <Textarea id="tone" rows={2} value={tone} onChange={(event) => setTone(event.target.value)} />
          </Field>

          <div className="space-y-3 border-t border-[var(--border-subtle)] pt-4">
            <Toggle
              id="faceless"
              label="Faceless video"
              description="AI narration over stock and generated visuals."
              checked={faceless}
              onChange={setFaceless}
            />

            {faceless ? (
              <Field label="Narration voice" htmlFor="voice">
                <Select id="voice" value={voiceId} onChange={(event) => setVoiceId(event.target.value)}>
                  {VOICES.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name} — {voice.style}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button variant="primary" size="lg" className="w-full" loading={loading} onClick={generate}>
            {loading ? 'Writing…' : 'Generate'}
          </Button>
        </Card>

        <div className="space-y-4">
          {loading ? <GeneratingState /> : null}
          {!loading && !result ? <IdleState /> : null}
          {!loading && result ? <GeneratedPackage content={result} faceless={faceless} /> : null}
        </div>
      </div>
    </div>
  );
}

function IdleState() {
  return (
    <Card className="grid min-h-80 place-items-center text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-[var(--surface-hover)]">
          <Wand2 className="size-5 text-[var(--text-muted)]" />
        </div>
        <h2 className="text-sm font-semibold">Your script will appear here</h2>
        <p className="mt-1.5 text-sm text-[var(--text-muted)] text-pretty">
          Everything is editable — swap the hook, rewrite a scene, change the hashtags. Nothing
          renders until you say so.
        </p>
      </div>
    </Card>
  );
}

function GeneratingState() {
  const steps = ['Shaping the hook', 'Writing the script', 'Breaking it into scenes', 'Picking visuals and metadata'];

  return (
    <Card className="min-h-80 space-y-4">
      <div className="flex items-center gap-2.5">
        <Loader2 className="size-4 animate-spin text-[var(--accent)]" />
        <p className="text-sm font-medium">Working on it</p>
      </div>
      <ul className="space-y-2.5">
        {steps.map((step, index) => (
          <li
            key={step}
            className="flex items-center gap-2.5 text-sm text-[var(--text-muted)] animate-fade-up"
            style={{ animationDelay: `${index * 120}ms` }}
          >
            <span className="size-1.5 rounded-full bg-[var(--accent)]" />
            {step}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GeneratedPackage({ content, faceless }: { content: GeneratedContent; faceless: boolean }) {
  const [title, setTitle] = useState(content.title);
  const [hook, setHook] = useState(content.hook);

  return (
    <div className="space-y-4 animate-fade-up">
      <Card>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Badge tone="accent">
            <Sparkles className="size-3" />
            {content.niche.replace('-', ' ')}
          </Badge>
          <Badge tone="neutral">{humanDuration(content.estimatedDurationSec)}</Badge>
          <Badge tone="neutral">{content.scenes.length} scenes</Badge>
          {faceless ? (
            <Badge tone="neutral">
              <Mic className="size-3" />
              narrated
            </Badge>
          ) : null}
        </div>

        <Field label="Title" htmlFor="gen-title">
          <Textarea id="gen-title" rows={2} value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        {content.titleVariants.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {content.titleVariants.map((variant) => (
              <button
                key={variant}
                onClick={() => setTitle(variant)}
                className="rounded-full border border-[var(--border-default)] px-2.5 py-1 text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
              >
                {variant.length > 48 ? `${variant.slice(0, 48)}…` : variant}
              </button>
            ))}
          </div>
        ) : null}

        <Field label="Hook" htmlFor="gen-hook" className="mt-4" hint="The first thing anyone hears. Keep it under two seconds spoken.">
          <Textarea id="gen-hook" rows={2} value={hook} onChange={(event) => setHook(event.target.value)} />
        </Field>

        {content.hookVariants.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            {content.hookVariants.map((variant) => (
              <button
                key={variant}
                onClick={() => setHook(variant)}
                className="block w-full rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-left text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]"
              >
                {variant}
              </button>
            ))}
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionHeading title="Scenes" description="Narration plus what should be on screen." />
        <ol className="space-y-3">
          {content.scenes.map((scene) => (
            <li key={scene.index} className="rounded-xl border border-[var(--border-subtle)] p-3.5">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--text-muted)]">
                  Scene {scene.index + 1}
                </span>
                <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
                  {scene.estimatedDurationSec.toFixed(1)}s
                </span>
              </div>

              <p className="text-sm leading-relaxed">{scene.narration}</p>

              <p className="mt-2 flex gap-1.5 text-xs text-[var(--text-muted)]">
                <span className="shrink-0 font-medium">On screen:</span>
                <span className="text-pretty">{scene.visual}</span>
              </p>

              {scene.brollQueries.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {scene.brollQueries.map((query) => (
                    <span
                      key={query}
                      className="rounded bg-[var(--surface-inset)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]"
                    >
                      {query}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <SectionHeading title="Metadata" description="Ready to paste, or edit first." />

        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-sm font-medium text-[var(--text-secondary)]">Description</p>
            <p className="rounded-lg bg-[var(--surface-inset)] p-3 text-sm leading-relaxed">
              {content.description}
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-[var(--text-secondary)]">Call to action</p>
            <p className="rounded-lg bg-[var(--surface-inset)] p-3 text-sm">{content.callToAction}</p>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-[var(--text-secondary)]">Hashtags</p>
            <div className="flex flex-wrap gap-1.5">
              {content.hashtags.map((tag) => (
                <span
                  key={tag}
                  className={cn(
                    'rounded-full border border-[var(--border-default)] px-2.5 py-1 text-xs',
                    'text-[var(--text-secondary)]',
                  )}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {content.thumbnailIdeas.length > 0 ? (
            <div>
              <p className="mb-1.5 text-sm font-medium text-[var(--text-secondary)]">Thumbnail ideas</p>
              <ul className="space-y-1.5">
                {content.thumbnailIdeas.map((idea) => (
                  <li key={idea} className="text-sm text-[var(--text-muted)] text-pretty">
                    · {idea}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap gap-2 border-t border-[var(--border-subtle)] pt-4">
          <Button variant="primary" icon={<Sparkles className="size-4" />}>
            Build this video
          </Button>
          <Button variant="ghost">Save as draft</Button>
        </div>
      </Card>
    </div>
  );
}
