'use client';

import { useState } from 'react';
import { Download, Send, Trash2 } from 'lucide-react';
import { Button, Card, StatusBadge } from '@/components/ui';
import { send } from '@/components/use-data';
import { duration, relativeTime } from '@/lib/format';
import { PLATFORMS } from '@/lib/catalog';
import type { Video } from '@/lib/types';

/** One row in the library: preview, state, and the three things you can do. */
export function VideoRow({ video, onChange }: { video: Video; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playable = video.file !== null && (video.status === 'ready' || video.status === 'published');

  async function act(action: 'publish' | 'delete') {
    if (action === 'delete' && !confirm('Delete this video and its files?')) return;
    setBusy(true);
    setError(null);
    try {
      if (action === 'publish') await send(`/api/videos/${video.id}/publish`, 'POST');
      else await send(`/api/videos/${video.id}`, 'DELETE');
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 py-4">
      <div className="flex items-start justify-between gap-4">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => playable && setOpen((v) => !v)}
        >
          <p className="truncate text-sm font-medium">{video.title}</p>
          <p className="mt-0.5 text-xs text-muted">
            {relativeTime(video.createdAt)}
            {video.durationSeconds !== null && ` · ${duration(video.durationSeconds)}`}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={video.status} />
        </div>
      </div>

      {video.error && <p className="text-xs text-rose-400">{video.error}</p>}

      {video.posts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {video.posts.map((post) => {
            const name = PLATFORMS.find((p) => p.id === post.platform)?.name ?? post.platform;
            return (
              <span
                key={post.platform}
                title={post.error ?? undefined}
                className={
                  post.status === 'posted'
                    ? 'rounded-full bg-mint-500/15 px-2 py-0.5 text-xs text-mint-400'
                    : post.status === 'failed'
                      ? 'rounded-full bg-rose-500/15 px-2 py-0.5 text-xs text-rose-400'
                      : 'rounded-full bg-white/5 px-2 py-0.5 text-xs text-faint'
                }
              >
                {post.url ? (
                  <a href={post.url} target="_blank" rel="noreferrer">
                    {name} ↗
                  </a>
                ) : (
                  `${name} · ${post.status}`
                )}
              </span>
            );
          })}
        </div>
      )}

      {open && playable && (
        <video
          controls
          preload="metadata"
          className="w-full max-w-[280px] rounded-lg border border-app"
          src={`/api/videos/${video.id}/file`}
        />
      )}

      <div className="flex flex-wrap gap-2">
        {playable && (
          <a href={`/api/videos/${video.id}/file`} download>
            <Button size="sm">
              <Download size={14} aria-hidden />
              Download
            </Button>
          </a>
        )}
        {playable && video.posts.length > 0 && (
          <Button size="sm" onClick={() => act('publish')} disabled={busy}>
            <Send size={14} aria-hidden />
            {video.status === 'published' ? 'Post again' : 'Post now'}
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => act('delete')} disabled={busy}>
          <Trash2 size={14} aria-hidden />
          Delete
        </Button>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}
    </Card>
  );
}
