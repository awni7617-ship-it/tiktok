'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch-and-poll.
 *
 * The worker changes state in another process, so the UI cannot know when a
 * render finishes — it has to look. Polling stops while the tab is hidden,
 * which is most of the time a render is running.
 */
export function useData<T>(url: string, intervalMs = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Kept in a ref so the polling effect does not restart on every render.
  const target = useRef(url);
  target.current = url;

  const load = useCallback(async () => {
    try {
      const response = await fetch(target.current);
      const body = (await response.json()) as T & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
      setData(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    if (intervalMs <= 0) return;

    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, intervalMs);

    return () => clearInterval(timer);
  }, [load, intervalMs]);

  return { data, error, loading, reload: load };
}

/** POST/PATCH/DELETE with the same error shape as `useData`. */
export async function send<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  payload?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}
