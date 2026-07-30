'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { DemoQueueItem } from '@/server/demo/data';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/primitives';

/**
 * Drag-and-drop week calendar.
 *
 * Uses the native HTML drag-and-drop API rather than a pointer-event library:
 * it comes with the accessibility affordances browsers already ship, and the
 * interaction here is simple enough that a custom implementation would be
 * strictly worse.
 *
 * Keyboard users get a per-post menu instead of dragging — drag-only
 * rescheduling would lock them out of the feature entirely.
 */

const STATUS_TONE = {
  scheduled: 'neutral',
  queued: 'accent',
  published: 'success',
  failed: 'danger',
  draft: 'neutral',
} as const;

function startOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

export function PlannerCalendar({ items }: { items: DemoQueueItem[] }) {
  const [posts, setPosts] = useState(items);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  const weekStart = startOfWeek(new Date());
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + index);
    return date;
  });

  const moveTo = (id: string, dayIndex: number) => {
    setPosts((current) =>
      current.map((post) => {
        if (post.id !== id || !post.scheduledFor) return post;

        const next = new Date(days[dayIndex]!);
        // Preserve the time of day; only the date changes.
        next.setHours(post.scheduledFor.getHours(), post.scheduledFor.getMinutes(), 0, 0);
        return { ...post, scheduledFor: next };
      }),
    );
  };

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {days.map((day, dayIndex) => {
        const dayPosts = posts.filter(
          (post) => post.scheduledFor && post.scheduledFor.toDateString() === day.toDateString(),
        );
        const isToday = day.toDateString() === new Date().toDateString();

        return (
          <div
            key={day.toISOString()}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTarget(dayIndex);
            }}
            onDragLeave={() => setDropTarget((current) => (current === dayIndex ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging) moveTo(dragging, dayIndex);
              setDragging(null);
              setDropTarget(null);
            }}
            className={cn(
              'min-h-40 rounded-xl border p-2 transition-colors',
              dropTarget === dayIndex
                ? 'border-[var(--accent)] bg-[color-mix(in_oklab,var(--accent)_8%,transparent)]'
                : 'border-[var(--border-subtle)]',
            )}
          >
            <div className="mb-2 flex items-baseline justify-between px-0.5">
              <span
                className={cn(
                  'text-xs font-medium',
                  isToday ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]',
                )}
              >
                {day.toLocaleDateString(undefined, { weekday: 'short' })}
              </span>
              <span className="text-xs tabular-nums text-[var(--text-muted)]">{day.getDate()}</span>
            </div>

            <ul className="space-y-1.5">
              {dayPosts.map((post) => (
                <li key={post.id}>
                  <div
                    draggable
                    onDragStart={() => setDragging(post.id)}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                    className={cn(
                      'cursor-grab rounded-lg border border-[var(--border-default)] bg-[var(--surface-inset)] p-2 transition-opacity active:cursor-grabbing',
                      dragging === post.id && 'opacity-40',
                    )}
                  >
                    <p className="line-clamp-2 text-xs font-medium leading-snug">{post.projectTitle}</p>
                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      <span className="text-[10px] tabular-nums text-[var(--text-muted)]">
                        {post.scheduledFor?.toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                      <Badge tone={STATUS_TONE[post.status]} className="px-1.5 py-0 text-[10px]">
                        {post.platform}
                      </Badge>
                    </div>

                    {/* Keyboard-accessible alternative to dragging. */}
                    <label className="sr-only" htmlFor={`move-${post.id}`}>
                      Move {post.projectTitle} to another day
                    </label>
                    <select
                      id={`move-${post.id}`}
                      className="sr-only focus:not-sr-only focus:mt-1.5 focus:block focus:w-full focus:rounded focus:border focus:border-[var(--border-default)] focus:bg-[var(--surface-base)] focus:p-1 focus:text-xs"
                      value={dayIndex}
                      onChange={(event) => moveTo(post.id, Number(event.target.value))}
                    >
                      {days.map((option, index) => (
                        <option key={index} value={index}>
                          {option.toLocaleDateString(undefined, { weekday: 'long' })}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              ))}
            </ul>

            <button
              className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--border-subtle)] py-1.5 text-[10px] text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)]"
              aria-label={`Schedule a post on ${day.toDateString()}`}
            >
              <Plus className="size-3" />
              Add
            </button>
          </div>
        );
      })}
    </div>
  );
}
