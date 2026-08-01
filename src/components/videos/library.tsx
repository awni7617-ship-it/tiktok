'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Film, Loader2, Trash2 } from 'lucide-react';
import { Button, Card, Notice, SectionHeading } from '@/components/ui/primitives';
import { humanDuration } from '@/lib/time';

/**
 * Everything you have made.
 *
 * Videos are read from disk rather than a database, so they survive restarts
 * with nothing to install — which is the point of an app that has to work on
 * a laptop with no setup.
 */

interface Video {
  id: string;
  title: string;
  createdAt: string;
  durationSec: number;
  sceneCount: number;
  bytes: number;
  prompt: string;
  url: string;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

export function VideoLibrary() {
  const [videos, setVideos] = useState<Video[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/videos', { cache: 'no-store' });
      const payload = (await response.json()) as { videos?: Video[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Could not load your videos');
      setVideos(payload.videos ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your videos');
      setVideos([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (id: string) => {
    // Optimistic: the file goes either way, and a list that lags behind the
    // click reads as broken.
    setVideos((current) => current?.filter((video) => video.id !== id) ?? null);
    if (playing === id) setPlaying(null);
    await fetch(`/api/videos/${id}`, { method: 'DELETE' }).catch(() => undefined);
  };

  if (videos === null) {
    return (
      <Card className="grid min-h-64 place-items-center">
        <Loader2 className="size-5 animate-spin text-[var(--text-muted)]" />
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Your videos</h1>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Everything you have made, saved on this computer.
        </p>
      </header>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {videos.length === 0 ? (
        <Card className="grid min-h-64 place-items-center text-center">
          <div className="max-w-sm space-y-3">
            <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-[var(--surface-hover)]">
              <Film className="size-5 text-[var(--text-muted)]" />
            </div>
            <h2 className="text-sm font-semibold">No videos yet</h2>
            <p className="text-sm text-[var(--text-muted)]">
              Describe an idea on the Make a video screen. Phantom writes it, narrates it,
              illustrates it and renders a finished vertical video.
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {videos.map((video) => (
            <Card key={video.id} className="space-y-4">
              <SectionHeading
                title={video.title}
                description={`${humanDuration(video.durationSec)} · ${video.sceneCount} scenes · ${megabytes(
                  video.bytes,
                )} · ${when(video.createdAt)}`}
              />

              {playing === video.id ? (
                <video
                  src={video.url}
                  controls
                  autoPlay
                  playsInline
                  className="mx-auto max-h-[70vh] rounded-xl border border-[var(--border-subtle)] bg-black"
                />
              ) : null}

              <div className="flex flex-wrap gap-2">
                {playing === video.id ? (
                  <Button variant="ghost" onClick={() => setPlaying(null)}>
                    Close
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => setPlaying(video.id)}>
                    Play
                  </Button>
                )}

                <a
                  href={`${video.url}?download`}
                  download
                  className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                >
                  <Download className="size-4" />
                  Save to computer
                </a>

                <Button
                  variant="ghost"
                  icon={<Trash2 className="size-4" />}
                  onClick={() => void remove(video.id)}
                >
                  Delete
                </Button>
              </div>

              {video.prompt ? (
                <p className="border-t border-[var(--border-subtle)] pt-3 text-sm text-[var(--text-muted)]">
                  From: “{video.prompt}”
                </p>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
