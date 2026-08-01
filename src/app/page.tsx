'use client';

import Link from 'next/link';
import { Plus, Radio } from 'lucide-react';
import { useData } from '@/components/use-data';
import { Button, Card, Empty } from '@/components/ui';
import { CADENCES, niche } from '@/lib/catalog';
import { relativeTime } from '@/lib/format';
import type { Channel, Video } from '@/lib/types';

interface ChannelsResponse {
  channels: Channel[];
}
interface VideosResponse {
  videos: Video[];
}

export default function ChannelsPage() {
  const channels = useData<ChannelsResponse>('/api/channels');
  const videos = useData<VideosResponse>('/api/videos');

  const all = channels.data?.channels ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Channels</h1>
          <p className="mt-1 text-sm text-muted">
            A channel is a niche, a look and a posting schedule. Autopilot keeps it fed.
          </p>
        </div>
        <Link href="/channels/new">
          <Button variant="primary">
            <Plus size={16} aria-hidden />
            New channel
          </Button>
        </Link>
      </div>

      {channels.error && (
        <Card className="border-rose-500/40 text-sm text-rose-400">{channels.error}</Card>
      )}

      {!channels.loading && all.length === 0 && (
        <Empty title="No channels yet">
          Create one and Autoreel starts writing, narrating, illustrating and rendering on the
          schedule you pick.
        </Empty>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {all.map((channel) => {
          const mine = (videos.data?.videos ?? []).filter((v) => v.channelId === channel.id);
          const upcoming = mine
            .filter((v) => v.publishedAt === null && v.scheduledFor !== null)
            .sort((a, b) => (a.scheduledFor! < b.scheduledFor! ? -1 : 1))[0];
          const published = mine.filter((v) => v.publishedAt !== null).length;
          const cadence = CADENCES.find((c) => c.id === channel.cadence);

          return (
            <Link key={channel.id} href={`/channels/${channel.id}`} className="block">
              <Card className="h-full transition-colors surface-hover">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium">{channel.name}</h2>
                    <p className="mt-0.5 truncate text-sm text-muted">
                      {niche(channel.nicheId)?.name ?? channel.nicheId}
                    </p>
                  </div>
                  <span
                    className={
                      channel.active
                        ? 'inline-flex items-center gap-1.5 rounded-full bg-mint-500/15 px-2.5 py-1 text-xs font-medium text-mint-400'
                        : 'rounded-full bg-white/5 px-2.5 py-1 text-xs font-medium text-faint'
                    }
                  >
                    {channel.active && <Radio size={11} aria-hidden />}
                    {channel.active ? 'Live' : 'Paused'}
                  </span>
                </div>

                <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-faint">Cadence</dt>
                    <dd className="mt-0.5">{cadence?.name ?? channel.cadence}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-faint">Published</dt>
                    <dd className="mt-0.5">{published}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-faint">Next</dt>
                    <dd className="mt-0.5">
                      {upcoming?.scheduledFor ? relativeTime(upcoming.scheduledFor) : '—'}
                    </dd>
                  </div>
                </dl>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
