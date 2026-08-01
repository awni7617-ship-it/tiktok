'use client';

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Trash2 } from 'lucide-react';
import { send, useData } from '@/components/use-data';
import { Button, Card, Empty, Field, StatusBadge, inputClass } from '@/components/ui';
import { VideoRow } from '@/components/video-row';
import { CADENCES, artStyle, niche, voice } from '@/lib/catalog';
import { relativeTime } from '@/lib/format';
import type { Channel, Video } from '@/lib/types';

export default function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const channel = useData<{ channel: Channel }>(`/api/channels/${id}`, 0);
  const videos = useData<{ videos: Video[] }>(`/api/videos?channelId=${id}`);

  const [idea, setIdea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = channel.data?.channel;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      await send(`/api/channels/${id}/generate`, 'POST', { idea: idea.trim() || null });
      setIdea('');
      await videos.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue the video');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    if (!current) return;
    try {
      await send(`/api/channels/${id}`, 'PATCH', { active: !current.active });
      await channel.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the channel');
    }
  }

  async function remove() {
    if (!confirm('Delete this channel? Videos it already made are kept.')) return;
    try {
      await send(`/api/channels/${id}`, 'DELETE');
      router.push('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete the channel');
    }
  }

  if (channel.error) {
    return <Card className="border-rose-500/40 text-sm text-rose-400">{channel.error}</Card>;
  }
  if (!current) {
    return <p className="text-sm text-muted">Loading…</p>;
  }

  const mine = videos.data?.videos ?? [];
  const upcoming = mine
    .filter((v) => v.publishedAt === null && v.scheduledFor !== null)
    .sort((a, b) => (a.scheduledFor! < b.scheduledFor! ? -1 : 1));
  const rest = mine.filter((v) => !upcoming.includes(v));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{current.name}</h1>
          <p className="mt-1 text-sm text-muted">
            {niche(current.nicheId)?.name} · {artStyle(current.styleId)?.name} ·{' '}
            {voice(current.voiceId)?.name} ·{' '}
            {CADENCES.find((c) => c.id === current.cadence)?.name}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={toggleActive}>{current.active ? 'Pause' : 'Resume'}</Button>
          <Button variant="danger" onClick={remove}>
            <Trash2 size={15} aria-hidden />
            Delete
          </Button>
        </div>
      </div>

      <Card className="space-y-4">
        <Field
          label="Make one now"
          hint="Leave blank and the channel's niche picks the topic."
        >
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder="Optional: describe the video you want"
              maxLength={300}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void generate();
              }}
            />
            <Button variant="primary" onClick={generate} disabled={busy} className="shrink-0">
              <Sparkles size={15} aria-hidden />
              {busy ? 'Queuing…' : 'Generate'}
            </Button>
          </div>
        </Field>
        {error && <p className="text-sm text-rose-400">{error}</p>}
      </Card>

      {upcoming.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-muted">Scheduled</h2>
          <div className="space-y-2">
            {upcoming.map((video) => (
              <Card key={video.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{video.title}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {video.scheduledFor ? `Posts ${relativeTime(video.scheduledFor)}` : 'Unscheduled'}
                  </p>
                </div>
                <StatusBadge status={video.status} />
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Videos</h2>
        {rest.length === 0 ? (
          <Empty title="Nothing rendered yet">
            {current.active
              ? 'Autopilot queues the next one on schedule, or press Generate to make one now.'
              : 'This channel is paused. Resume it, or press Generate to make one now.'}
          </Empty>
        ) : (
          <div className="space-y-2">
            {rest.map((video) => (
              <VideoRow key={video.id} video={video} onChange={videos.reload} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
