'use client';

import { useMemo, useState } from 'react';
import { Check, Download, Info, Music, Scissors, Send, Undo2, X } from 'lucide-react';
import type { EditPlan, Suggestion } from '@/lib/types';
import type { DemoProject } from '@/server/demo/data';
import { cutKey } from '@/server/edit/cutplan';
import { humanDuration } from '@/lib/time';
import { cn } from '@/lib/cn';
import {
  Badge,
  Button,
  Card,
  Notice,
  SectionHeading,
  Slider,
  Tabs,
  Toggle,
} from '@/components/ui/primitives';
import { ScoreRing } from '@/components/charts';
import { Timeline } from './timeline';

/**
 * Editor workspace.
 *
 * The organising principle is *review, not authoring*: the AI has already made
 * a complete set of decisions, and the interface's job is to make each one
 * visible, explain why it was made, and make reversing it a single click. That
 * is what "AI does the work, you keep control" has to mean in practice — a
 * black-box edit with an export button would be neither.
 */

type PanelTab = 'cuts' | 'captions' | 'audio' | 'frame' | 'optimize';

export interface EditorProps {
  project: DemoProject;
  plan: EditPlan;
  summary: ReturnType<typeof import('@/server/edit/plan').summarizePlan>;
  report: { suggestions: Suggestion[]; subScores: Record<string, number>; score: number };
}

export function EditorWorkspace({ project, plan, summary, report }: EditorProps) {
  const [tab, setTab] = useState<PanelTab>('cuts');
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [playhead, setPlayhead] = useState(0);

  /**
   * Recompute the effective cut set from the AI's confidence plus any explicit
   * user decision. Doing this in a memo (rather than mutating the plan) keeps
   * the original AI proposal intact, so "reset" is always possible.
   */
  const effectiveCuts = useMemo(
    () =>
      plan.cutPlan.cuts.map((cut, index) => {
        const key = cutKey(cut, index);
        const decision = decisions[key];
        return {
          cut,
          key,
          applied: decision ?? cut.confidence >= 0.65,
          overridden: decision !== undefined,
        };
      }),
    [plan.cutPlan.cuts, decisions],
  );

  const appliedCount = effectiveCuts.filter((entry) => entry.applied).length;
  const removedSec = effectiveCuts
    .filter((entry) => entry.applied)
    .reduce((sum, entry) => sum + (entry.cut.end - entry.cut.start), 0);
  const outputDuration = Math.max(0, plan.sourceDurationSec - removedSec);

  const openSuggestions = report.suggestions.filter(
    (suggestion) => !dismissed.has(suggestion.id) && !applied.has(suggestion.id),
  );

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-balance">{project.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--text-muted)]">
            <span>
              {humanDuration(plan.sourceDurationSec)} → {humanDuration(outputDuration)}
            </span>
            <span aria-hidden>·</span>
            <span>{appliedCount} cuts applied</span>
            <span aria-hidden>·</span>
            <span>{plan.captions.length} captions</span>
            <span aria-hidden>·</span>
            <span>{summary.removedPercent}% removed</span>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => setDecisions({})}>
            Reset to AI edit
          </Button>
          <Button variant="secondary" icon={<Download className="size-4" />}>
            Export
          </Button>
          <Button variant="primary" icon={<Send className="size-4" />}>
            Publish
          </Button>
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-5">
          <Card className="p-4">
            <div className="mx-auto w-full max-w-[340px]">
              <VideoPreview plan={plan} playhead={playhead} hue={project.thumbnailHue} />
            </div>
          </Card>

          <Card className="p-4">
            <Timeline
              plan={plan}
              cuts={effectiveCuts}
              playhead={playhead}
              onSeek={setPlayhead}
              onToggle={(key, next) => setDecisions((current) => ({ ...current, [key]: next }))}
            />
          </Card>
        </div>

        <aside className="space-y-4">
          <Card className="p-4">
            <div className="flex items-center gap-4">
              <ScoreRing score={report.score} size={84} />
              <div className="min-w-0">
                <p className="text-sm font-medium">Readiness score</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)] text-pretty">
                  {openSuggestions.length === 0
                    ? 'Every suggestion has been reviewed.'
                    : `${openSuggestions.length} suggestion${
                        openSuggestions.length === 1 ? '' : 's'
                      } left to review.`}
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-0">
            <div className="scroll-x border-b border-[var(--border-subtle)] p-3">
              <Tabs
                active={tab}
                onChange={setTab}
                tabs={[
                  { id: 'cuts', label: 'Cuts', count: plan.cutPlan.cuts.length },
                  { id: 'captions', label: 'Captions' },
                  { id: 'audio', label: 'Audio' },
                  { id: 'frame', label: 'Frame' },
                  { id: 'optimize', label: 'Optimize', count: openSuggestions.length },
                ]}
              />
            </div>

            <div className="max-h-[640px] overflow-y-auto p-4">
              {tab === 'cuts' ? (
                <CutsPanel
                  entries={effectiveCuts}
                  onToggle={(key, next) => setDecisions((current) => ({ ...current, [key]: next }))}
                  onSeek={setPlayhead}
                />
              ) : null}
              {tab === 'captions' ? <CaptionsPanel plan={plan} onSeek={setPlayhead} /> : null}
              {tab === 'audio' ? <AudioPanel plan={plan} /> : null}
              {tab === 'frame' ? <FramePanel plan={plan} /> : null}
              {tab === 'optimize' ? (
                <OptimizePanel
                  suggestions={report.suggestions}
                  dismissed={dismissed}
                  applied={applied}
                  onApply={(id) => setApplied((current) => new Set(current).add(id))}
                  onDismiss={(id) => setDismissed((current) => new Set(current).add(id))}
                />
              ) : null}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Vertical preview frame.
 *
 * Renders the caption that would be on screen at the playhead using the real
 * caption style, so what the user reviews matches what the renderer burns in.
 */
