'use client';

import { useState } from 'react';
import { useData } from '@/components/use-data';
import { Card, Empty } from '@/components/ui';
import { VideoRow } from '@/components/video-row';
import { cn } from '@/lib/cn';
import type { Video } from '@/lib/types';

interface Response {
  videos: Video[];
  channels: { id: string; name: string }[];
}

export default function VideosPage() {
  const { data, error, loading, reload } = useData<Response>('/api/videos');
  const [filter, setFilter] = useState<string>('all');

  const videos = data?.videos ?? [];
  const channels = data?.channels ?? [];
  const shown = filter === 'all' ? videos : videos.filter((v) => v.channelId === filter);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Videos</h1>
        <p className="mt-1 text-sm text-muted">
          Everything made, on this machine. Nothing is uploaded anywhere you did not connect.
        </p>
      </div>

      {error && <Card className="border-rose-500/40 text-sm text-rose-400">{error}</Card>}

      {channels.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {[{ id: 'all', name: 'All' }, ...channels].map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => setFilter(channel.id)}
              aria-pressed={filter === channel.id}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-sm transition-colors',
                filter === channel.id ? 'border-brand-500 bg-brand-500/10' : 'border-app surface-hover',
              )}
            >
              {channel.name}
            </button>
          ))}
        </div>
      )}

      {!loading && shown.length === 0 ? (
        <Empty title="No videos yet">
          Create a channel and either wait for its schedule or press Generate.
        </Empty>
      ) : (
        <div className="space-y-2">
          {shown.map((video) => (
            <VideoRow key={video.id} video={video} onChange={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
