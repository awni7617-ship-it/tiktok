'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { send } from '@/components/use-data';
import { Button, Card, Field, inputClass } from '@/components/ui';
import { cn } from '@/lib/cn';
import { ART_STYLES, CADENCES, MUSIC_BEDS, NICHES, PLATFORMS, VOICES } from '@/lib/catalog';
import type { Cadence, Channel, PlatformId } from '@/lib/types';

/**
 * Channel setup.
 *
 * One page rather than a multi-step wizard: there are seven choices and every
 * one of them has a working default, so there is nothing to hide behind a
 * Next button.
 */
export default function NewChannelPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [nicheId, setNicheId] = useState(NICHES[0]!.id);
  const [styleId, setStyleId] = useState(ART_STYLES[0]!.id);
  const [voiceId, setVoiceId] = useState(VOICES[0]!.id);
  const [musicId, setMusicId] = useState<string | null>(MUSIC_BEDS[0]!.id);
  const [cadence, setCadence] = useState<Cadence>('three-per-week');
  const [platforms, setPlatforms] = useState<PlatformId[]>([]);
  const [targetSeconds, setTargetSeconds] = useState(45);
  const [hours, setHours] = useState<number[]>([9]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const perDay = cadence === 'twice-daily' ? 2 : 1;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { channel } = await send<{ channel: Channel }>('/api/channels', 'POST', {
        name: name.trim() || NICHES.find((n) => n.id === nicheId)?.name || 'Channel',
        nicheId,
        styleId,
        voiceId,
        musicId,
        cadence,
        postingHours: hours.slice(0, perDay),
        platforms,
        targetSeconds,
        active: true,
      });
      router.push(`/channels/${channel.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the channel');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New channel</h1>
        <p className="mt-1 text-sm text-muted">
          Every option has a default that works. You can change all of it later.
        </p>
      </div>

      <Card className="space-y-5">
        <Field label="Name" hint="Only you see this.">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={NICHES.find((n) => n.id === nicheId)?.name ?? 'My channel'}
            maxLength={60}
          />
        </Field>

        <Field label="Niche" hint="Steers what the script model writes about.">
          <div className="grid gap-2 sm:grid-cols-2">
            {NICHES.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setNicheId(n.id)}
                aria-pressed={nicheId === n.id}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  nicheId === n.id ? 'border-brand-500 bg-brand-500/10' : 'border-app surface-hover',
                )}
              >
                <span className="block text-sm font-medium">{n.name}</span>
                <span className="mt-0.5 block text-xs text-muted">{n.blurb}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Art style" hint="Appended to every image prompt.">
          <div className="flex flex-wrap gap-2">
            {ART_STYLES.map((style) => (
              <button
                key={style.id}
                type="button"
                onClick={() => setStyleId(style.id)}
                aria-pressed={styleId === style.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
                  styleId === style.id ? 'border-brand-500 bg-brand-500/10' : 'border-app surface-hover',
                )}
              >
                <span
                  aria-hidden
                  className="size-4 rounded-full border border-app"
                  style={{
                    background: `linear-gradient(135deg, ${style.gradient[0]}, ${style.gradient[1]})`,
                  }}
                />
                {style.name}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Voice">
            <select className={inputClass} value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {v.blurb}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Music bed">
            <select
              className={inputClass}
              value={musicId ?? ''}
              onChange={(e) => setMusicId(e.target.value || null)}
            >
              <option value="">No music</option>
              {MUSIC_BEDS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.blurb}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Cadence">
            <select
              className={inputClass}
              value={cadence}
              onChange={(e) => {
                const next = e.target.value as Cadence;
                setCadence(next);
                setHours(next === 'twice-daily' ? [9, 18] : [9]);
              }}
            >
              {CADENCES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.blurb}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Length" hint={`About ${targetSeconds} seconds per video.`}>
            <input
              type="range"
              min={15}
              max={120}
              step={5}
              value={targetSeconds}
              onChange={(e) => setTargetSeconds(Number(e.target.value))}
              className="w-full accent-[var(--color-brand-500)]"
            />
          </Field>
        </div>

        {cadence !== 'manual' && (
          <Field label="Posting time" hint="In this machine's local time.">
            <div className="flex gap-2">
              {Array.from({ length: perDay }, (_, index) => (
                <select
                  key={index}
                  className={inputClass}
                  value={hours[index] ?? 9}
                  onChange={(e) => {
                    const next = [...hours];
                    next[index] = Number(e.target.value);
                    setHours(next);
                  }}
                >
                  {Array.from({ length: 24 }, (_, hour) => (
                    <option key={hour} value={hour}>
                      {String(hour).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              ))}
            </div>
          </Field>
        )}

        <Field
          label="Post to"
          hint="Leave all off to keep videos local. Connect accounts in Settings first."
        >
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((platform) => {
              const on = platforms.includes(platform.id);
              return (
                <button
                  key={platform.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setPlatforms((current) =>
                      on ? current.filter((p) => p !== platform.id) : [...current, platform.id],
                    )
                  }
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm transition-colors',
                    on ? 'border-brand-500 bg-brand-500/10' : 'border-app surface-hover',
                  )}
                >
                  {platform.name}
                </button>
              );
            })}
          </div>
        </Field>
      </Card>

      {error && <p className="text-sm text-rose-400">{error}</p>}

      <div className="flex gap-3">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Creating…' : 'Create channel'}
        </Button>
        <Button type="button" onClick={() => router.push('/')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