function VideoPreview({ plan, playhead, hue }: { plan: EditPlan; playhead: number; hue: number }) {
  const cue = plan.captions.find((entry) => playhead >= entry.start && playhead <= entry.end);
  const style = plan.captionStyle;

  return (
    <div
      className="relative aspect-[9/16] w-full overflow-hidden rounded-xl"
      style={{
        background: `linear-gradient(160deg,
          oklch(0.42 0.15 ${hue}),
          oklch(0.22 0.09 ${hue + 45}))`,
      }}
    >
      <div className="absolute inset-x-0 top-0 flex items-center justify-between p-3 text-[10px] text-white/70">
        <span>{humanDuration(playhead)}</span>
        <span>{plan.reframe ? '9:16 · auto-reframed' : '9:16'}</span>
      </div>

      {cue ? (
        <div
          className="absolute inset-x-4 text-center"
          style={{ top: `${style.positionY * 100}%`, transform: 'translateY(-50%)' }}
        >
          <p
            className="inline-block leading-tight"
            style={{
              fontWeight: style.bold ? 800 : 500,
              fontSize: 'clamp(14px, 5.2cqw, 22px)',
              textShadow: `0 2px 0 ${style.outlineColor}, 0 0 ${style.outlineWidth * 2}px ${style.outlineColor}`,
              WebkitTextStroke: `${Math.max(1, style.outlineWidth / 2)}px ${style.outlineColor}`,
              paintOrder: 'stroke fill',
            }}
          >
            {cue.tokens.map((token, index) => (
              <span
                key={`${token.text}-${index}`}
                style={{ color: token.highlight ? style.highlightColor : style.primaryColor }}
              >
                {style.uppercase ? token.text.toUpperCase() : token.text}{' '}
              </span>
            ))}
          </p>
        </div>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/60 to-transparent p-3">
        <span className="text-[10px] text-white/70">Preview · captions rendered from the live plan</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

interface CutEntry {
  cut: EditPlan['cutPlan']['cuts'][number];
  key: string;
  applied: boolean;
  overridden: boolean;
}

const REASON_LABEL: Record<string, string> = {
  silence: 'Silence',
  filler: 'Filler',
  repetition: 'Stutter',
  'false-start': 'False start',
  'long-pause': 'Long pause',
  'low-energy': 'Low energy',
  manual: 'Manual',
};

/**
 * Every proposed cut, with its reason, confidence and a one-click toggle.
 *
 * Confidence is shown as a number rather than hidden behind a threshold: the
 * user should be able to tell a 95%-certain "um" removal from a 60%-certain
 * discourse-marker trim, because they will want to review those differently.
 */
function CutsPanel({
  entries,
  onToggle,
  onSeek,
}: {
  entries: CutEntry[];
  onToggle: (key: string, next: boolean) => void;
  onSeek: (time: number) => void;
}) {
  if (entries.length === 0) {
    return (
      <Notice tone="success" title="Nothing to cut">
        The analysis found no silence, filler words or false starts worth removing.
      </Notice>
    );
  }

  return (
    <div className="space-y-2">
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Toggle any cut off to keep that moment. Nothing is final until you export.
      </p>

      {entries.map((entry) => (
        <div
          key={entry.key}
          className={cn(
            'rounded-xl border p-3 transition-colors',
            entry.applied
              ? 'border-[var(--border-default)] bg-[var(--surface-inset)]'
              : 'border-dashed border-[var(--border-subtle)] opacity-60',
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <button
              onClick={() => onSeek(entry.cut.start)}
              className="min-w-0 flex-1 text-left"
              aria-label={`Jump to ${entry.cut.start.toFixed(1)} seconds`}
            >
              <div className="flex items-center gap-2">
                <Badge tone={entry.cut.reason === 'filler' ? 'accent' : 'neutral'}>
                  {REASON_LABEL[entry.cut.reason] ?? entry.cut.reason}
                </Badge>
                <span className="font-mono text-xs text-[var(--text-muted)] tabular-nums">
                  {entry.cut.start.toFixed(2)}s – {entry.cut.end.toFixed(2)}s
                </span>
              </div>
              {entry.cut.note ? (
                <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{entry.cut.note}</p>
              ) : null}
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                Removes {((entry.cut.end - entry.cut.start) * 1000).toFixed(0)}ms ·{' '}
                {Math.round(entry.cut.confidence * 100)}% confident
                {entry.overridden ? ' · you overrode this' : ''}
              </p>
            </button>

            <button
              onClick={() => onToggle(entry.key, !entry.applied)}
              className={cn(
                'grid size-8 shrink-0 place-items-center rounded-lg border transition-colors',
                entry.applied
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                  : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--border-strong)]',
              )}
              aria-pressed={entry.applied}
              aria-label={entry.applied ? 'Keep this moment' : 'Apply this cut'}
            >
              {entry.applied ? <Scissors className="size-4" /> : <X className="size-4" />}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CaptionsPanel({ plan, onSeek }: { plan: EditPlan; onSeek: (time: number) => void }) {
  const [style, setStyle] = useState(plan.captionStyle);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <SectionHeading title="Style" description="Applies to every cue." className="mb-0" />

        <div className="grid grid-cols-2 gap-2">
          {(['karaoke', 'pop', 'slide-up', 'fade', 'typewriter', 'none'] as const).map((animation) => (
            <button
              key={animation}
              onClick={() => setStyle((current) => ({ ...current, animation }))}
              className={cn(
                'rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors',
                style.animation === animation
                  ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] text-[var(--text-primary)]'
                  : 'border-[var(--border-default)] text-[var(--text-muted)] hover:border-[var(--border-strong)]',
              )}
            >
              {animation.replace('-', ' ')}
            </button>
          ))}
        </div>

        <Slider
          id="caption-size"
          label="Size"
          min={32}
          max={96}
          value={style.fontSizePx}
          onChange={(value) => setStyle((current) => ({ ...current, fontSizePx: value }))}
          format={(value) => `${value}px`}
        />
        <Slider
          id="caption-position"
          label="Vertical position"
          min={0.3}
          max={0.9}
          step={0.01}
          value={style.positionY}
          onChange={(value) => setStyle((current) => ({ ...current, positionY: value }))}
          format={(value) => `${Math.round(value * 100)}% down`}
        />
        <Toggle
          id="caption-uppercase"
          label="Uppercase"
          checked={style.uppercase}
          onChange={(value) => setStyle((current) => ({ ...current, uppercase: value }))}
        />
      </div>

      <div>
        <SectionHeading
          title={`${plan.captions.length} cues`}
          description="Highlighted words are scaled and coloured on screen."
          className="mb-3"
        />
        <ul className="space-y-1.5">
          {plan.captions.slice(0, 40).map((cue) => (
            <li key={cue.index}>
              <button
                onClick={() => onSeek(cue.start)}
                className="w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
              >
                <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
                  {cue.start.toFixed(1)}s
                </span>
                <p className="mt-0.5 text-sm leading-snug">
                  {cue.tokens.map((token, index) => (
                    <span
                      key={index}
                      className={token.highlight ? 'font-semibold text-[var(--accent)]' : undefined}
                    >
                      {token.text}{' '}
                    </span>
                  ))}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function AudioPanel({ plan }: { plan: EditPlan }) {
  return (
    <div className="space-y-4">
      <Notice tone="accent" title="What the analysis decided">
        <ul className="mt-1.5 space-y-1">
          {plan.audio.notes.map((note) => (
            <li key={note} className="flex gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0 opacity-60" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </Notice>

      <dl className="grid grid-cols-2 gap-3">
        <Metric label="Target loudness" value={`${plan.audio.targetLufs} LUFS`} />
        <Metric label="True peak ceiling" value={`${plan.audio.targetTruePeakDb} dBTP`} />
        <Metric label="Noise reduction" value={plan.audio.denoise ? `${plan.audio.denoiseStrength} dB` : 'Off'} />
        <Metric
          label="Compression"
          value={plan.audio.compressorRatio ? `${plan.audio.compressorRatio}:1` : 'Off'}
        />
      </dl>

      <div className="border-t border-[var(--border-subtle)] pt-4">
        <SectionHeading title="Music bed" description="Copyright-safe library, ducked under narration." className="mb-3" />
        {plan.music ? (
          <div className="flex items-center gap-3 rounded-xl border border-[var(--border-default)] p-3">
            <div className="grid size-9 place-items-center rounded-lg bg-[var(--surface-inset)]">
              <Music className="size-4 text-[var(--accent)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{plan.music.title}</p>
              <p className="text-xs text-[var(--text-muted)]">
                {plan.music.license} · ducks {Math.abs(plan.music.duckDb)}dB under speech
              </p>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" icon={<Music className="size-4" />}>
            Add background music
          </Button>
        )}
      </div>
    </div>
  );
}

function FramePanel({ plan }: { plan: EditPlan }) {
  if (!plan.reframe) {
    return <Notice tone="neutral">Auto-reframe is turned off for this project.</Notice>;
  }

  return (
    <div className="space-y-4">
      <Notice tone={plan.reframe.isStaticFallback ? 'warning' : 'success'}>
        {plan.reframe.isStaticFallback
          ? 'No subject was detected, so the frame is a static centre crop. You can reposition it manually.'
          : `Tracking a subject across ${plan.reframe.keyframes.length} keyframes, smoothed to avoid jitter.`}
      </Notice>

      <dl className="grid grid-cols-2 gap-3">
        <Metric label="Source" value={`${plan.reframe.sourceWidth}×${plan.reframe.sourceHeight}`} />
        <Metric
          label="Crop window"
          value={`${plan.reframe.keyframes[0]?.width ?? 0}×${plan.reframe.keyframes[0]?.height ?? 0}`}
        />
        <Metric label="Keyframes" value={String(plan.reframe.keyframes.length)} />
        <Metric label="Motion cues" value={String(plan.motion.length)} />
      </dl>

      {plan.motion.length > 0 ? (
        <div>
          <SectionHeading title="Movement" description="Subtle pushes on the strongest beats." className="mb-3" />
          <ul className="space-y-2">
            {plan.motion.slice(0, 6).map((cue) => (
              <li key={`${cue.start}-${cue.kind}`} className="rounded-lg border border-[var(--border-subtle)] p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone="neutral">{cue.kind}</Badge>
                  <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
                    {cue.start.toFixed(1)}s – {cue.end.toFixed(1)}s
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-[var(--text-muted)]">{cue.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Suggestion review.
 *
 * Every item can be applied, dismissed or (where it carries replacement text)
 * edited first. Nothing here changes the project without an explicit click.
 */
function OptimizePanel({
  suggestions,
  dismissed,
  applied,
  onApply,
  onDismiss,
}: {
  suggestions: Suggestion[];
  dismissed: Set<string>;
  applied: Set<string>;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const open = suggestions.filter((s) => !dismissed.has(s.id) && !applied.has(s.id));

  if (open.length === 0) {
    return (
      <Notice tone="success" title="All reviewed">
        You have acted on every suggestion. Re-run the analysis after editing to get a fresh pass.
      </Notice>
    );
  }

  const IMPACT_TONE = { high: 'danger', medium: 'warning', low: 'neutral' } as const;

  return (
    <div className="space-y-3">
      {open.map((suggestion) => (
        <div key={suggestion.id} className="rounded-xl border border-[var(--border-default)] p-3.5">
          <div className="mb-2 flex items-center gap-2">
            <Badge tone={IMPACT_TONE[suggestion.impact]}>{suggestion.impact} impact</Badge>
            <span className="text-xs capitalize text-[var(--text-muted)]">{suggestion.area}</span>
          </div>

          <p className="text-sm font-medium">{suggestion.title}</p>
          <p className="mt-1 text-sm text-[var(--text-secondary)] text-pretty">{suggestion.detail}</p>

          {suggestion.evidence.length > 0 ? (
            <ul className="mt-2 space-y-0.5">
              {suggestion.evidence.map((item) => (
                <li key={item} className="font-mono text-[10px] text-[var(--text-muted)]">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}

          {suggestion.action && 'value' in suggestion.action && typeof suggestion.action.value === 'string' ? (
            <textarea
              defaultValue={suggestion.action.value}
              rows={2}
              aria-label="Suggested replacement — edit before applying"
              className="mt-3 w-full rounded-lg border border-[var(--border-default)] bg-[var(--surface-inset)] px-3 py-2 text-sm"
            />
          ) : null}

          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => onApply(suggestion.id)}>
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDismiss(suggestion.id)}>
              Not this time
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-inset)] p-2.5">
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}
