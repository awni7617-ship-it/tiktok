'use client';

import { useRef } from 'react';
import type { EditPlan } from '@/lib/types';
import { humanDuration } from '@/lib/time';
import { cn } from '@/lib/cn';

/**
 * Edit timeline.
 *
 * Shows the *source* timeline with proposed cuts overlaid, rather than the
 * already-edited output. That choice is deliberate: the user needs to see what
 * is being removed in order to judge it. An output-only timeline would hide
 * exactly the information the review depends on.
 */

interface CutEntry {
  cut: EditPlan['cutPlan']['cuts'][number];
  key: string;
  applied: boolean;
}

export function Timeline({
  plan,
  cuts,
  playhead,
  onSeek,
  onToggle,
}: {
  plan: EditPlan;
  cuts: CutEntry[];
  playhead: number;
  onSeek: (time: number) => void;
  onToggle: (key: string, next: boolean) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const duration = Math.max(plan.sourceDurationSec, 0.001);

  const seekFromEvent = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = (clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(duration, ratio * duration)));
  };

  const percent = (value: number) => `${(value / duration) * 100}%`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono tabular-nums text-[var(--text-secondary)]">
          {humanDuration(playhead)} / {humanDuration(duration)}
        </span>
        <div className="flex items-center gap-3 text-[var(--text-muted)]">
          <LegendSwatch className="bg-[var(--accent)]" label="Kept" />
          <LegendSwatch className="bg-[var(--danger)]/60" label="Cut" />
          <LegendSwatch className="bg-[var(--success)]" label="Moment" />
        </div>
      </div>

      {/*
        Keyboard access: the track is a slider, so arrow keys scrub. A
        click-only timeline would be unusable without a mouse.
      */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Timeline position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(playhead)}
        aria-valuetext={`${humanDuration(playhead)} of ${humanDuration(duration)}`}
        onClick={(event) => seekFromEvent(event.clientX)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 5 : 1;
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            onSeek(Math.min(duration, playhead + step));
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            onSeek(Math.max(0, playhead - step));
          }
          if (event.key === 'Home') onSeek(0);
          if (event.key === 'End') onSeek(duration);
        }}
        className="relative h-20 w-full cursor-pointer overflow-hidden rounded-xl bg-[var(--surface-inset)]"
      >
        {/* Waveform stand-in, seeded from the plan so it is stable. */}
        <div className="absolute inset-x-0 top-3 flex h-10 items-center gap-px px-px">
          {Array.from({ length: 160 }, (_, index) => {
            const time = (index / 160) * duration;
            const inCut = cuts.some(
              (entry) => entry.applied && time >= entry.cut.start && time <= entry.cut.end,
            );
            // Deterministic pseudo-amplitude — a real render replaces this
            // with the ffmpeg-generated waveform image.
            const amplitude = inCut
              ? 0.06
              : 0.25 + Math.abs(Math.sin(index * 0.7) * 0.35 + Math.sin(index * 0.23) * 0.3);

            return (
              <span
                key={index}
                className={cn(
                  'flex-1 rounded-full transition-colors',
                  inCut ? 'bg-[var(--border-strong)]' : 'bg-[var(--accent)]/55',
                )}
                style={{ height: `${Math.min(100, amplitude * 100)}%` }}
              />
            );
          })}
        </div>

        {/* Cut regions */}
        {cuts.map((entry) => (
          <button
            key={entry.key}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(entry.key, !entry.applied);
            }}
            title={`${entry.cut.note ?? entry.cut.reason} — click to ${
              entry.applied ? 'keep' : 'cut'
            }`}
            aria-label={`${entry.applied ? 'Applied' : 'Skipped'} ${entry.cut.reason} cut at ${entry.cut.start.toFixed(1)} seconds`}
            className={cn(
              'absolute top-0 h-14 border-x transition-colors',
              entry.applied
                ? 'border-[var(--danger)]/50 bg-[var(--danger)]/25 hover:bg-[var(--danger)]/35'
                : 'border-dashed border-[var(--border-strong)] bg-transparent hover:bg-[var(--surface-hover)]',
            )}
            style={{
              left: percent(entry.cut.start),
              width: `max(2px, ${((entry.cut.end - entry.cut.start) / duration) * 100}%)`,
            }}
          />
        ))}

        {/* High-scoring moments */}
        {plan.moments.slice(0, 6).map((moment) => (
          <div
            key={`${moment.start}-${moment.end}`}
            className="absolute bottom-2 h-1.5 rounded-full bg-[var(--success)]"
            style={{
              left: percent(moment.start),
              width: `max(4px, ${((moment.end - moment.start) / duration) * 100}%)`,
              opacity: 0.4 + moment.score * 0.6,
            }}
            title={`Engagement ${Math.round(moment.score * 100)}% — ${moment.signals.join(', ')}`}
          />
        ))}

        {/* Playhead */}
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--text-primary)]"
          style={{ left: percent(playhead) }}
        >
          <div className="absolute -left-1.5 -top-0.5 size-3.5 rounded-full border-2 border-[var(--surface-base)] bg-[var(--text-primary)]" />
        </div>
      </div>

      {plan.variations.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">
            Clip variations the AI found
          </p>
          <div className="scroll-x flex gap-2 pb-1">
            {plan.variations.map((variation) => (
              <button
                key={variation.id}
                onClick={() => onSeek(variation.range.start)}
                className="shrink-0 rounded-lg border border-[var(--border-default)] bg-[var(--surface-inset)] px-3 py-2 text-left transition-colors hover:border-[var(--border-strong)]"
              >
                <p className="text-xs font-medium">{variation.label}</p>
                <p className="mt-0.5 text-[10px] text-[var(--text-muted)] tabular-nums">
                  {humanDuration(variation.range.end - variation.range.start)} ·{' '}
                  {Math.round(variation.score * 100)}% match
                </p>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-2 rounded-full', className)} aria-hidden />
      {label}
    </span>
  );
}
